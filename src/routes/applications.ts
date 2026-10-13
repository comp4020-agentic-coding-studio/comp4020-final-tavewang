import { Hono } from "hono";
import { db, withTransaction, type Item, type Moveout, type Timeslot } from "../db.ts";
import { getApplication, getItem, getMoveout, isCreator } from "../ownership.ts";
import { notifyDevice, notifyMoveout } from "../live.ts";

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
  if (!isCreator(ctx.moveout, c.get("deviceId"))) return c.notFound();

  const now = new Date().toISOString();
  if (now > ctx.moveout.deadline_at) {
    return c.text("The deadline has passed — new confirmations are closed.", 403);
  }

  const app = getApplication(applicationId)!;
  if (app.status !== "pending") {
    // Cheap early rejection for the common case (stale page, double click).
    // The transaction below still re-checks this atomically — this guard
    // only avoids needlessly flipping the item to 'reserved' and back when
    // we already know the application can't be confirmed.
    return c.text("This request is no longer pending — it was already settled.", 409);
  }
  const timeslot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(app.timeslot_id) as Timeslot | undefined;
  if (timeslot && timeslot.starts_at <= now) {
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
    return c.text("This item was already reserved, or this request was no longer pending (maybe settled just now).", 409);
  }
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  return c.redirect(`/m/${ctx.moveout.id}/manage`);
});

applicationRoutes.post("/applications/:id/cancel", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(applicationId)!;

  const isClaimant = app.claimer_device_id === deviceId;
  const isOwner = isCreator(ctx.moveout, deviceId);
  if (!isClaimant && !isOwner) return c.notFound();

  let reason: string | null = null;
  if (isOwner && !isClaimant) {
    // The creator can only cancel a CONFIRMED booking, and only with a
    // reason the claimant will see — a silent revocation isn't allowed.
    if (app.status !== "confirmed") {
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
    return result.changes;
  });

  if (changed === 0) {
    return c.text("This request was already settled (completed or already cancelled).", 409);
  }
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  return isOwner && !isClaimant ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

applicationRoutes.post("/applications/:id/complete", (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  if (!isCreator(ctx.moveout, c.get("deviceId"))) return c.notFound();
  const app = getApplication(applicationId)!;

  // No deadline gate here on purpose: recording what actually happened with
  // an existing confirmed booking stays allowed after the deadline passes.
  const changed = withTransaction(() => {
    const result = db
      .prepare("UPDATE applications SET status = 'completed', completed_at = datetime('now') WHERE id = ? AND status = 'confirmed'")
      .run(applicationId);
    if (result.changes > 0) {
      db.prepare("UPDATE items SET status = 'handed_over' WHERE id = ? AND status = 'reserved'").run(ctx.item.id);
    }
    return result.changes;
  });

  if (changed === 0) {
    return c.text("This booking isn't in a state that can be marked picked up.", 409);
  }
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  return c.redirect(`/m/${ctx.moveout.id}/manage`);
});

applicationRoutes.post("/applications/:id/timeslot", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  const app = getApplication(applicationId)!;
  if (app.claimer_device_id !== c.get("deviceId")) return c.notFound();
  if (app.status !== "pending") {
    return c.text("Only a still-pending request's timeslot can be changed.", 409);
  }

  const form = await c.req.formData();
  const timeslotId = String(form.get("timeslotId") ?? "");
  const now = new Date().toISOString();
  const timeslot = db
    .prepare("SELECT * FROM timeslots WHERE id = ? AND moveout_id = ?")
    .get(timeslotId, ctx.moveout.id) as Timeslot | undefined;
  if (!timeslot || timeslot.starts_at <= now || timeslot.starts_at > ctx.moveout.deadline_at) {
    return c.text("That pickup time isn't valid anymore — pick another.", 400);
  }

  db.prepare("UPDATE applications SET timeslot_id = ? WHERE id = ? AND status = 'pending'").run(timeslot.id, applicationId);
  notifyMoveout(ctx.moveout.id);
  return c.redirect(`/m/${ctx.moveout.id}`);
});
