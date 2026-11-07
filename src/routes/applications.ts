import { Hono } from "hono";
import { db, withTransaction, type DepartureStatus, type Item, type Moveout, type Timeslot } from "../db.ts";
import { getApplication, getItem, getMoveout, isClaimant, isCreator } from "../ownership.ts";
import { notifyAccount, notifyDevice, notifyMoveout, notifyPublicPool } from "../live.ts";
import { logEvent } from "../log.ts";
import { requireSignedIn } from "../session.ts";

const DEPARTURE_STATUSES: readonly DepartureStatus[] = ["not_departed", "departed", "arrived"];
function isDepartureStatus(value: string): value is DepartureStatus {
  return (DEPARTURE_STATUSES as readonly string[]).includes(value);
}

// Cancelling or completing a booking makes any still-pending reschedule
// proposal on it meaningless — there's no longer a confirmed timeslot left
// to move. Invalidate it rather than leave it sitting there as something an
// unrelated page refresh could still try to accept.
function invalidatePendingReschedule(applicationId: string): void {
  db.prepare(
    "UPDATE reschedule_proposals SET status = 'invalidated', resolved_at = datetime('now') WHERE application_id = ? AND status = 'pending'",
  ).run(applicationId);
}

export const applicationRoutes = new Hono();

function context(applicationId: string): { item: Item; moveout: Moveout } | null {
  const app = getApplication(applicationId);
  if (!app) return null;
  const item = getItem(app.item_id);
  if (!item) return null;
  const moveout = getMoveout(item.moveout_id);
  if (!moveout) return null;
  return { item, moveout };
}

