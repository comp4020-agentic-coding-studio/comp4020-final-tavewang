import { Hono } from "hono";
import { db, withTransaction, type Application } from "../db.ts";
import { getItem, getMoveout, isCreator } from "../ownership.ts";
import { notifyDevice, notifyMoveout, notifyPublicPool } from "../live.ts";
import { logEvent } from "../log.ts";

export const itemRoutes = new Hono();

itemRoutes.post("/items/:id/withdraw", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const moveout = getMoveout(item.moveout_id)!;
  const deviceId = c.get("deviceId");
  if (!isCreator(moveout, deviceId)) {
    logEvent({ event: "item.withdraw", actor: deviceId, outcome: "denied", moveoutId: moveout.id, itemId: item.id, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }

  const { changed, cancelledDevices } = withTransaction(() => {
    // Guarded: only an item that's still 'open' can be withdrawn — one with
    // an active reservation must be unclaimed first (CLAUDE.md).
    const result = db.prepare("UPDATE items SET status = 'withdrawn' WHERE id = ? AND status = 'open'").run(item.id);
    if (result.changes === 0) return { changed: 0, cancelledDevices: [] as string[] };
    const pending = db
      .prepare("SELECT * FROM applications WHERE item_id = ? AND status = 'pending'")
      .all(item.id) as unknown as Application[];
    // Withdrawing removes the item from the running, so any outstanding
    // (pending) requests on it are cancelled along with it, not left
    // dangling as unreachable waitlist entries.
    db.prepare(
      `UPDATE applications SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = 'Item withdrawn by the mover'
       WHERE item_id = ? AND status = 'pending'`,
    ).run(item.id);
    return { changed: result.changes, cancelledDevices: pending.map((a) => a.claimer_device_id) };
  });

  if (changed === 0) {
    logEvent({ event: "item.withdraw", actor: deviceId, outcome: "conflict", moveoutId: moveout.id, itemId: item.id, status: 409, reasonCode: "item_reserved" });
    return c.text("Can't withdraw this — it already has a confirmed pickup.", 409);
  }
  logEvent({ event: "item.withdraw", actor: deviceId, outcome: "success", moveoutId: moveout.id, itemId: item.id });
  notifyMoveout(moveout.id);
  for (const cancelledDevice of cancelledDevices) notifyDevice(cancelledDevice);
  if (moveout.visibility === "public") notifyPublicPool();
  return c.redirect(`/m/${moveout.id}/manage`);
});
