import { Hono } from "hono";
import { db, withTransaction, type Application, type Item, type Moveout, type Timeslot } from "../db.ts";
import { getApplication, getItem, getMoveout, getPendingReschedule, getReschedule, isClaimant, isCreator, isProposer } from "../ownership.ts";
import { notifyAccount, notifyDevice, notifyMoveout } from "../live.ts";
import { logEvent } from "../log.ts";
import { requireSignedIn } from "../session.ts";

export const rescheduleRoutes = new Hono();

function applicationContext(applicationId: string): { item: Item; moveout: Moveout } | null {
  const app = getApplication(applicationId);
  if (!app) return null;
  const item = getItem(app.item_id);
  if (!item) return null;
  const moveout = getMoveout(item.moveout_id);
  if (!moveout) return null;
  return { item, moveout };
}

// A reschedule concerns exactly two parties: the move-out's creator and this
// application's claimant. Nobody else may view, propose on, accept, decline,
// or withdraw anything about it — through the SAME shared isCreator/
// isClaimant predicates every other route in this app uses (not a local
// reimplementation, which is what let this file's own copy drift out of
// sync with ownership.ts's account-replaces-device rule before).
function roleOf(moveout: Moveout, app: Application, deviceId: string, accountId: string | undefined): "creator" | "claimant" | null {
  if (isCreator(moveout, deviceId, accountId)) return "creator";
  if (isClaimant(app, deviceId, accountId)) return "claimant";
  return null;
}

// A reschedule's outcome (accept, in particular) changes the confirmed
// pickup time shown on BOTH parties' own "My MoveOut" list, not just the
// moveout page itself — this notifies each party's account bus (when
// bound), alongside the existing per-device notifyDevice calls, same
// reasoning as every other write that affects what an account's home page
// shows (src/live.ts#notifyAccount).
function notifyPartyAccounts(app: Application, moveout: Moveout): void {
  if (app.claimer_account_id) notifyAccount(app.claimer_account_id);
  if (moveout.creator_account_id) notifyAccount(moveout.creator_account_id);
}

function validNewTimeslot(timeslot: Timeslot | undefined, moveout: Moveout, currentTimeslotId: string, now: string): string | null {
  if (!timeslot || timeslot.moveout_id !== moveout.id) return "That pickup time doesn't belong to this move-out page.";
  if (timeslot.id === currentTimeslotId) return "That's already the current pickup time.";
  if (timeslot.starts_at <= now) return "That pickup time has already started.";
  if (timeslot.ends_at > moveout.deadline_at) return "That pickup time ends after this move-out's deadline.";
  return null;
}

