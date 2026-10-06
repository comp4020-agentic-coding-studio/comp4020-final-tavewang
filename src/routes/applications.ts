import { Hono } from "hono";
import { db, withTransaction, type Item, type Moveout, type Timeslot } from "../db.ts";
import { getApplication, getItem, getMoveout, isCreator } from "../ownership.ts";

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
  const timeslot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(app.timeslot_id) as Timeslot | undefined;
  if (timeslot && timeslot.starts_at <= now) {
    return c.text("That applicant's pickup time has already passed — ask them to choose a new one first.", 409);
  }

  // Confirming is the one place two requests can race (two different pending
  // applications on the same item, both confirmed at once): both run this
  // same guarded item UPDATE, and only one can still find status = 'open'.
  const changed = withTransaction(() => {
    const itemResult = db
      .prepare("UPDATE items SET status = 'reserved' WHERE id = ? AND status = 'open'")
      .run(ctx.item.id);
    if (itemResult.changes === 0) return 0;
    return db
      .prepare("UPDATE applications SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(applicationId).changes;
  });

  if (changed === 0) {
    return c.text("This item was already reserved (maybe by another confirmation just now).", 409);
  }
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
  return isOwner && !isClaimant ? c.redirect(`/m/${ctx.moveout.id}/manage`) : c.redirect(`/m/${ctx.moveout.id}`);
});

applicationRoutes.post("/applications/:id/complete", (c) => {
  const applicationId = c.req.param("id");
  const ctx = context(applicationId);
  if (!ctx) return c.notFound();
  if (!isCreator(ctx.moveout, c.get("deviceId"))) return c.notFound();

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
  return c.redirect(`/m/${ctx.moveout.id}`);
});
