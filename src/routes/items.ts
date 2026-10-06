import { Hono } from "hono";
import { db, withTransaction } from "../db.ts";
import { getItem, getMoveout, isCreator } from "../ownership.ts";

export const itemRoutes = new Hono();

itemRoutes.post("/items/:id/withdraw", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const moveout = getMoveout(item.moveout_id)!;
  if (!isCreator(moveout, c.get("deviceId"))) return c.notFound();

  const changed = withTransaction(() => {
    // Guarded: only an item that's still 'open' can be withdrawn — one with
    // an active reservation must be unclaimed first (CLAUDE.md).
    const result = db.prepare("UPDATE items SET status = 'withdrawn' WHERE id = ? AND status = 'open'").run(item.id);
    if (result.changes > 0) {
      // Withdrawing removes the item from the running, so any outstanding
      // (pending) requests on it are cancelled along with it, not left
      // dangling as unreachable waitlist entries.
      db.prepare(
        `UPDATE applications SET status = 'cancelled', cancelled_at = datetime('now'), cancel_reason = 'Item withdrawn by the mover'
         WHERE item_id = ? AND status = 'pending'`,
      ).run(item.id);
    }
    return result.changes;
  });

  if (changed === 0) {
    return c.text("Can't withdraw this — it already has a confirmed pickup.", 409);
  }
  return c.redirect(`/m/${moveout.id}/manage`);
});
