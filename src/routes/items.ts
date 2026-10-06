import { Hono, type Context } from "hono";
import { db, type Item, type Member } from "../db.ts";
import { getFridge, getMember } from "../membership.ts";
import { newId } from "../ids.ts";

export const itemRoutes = new Hono();

function getItem(id: string): Item | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item | undefined;
}

// Every mutation below resolves the fridge from the ITEM, then checks the
// requester is a member of that fridge — never the reverse — so an id from
// one fridge can't be used to reach into another (fridge isolation).
function requireMembership(c: Context, item: Item): Member | undefined {
  return getMember(item.fridge_id, c.get("deviceId"));
}

itemRoutes.post("/f/:id/items", async (c) => {
  const fridge = getFridge(c.req.param("id"));
  if (!fridge) return c.notFound();
  const member = getMember(fridge.id, c.get("deviceId"));
  if (!member) return c.text("Not a member of this fridge.", 403);

  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return c.text("Name is required.", 400);
  const quantity = String(form.get("quantity") ?? "").trim() || null;
  const useBy = String(form.get("useBy") ?? "").trim() || null;
  const shared = form.get("shared") ? 1 : 0;

  db.prepare(
    `INSERT INTO items (id, fridge_id, name, quantity, use_by, owner_member_id, shared)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(newId(), fridge.id, name, quantity, useBy, member.id, shared);

  return c.redirect(`/f/${fridge.id}`);
});

itemRoutes.post("/items/:id/share", async (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const member = requireMembership(c, item);
  if (!member) return c.notFound();

  const form = await c.req.formData();
  const shared = form.get("shared") === "1" ? 1 : 0;

  // Owner-only, and only while nobody has claimed it yet — once claimed the
  // owner can't silently pull sharing out from under the claimant.
  const result = db
    .prepare("UPDATE items SET shared = ? WHERE id = ? AND owner_member_id = ? AND status = 'kept'")
    .run(shared, item.id, member.id);
  if (result.changes === 0) {
    return c.text("Can't change sharing right now — it may already be claimed.", 409);
  }
  return c.redirect(`/f/${item.fridge_id}`);
});

itemRoutes.post("/items/:id/edit", async (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const member = requireMembership(c, item);
  if (!member) return c.notFound();

  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return c.text("Name is required.", 400);
  const quantity = String(form.get("quantity") ?? "").trim() || null;
  const useBy = String(form.get("useBy") ?? "").trim() || null;

  const result = db
    .prepare(
      "UPDATE items SET name = ?, quantity = ?, use_by = ? WHERE id = ? AND owner_member_id = ? AND status = 'kept'",
    )
    .run(name, quantity, useBy, item.id, member.id);
  if (result.changes === 0) {
    return c.text("Can't edit this right now — it may already be claimed.", 409);
  }
  return c.redirect(`/f/${item.fridge_id}`);
});

itemRoutes.post("/items/:id/claim", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const member = requireMembership(c, item);
  if (!member) return c.notFound();
  if (item.owner_member_id === member.id) return c.text("You already own this item.", 400);

  // The single guarded UPDATE is the whole concurrency story: two claims
  // racing each other both run this statement, but only one can match
  // status = 'kept' before the other's write lands, so exactly one succeeds.
  const result = db
    .prepare(
      `UPDATE items SET status = 'claimed', claimed_by_member_id = ?, claimed_at = datetime('now')
       WHERE id = ? AND status = 'kept' AND shared = 1`,
    )
    .run(member.id, item.id);
  if (result.changes === 0) {
    return c.text("Someone already claimed this (or it's no longer shareable).", 409);
  }
  return c.redirect(`/f/${item.fridge_id}`);
});

itemRoutes.post("/items/:id/unclaim", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const member = requireMembership(c, item);
  if (!member) return c.notFound();

  const result = db
    .prepare(
      `UPDATE items SET status = 'kept', claimed_by_member_id = NULL, claimed_at = NULL
       WHERE id = ? AND status = 'claimed' AND claimed_by_member_id = ?`,
    )
    .run(item.id, member.id);
  if (result.changes === 0) {
    return c.text("Only the person who claimed it can give it back.", 403);
  }
  return c.redirect(`/f/${item.fridge_id}`);
});

itemRoutes.post("/items/:id/use", (c) => {
  const item = getItem(c.req.param("id"));
  if (!item) return c.notFound();
  const member = requireMembership(c, item);
  if (!member) return c.notFound();

  // The claimant can use what they claimed; the owner can use their own
  // item only while nobody else has claimed it.
  const result = db
    .prepare(
      `UPDATE items SET status = 'used', used_by_member_id = ?, used_at = datetime('now')
       WHERE id = ? AND (
         (status = 'claimed' AND claimed_by_member_id = ?)
         OR (status = 'kept' AND owner_member_id = ?)
       )`,
    )
    .run(member.id, item.id, member.id, member.id);
  if (result.changes === 0) {
    return c.text("Can't mark this used from here.", 409);
  }
  return c.redirect(`/f/${item.fridge_id}`);
});