rescheduleRoutes.post("/applications/:id/reschedule", async (c) => {
  const applicationId = c.req.param("id");
  const ctx = applicationContext(applicationId);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(applicationId)!;
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  const role = roleOf(ctx.moveout, app, deviceId, c.get("account")?.id);
  if (!role) {
    logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId, status: 404, reasonCode: "not_party" });
    return c.notFound();
  }
  if (app.status !== "confirmed") {
    logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "invalid", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "not_confirmed" });
    return c.text("Only a confirmed booking can be rescheduled.", 409);
  }

  const form = await c.req.formData();
  const newTimeslotId = String(form.get("newTimeslotId") ?? "");
  const reason = String(form.get("reason") ?? "").trim().slice(0, 200) || null;
  const now = new Date().toISOString();
  const newTimeslot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(newTimeslotId) as Timeslot | undefined;
  const invalidReason = validNewTimeslot(newTimeslot, ctx.moveout, app.timeslot_id, now);
  if (invalidReason) {
    logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "invalid", moveoutId: ctx.moveout.id, applicationId, status: 400, reasonCode: "timeslot_invalid" });
    return c.text(invalidReason, 400);
  }

  // A stale pending proposal (its own proposed time has since passed) must
  // not block a genuinely new one — expiry invalidates it in place rather
  // than leaving the unique "one pending per application" index permanently
  // jammed on a proposal nobody can act on anymore.
  const existing = getPendingReschedule(applicationId);
  if (existing) {
    const existingSlot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(existing.new_timeslot_id) as Timeslot | undefined;
    if (existingSlot && existingSlot.starts_at > now) {
      logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "pending_exists" });
      return c.text("There's already a pending reschedule proposal for this booking — resolve it first.", 409);
    }
    db.prepare("UPDATE reschedule_proposals SET status = 'invalidated', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'").run(existing.id);
  }

  const accountId = c.get("account")?.id ?? null;
  const proposalId = crypto.randomUUID();
  try {
    db.prepare(
      `INSERT INTO reschedule_proposals (id, application_id, proposed_by_device_id, proposed_by_account_id, new_timeslot_id, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(proposalId, applicationId, deviceId, accountId, newTimeslot!.id, reason);
  } catch (err) {
    const isUniqueConstraint = err instanceof Error && "errcode" in err && (err as { errcode?: number }).errcode === 2067;
    if (!isUniqueConstraint) throw err;
    logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId, status: 409, reasonCode: "lost_race" });
    return c.text("Someone just proposed a reschedule for this booking — refresh and try again.", 409);
  }

  logEvent({ event: "reschedule.propose", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId, affectedDevice: app.claimer_device_id, timeslotId: newTimeslot!.id, reasonCode: role });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  if (role === "claimant") notifyDevice(ctx.moveout.creator_device_id);
  notifyPartyAccounts(app, ctx.moveout);
  return role === "creator" ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

rescheduleRoutes.post("/reschedule/:id/accept", (c) => {
  const proposalId = c.req.param("id");
  const proposal = getReschedule(proposalId);
  if (!proposal) return c.notFound();
  const ctx = applicationContext(proposal.application_id);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(proposal.application_id)!;
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "reschedule.accept", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  const role = roleOf(ctx.moveout, app, deviceId, c.get("account")?.id);
  if (!role) {
    logEvent({ event: "reschedule.accept", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 404, reasonCode: "not_party" });
    return c.notFound();
  }
  // The proposer can't accept their own proposal — acceptance is the OTHER
  // party's act, by definition.
  if (isProposer(proposal, deviceId, c.get("account")?.id)) {
    logEvent({ event: "reschedule.accept", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 403, reasonCode: "self_accept" });
    return c.text("You proposed this reschedule — the other party has to accept it.", 403);
  }

  const now = new Date().toISOString();
  class StaleAccept extends Error {
    reasonCode: string;
    message2: string;
    constructor(reasonCode: string, message2: string) {
      super(reasonCode);
      this.reasonCode = reasonCode;
      this.message2 = message2;
    }
  }
  let result: { ok: true } | { ok: false; reasonCode: string; message: string };
  try {
    result = withTransaction(() => {
      // Re-read inside the transaction boundary so every check (proposal
      // still pending, application still confirmed, new timeslot still
      // valid) is validated against current state, not a snapshot taken
      // before this handler started — the same "guard the live row, not a
      // read-then-check" discipline CLAUDE.md requires for every transition.
      const liveProposal = db.prepare("SELECT * FROM reschedule_proposals WHERE id = ?").get(proposalId) as unknown as typeof proposal;
      if (liveProposal.status !== "pending") throw new StaleAccept("already_resolved", "This proposal was already resolved.");
      const liveApp = getApplication(app.id)!;
      if (liveApp.status !== "confirmed") throw new StaleAccept("not_confirmed", "This booking is no longer confirmed.");
      const newSlot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(liveProposal.new_timeslot_id) as unknown as Timeslot;
      if (newSlot.starts_at <= now) throw new StaleAccept("timeslot_expired", "That proposed time has already passed — it can no longer be accepted.");

      const proposalUpdate = db
        .prepare("UPDATE reschedule_proposals SET status = 'accepted', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(proposalId);
      if (proposalUpdate.changes === 0) throw new StaleAccept("lost_race", "This proposal was just resolved.");
      const appUpdate = db
        .prepare(
          `UPDATE applications SET timeslot_id = ?, departure_status = 'not_departed'
           WHERE id = ? AND status = 'confirmed'`,
        )
        .run(liveProposal.new_timeslot_id, app.id);
      if (appUpdate.changes === 0) throw new StaleAccept("lost_race", "This booking changed while you were accepting — refresh and try again.");
      return { ok: true };
    });
  } catch (err) {
    if (!(err instanceof StaleAccept)) throw err;
    if (err.reasonCode === "timeslot_expired") {
      // Mark it invalidated outside the failed transaction so a later
      // propose isn't blocked by a permanently-stuck "pending" row — same
      // self-healing path as the propose route's own expiry check.
      db.prepare("UPDATE reschedule_proposals SET status = 'invalidated', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'").run(proposalId);
    }
    result = { ok: false, reasonCode: err.reasonCode, message: err.message2 };
  }

  if (!result.ok) {
    logEvent({ event: "reschedule.accept", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId: app.id, affectedDevice: app.claimer_device_id, status: 409, reasonCode: result.reasonCode });
    return c.text(result.message, 409);
  }
  logEvent({ event: "reschedule.accept", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId: app.id, affectedDevice: app.claimer_device_id });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  notifyDevice(ctx.moveout.creator_device_id);
  notifyPartyAccounts(app, ctx.moveout);
  return role === "creator" ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

rescheduleRoutes.post("/reschedule/:id/decline", (c) => {
  const proposalId = c.req.param("id");
  const proposal = getReschedule(proposalId);
  if (!proposal) return c.notFound();
  const ctx = applicationContext(proposal.application_id);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(proposal.application_id)!;
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "reschedule.decline", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  const role = roleOf(ctx.moveout, app, deviceId, c.get("account")?.id);
  if (!role) {
    logEvent({ event: "reschedule.decline", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 404, reasonCode: "not_party" });
    return c.notFound();
  }
  if (isProposer(proposal, deviceId, c.get("account")?.id)) {
    logEvent({ event: "reschedule.decline", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 403, reasonCode: "self_decline" });
    return c.text("You proposed this reschedule — withdraw it instead if you've changed your mind.", 403);
  }

  const result = db
    .prepare("UPDATE reschedule_proposals SET status = 'declined', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(proposalId);
  if (result.changes === 0) {
    logEvent({ event: "reschedule.decline", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId: app.id, status: 409, reasonCode: "already_resolved" });
    return c.text("This proposal was already resolved.", 409);
  }
  logEvent({ event: "reschedule.decline", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId: app.id, affectedDevice: app.claimer_device_id });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  notifyDevice(ctx.moveout.creator_device_id);
  notifyPartyAccounts(app, ctx.moveout);
  return role === "creator" ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

rescheduleRoutes.post("/reschedule/:id/withdraw", (c) => {
  const proposalId = c.req.param("id");
  const proposal = getReschedule(proposalId);
  if (!proposal) return c.notFound();
  const ctx = applicationContext(proposal.application_id);
  if (!ctx) return c.notFound();
  const deviceId = c.get("deviceId");
  const app = getApplication(proposal.application_id)!;
  const signinRedirect = requireSignedIn(c, `/m/${ctx.moveout.id}`);
  if (signinRedirect) {
    logEvent({ event: "reschedule.withdraw", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  if (!isProposer(proposal, deviceId, c.get("account")?.id)) {
    logEvent({ event: "reschedule.withdraw", actor: deviceId, outcome: "denied", moveoutId: ctx.moveout.id, applicationId: app.id, status: 404, reasonCode: "not_proposer" });
    return c.notFound();
  }

  const result = db
    .prepare("UPDATE reschedule_proposals SET status = 'withdrawn', resolved_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(proposalId);
  if (result.changes === 0) {
    logEvent({ event: "reschedule.withdraw", actor: deviceId, outcome: "conflict", moveoutId: ctx.moveout.id, applicationId: app.id, status: 409, reasonCode: "already_resolved" });
    return c.text("This proposal was already resolved.", 409);
  }
  const role = roleOf(ctx.moveout, app, deviceId, c.get("account")?.id);
  logEvent({ event: "reschedule.withdraw", actor: deviceId, outcome: "success", moveoutId: ctx.moveout.id, itemId: ctx.item.id, applicationId: app.id, affectedDevice: app.claimer_device_id });
  notifyMoveout(ctx.moveout.id);
  notifyDevice(app.claimer_device_id);
  notifyDevice(ctx.moveout.creator_device_id);
  notifyPartyAccounts(app, ctx.moveout);
  return role === "creator" ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});
