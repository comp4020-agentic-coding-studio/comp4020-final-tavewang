import { Hono } from "hono";
import { db, type Fridge } from "../db.ts";
import { newFridgeId, newId, newInviteToken } from "../ids.ts";
import { homeView } from "../views/home.ts";

export const homeRoutes = new Hono();

homeRoutes.get("/", (c) => {
  const deviceId = c.get("deviceId");
  const rows = db
    .prepare(
      `SELECT f.*, m.nickname AS nickname FROM members m
       JOIN fridges f ON f.id = m.fridge_id
       WHERE m.device_id = ?
       ORDER BY m.created_at`,
    )
    .all(deviceId) as unknown as (Fridge & { nickname: string })[];
  const memberships = rows.map((row) => ({ fridge: row, nickname: row.nickname }));
  return c.html(homeView(memberships));
});

homeRoutes.post("/fridges", async (c) => {
  const deviceId = c.get("deviceId");
  const form = await c.req.formData();
  const fridgeName = String(form.get("fridgeName") ?? "").trim();
  const nickname = String(form.get("nickname") ?? "").trim();
  if (!fridgeName || !nickname) {
    return c.html(homeView([], { error: "Fridge name and your name are both required." }), 400);
  }
  const fridgeId = newFridgeId();
  db.prepare("INSERT INTO fridges (id, name, invite_token) VALUES (?, ?, ?)").run(
    fridgeId,
    fridgeName,
    newInviteToken(),
  );
  db.prepare("INSERT INTO members (id, fridge_id, device_id, nickname) VALUES (?, ?, ?, ?)").run(
    newId(),
    fridgeId,
    deviceId,
    nickname,
  );
  return c.redirect(`/f/${fridgeId}`);
});

// Convenience for pasting a whole invite URL (not just clicking it) on the
// home page, per the brief's "clear create/join entry" requirement.
homeRoutes.get("/invite/go", (c) => {
  const raw = (c.req.query("inviteUrl") ?? "").trim();
  const match = raw.match(/\/invite\/([A-Za-z0-9_-]+)/);
  const token = match ? match[1] : raw;
  if (!token) return c.redirect("/");
  return c.redirect(`/invite/${encodeURIComponent(token)}`);
});
