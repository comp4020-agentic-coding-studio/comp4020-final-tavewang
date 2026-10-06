import { Hono, type Context } from "hono";
import { db, type Item } from "../db.ts";
import { getFridge, getMember, membersById } from "../membership.ts";
import { fridgeView, notAMemberView } from "../views/fridge.ts";
import { historyView } from "../views/history.ts";

export const fridgeRoutes = new Hono();

function inviteUrlFor(c: Context, token: string): string {
  return new URL(`/invite/${token}`, c.req.url).toString();
}

fridgeRoutes.get("/f/:id", (c) => {
  const fridge = getFridge(c.req.param("id"));
  if (!fridge) return c.notFound();
  const member = getMember(fridge.id, c.get("deviceId"));
  if (!member) return c.html(notAMemberView(fridge), 403);

  const items = db
    .prepare(
      `SELECT * FROM items WHERE fridge_id = ? AND status != 'used'
       ORDER BY (use_by IS NULL), use_by ASC, created_at ASC`,
    )
    .all(fridge.id) as unknown as Item[];

  return c.html(fridgeView(fridge, member, items, membersById(fridge.id), inviteUrlFor(c, fridge.invite_token)));
});

fridgeRoutes.get("/f/:id/history", (c) => {
  const fridge = getFridge(c.req.param("id"));
  if (!fridge) return c.notFound();
  const member = getMember(fridge.id, c.get("deviceId"));
  if (!member) return c.html(notAMemberView(fridge), 403);

  const items = db
    .prepare(`SELECT * FROM items WHERE fridge_id = ? AND status = 'used' ORDER BY used_at DESC`)
    .all(fridge.id) as unknown as Item[];

  return c.html(historyView(fridge, items, membersById(fridge.id)));
});