applicationRoutes.post("/applications/:id/confirm", (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}/manage`);
  if (signinRedirect) {
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  if (!isCreator(ctx.moveout, deviceId, c.get("account")?.id)) {
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }

  const now = new Date().toISOString();
  if (now > ctx.moveout.deadline_at) {
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "invalid", moveoutId: ctx.moveout.id, applicationId, status: 403, reasonCode: "deadline_passed" });
    return c.text("The deadline has passed — new confirmations are closed.", 403);
  }

  const app = getApplication(applicationId)!;
  if (app.status !== "pending") {
    // Cheap early rejection for the common case (stale page, double click).
    // The transaction below still re-checks this atomically — this guard
    // only avoids needlessly flipping the item to 'reserved' and back when
    // we already know the application can't be confirmed.
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "not_pending" });
    return c.text("This request is no longer pending — it was already settled.", 409);
  }
  const timeslot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(app.timeslot_id) as Timeslot | undefined;
  if (timeslot && timeslot.starts_at <= now) {
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "timeslot_passed" });
    return c.text("That applicant's pickup time has already passed — ask them to choose a new one first.", 409);
  }

  // Confirming is the one place two requests can race (two different pending
  // applications on the same item, both confirmed at once): both run this
  // same guarded item UPDATE, and only one can still find status = 'open'.
  // Both of this transaction's updates are independently guarded by their
  // own WHERE clause, so either can fail on its own — if the application
  // update finds the row no longer 'pending' (cancelled or confirmed by
  // someone else between our check above and now), the item's own update
  // must not be left committed: throwing here (rather than returning 0)
  // is what makes db.ts's withTransaction roll the item back to 'open'
  // instead of silently leaving it 'reserved' with no confirmed application.
  class StaleConfirm extends Error {}
  let changed: number | bigint;
  try {
    changed = withTransaction(() => {
      const itemResult = db
        .prepare("UPDATE items SET status = 'reserved' WHERE id = ? AND status = 'open'")
        .run(ctx.item.id);
      if (itemResult.changes === 0) throw new StaleConfirm();
      const appResult = db
        .prepare("UPDATE applications SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(applicationId);
      if (appResult.changes === 0) throw new StaleConfirm();
      return appResult.changes;
    });
  } catch (err) {
    if (!(err instanceof StaleConfirm)) throw err;
    changed = 0;
  }

  if (changed === 0) {
    logEvent({ event: "application.confirm", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "lost_race" });
    return c.text("This item was already reserved, or this request was no longer pending (maybe settled just now).", 409);
  }
  logEvent({ event: "application.confirm", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId, affectedDevice: app.claimer_device_id });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  if (app.claimer_account_id) notifyAccount(app.claimer_account_id);
  // The item just left 'open' — if it was public, it must disappear from
  // every open browse tab, not just stop appearing on the next full reload.
  if (ctx.moveout.visibility === "public") notifyPublicPool();
  return c.redirect(`/m/${ctx.moveout.id}/manage`);
});

applicationRoutes.post("/applications/:id/cancel", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(applicationId)!;

  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "application.cancel", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  const accountId = c.get("account")?.id;
  const claimantMatch = isClaimant(app, deviceId, accountId);
  const isOwner = isCreator(ctx.moveout, deviceId, accountId);
  if (!claimantMatch && !isOwner) {
    logEvent({ event: "application.cancel", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 404, reasonCode: "not_claimant_or_owner" });
    return c.notFound();
  }

  let reason: string | null = null;
  if (isOwner && !claimantMatch) {
    // The creator can only cancel a CONFIRMED booking, and only with a
    // reason the claimant will see — a silent revocation isn't allowed.
    if (app.status !== "confirmed") {
      logEvent({ event: "application.cancel", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "not_confirmed" });
      return c.text("Only a confirmed booking can be cancelled this way.", 409);
    }
    const form = await c.req.formData();
    reason = String(form.get("reason") ?? "").trim();
    if (!reason) return c.text("A reason is required when the mover cancels a confirmed booking.", 400);
  }

  const changed = withTransaction(() => {
    const result = db
      .prepare(
        `UPDATE applications SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = ?
         WHERE id = ? AND status IN ('pending', 'confirmed')`,
      )
      .run(reason, applicationId);
    if (result.changes > 0 && app.status === "confirmed") {
      db.prepare("UPDATE items SET status = 'open' WHERE id = ? AND status = 'reserved'").run(ctx.item.id);
    }
    if (result.changes > 0) invalidatePendingReschedule(applicationId);
    return result.changes;
  });

  if (changed === 0) {
    logEvent({ event: "application.cancel", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "already_settled" });
    return c.text("This request was already settled (completed or already cancelled).", 409);
  }
  logEvent({
    event: "application.cancel",
    actor: deviceId,
    outcome: "success",
    moveoutId: ctx.moveout.id,
    itemId: ctx.item.id,
    applicationId,
    affectedDevice: app.claimer_device_id,
    reasonCode: isOwner && !claimantMatch ? "cancelled_by_creator" : "cancelled_by_claimant",
  });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  if (app.claimer_account_id) notifyAccount(app.claimer_account_id);
  // Cancelling a CONFIRMED booking reopens the item (CLAUDE.md) — it can
  // reappear in a public pool it had dropped out of.
  if (ctx.moveout.visibility === "public" && app.status === "confirmed") notifyPublicPool();
  return isOwner && !claimantMatch ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

applicationRoutes.post("/applications/:id/complete", (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}/manage`);
  if (signinRedirect) {
    logEvent({ event: "application.complete", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  if (!isCreator(ctx.moveout, deviceId, c.get("account")?.id)) {
    logEvent({ event: "application.complete", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }
  const app = getApplication(applicationId)!;

  // No deadline gate here on purpose: recording what actually happened with
  // an existing confirmed booking stays allowed after the deadline passes.
  const changed = withTransaction(() => {
    const result = db
      .prepare("UPDATE applications SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'confirmed'")
      .run(applicationId);
    if (result.changes > 0) {
      db.prepare("UPDATE items SET status = 'handed_over' WHERE id = ? AND status = 'reserved'").run(ctx.item.id);
      invalidatePendingReschedule(applicationId);
    }
    return result.changes;
  });

  if (changed === 0) {
    logEvent({ event: "application.complete", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, affectedDevice: app.claimer_device_id, status: 409, reasonCode: "not_confirmed" });
    return c.text("This booking isn't in a state that can be marked picked up.", 409);
  }
  logEvent({ event: "application.complete", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId, affectedDevice: app.claimer_device_id });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  if (app.claimer_account_id) notifyAccount(app.claimer_account_id);
  return c.redirect(`/m/${ctx.moveout.id}/manage`);
});

applicationRoutes.post("/applications/:id/departure", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(applicationId)!;
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "application.departure", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  if (!isClaimant(app, deviceId, c.get("account")?.id)) {
    logEvent({ event: "application.departure", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 404, reasonCode: "not_claimant" });
    return c.notFound();
  }

  const form = await c.req.formData();
  const next = String(form.get("status") ?? "");
  if (!isDepartureStatus(next)) {
    logEvent({ event: "application.departure", actor: deviceId, outcome: "invalid", moveoutId: ctx.moveout.id, applicationId, status: 400, reasonCode: "bad_value" });
    return c.text("That isn't a valid status.", 400);
  }

  // Only a confirmed booking has a pickup to travel toward — guarded the
  // same way as every other transition (WHERE on current state, not
  // read-then-check), and the claimant may move freely between the three
  // values (correcting a misclick), never a one-way ratchet.
  const result = db
    .prepare("UPDATE applications SET departure_status = ? WHERE id = ? AND status = 'confirmed'")
    .run(next, applicationId);
  if (result.changes === 0) {
    logEvent({ event: "application.departure", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "not_confirmed" });
    return c.text("This booking is no longer confirmed — its travel status can't be changed.", 409);
  }
  logEvent({ event: "application.departure", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId, reasonCode: next });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(deviceId);
  return c.redirect(`/m/${ctx.moveout.id}`);
});

applicationRoutes.post("/applications/:id/timeslot", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const app = getApplication(applicationId)!;
  const deviceId = c.get("deviceId");
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "application.timeslot", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  if (!isClaimant(app, deviceId, c.get("account")?.id)) {
    logEvent({ event: "application.timeslot", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 404, reasonCode: "not_claimant" });
    return c.notFound();
  }
  if (app.status !== "pending") {
    logEvent({ event: "application.timeslot", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "not_pending" });
    return c.text("Only a still-pending request's timeslot can be changed.", 409);
  }

  const form = await c.req.formData();
  const timeslotId = String(form.get("timeslotId") ?? "");
  const now = new Date().toISOString();
  const timeslot = db
    .prepare("SELECT * FROM timeslots WHERE id = ? AND moveout_id = ?")
    .get(timeslotId, ctx.moveout.id) as Timeslot | undefined;
  if (!timeslot || timeslot.starts_at <= now || timeslot.starts_at > ctx.moveout.deadline_at) {
    logEvent({ event: "application.timeslot", actor: deviceId, outcome: "invalid", moveoutId: ctx.moveout.id, applicationId, status: 400, reasonCode: "timeslot_invalid" });
    return c.text("That pickup time isn't valid anymore — pick another.", 400);
  }

  // Guarded the same way confirm/cancel/complete are (CLAUDE.md: "Confirming
  // is the one place two requests can race" generalises to every guarded
  // transition) — the status check above is a cheap early rejection for the
  // common case, but between that check and this UPDATE the application
  // could have just been confirmed by the creator (a race this route has no
  // lock against). Without checking `changes` here, that race silently did
  // nothing to the database while still returning 302 and logging "success"
  // — a real bug: the claimant would be told their new time was saved when
  // their application was actually already confirmed on the OLD one.
  const result = db
    .prepare("UPDATE applications SET timeslot_id = ? WHERE id = ? AND status = 'pending'")
    .run(timeslot.id, applicationId);
  if (result.changes === 0) {
    logEvent({ event: "application.timeslot", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "lost_race" });
    return c.text("This request was just settled — its timeslot can no longer be changed.", 409);
  }
  logEvent({ event: "application.timeslot", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId, timeslotId: timeslot.id });
  notifyMoveout(ctx.moveout.id);
  return c.redirect(`/m/${ctx.moveout.id}`);
});
