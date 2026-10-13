import { Hono } from "hono";
import { db, withTransaction, type Application } from "../db.ts";
import { getItem, getMoveout, isCreator } from "../ownership.ts";
import { notifyDevice, notifyMoveout } from "../live.ts";

export const itemRoutes = new Hono();

itemRoutes.post("/items/:id/withdraw", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const moveout = getMoveout(item.moveout_id)!;
  if (!isCreator(moveout, c.get("deviceId"))) return c.notFound();

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
    return c.text("Can't withdraw this — it already has a confirmed pickup.", 409);
  }
  notifyMoveout(moveout.id);
  for (const deviceId of cancelledDevices) notifyDevice(deviceId);
  return c.redirect(`/m/${moveout.id}/manage`);
});
