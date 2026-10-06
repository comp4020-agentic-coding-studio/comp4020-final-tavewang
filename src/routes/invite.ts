import { Hono } from "hono";
import { type Member } from "../db.ts";
import { findFridgeByInviteToken, getMember } from "../membership.ts";
import { newId } from "../ids.ts";
import { db } from "../db.ts";
import { inviteJoinView, inviteNotFoundView } from "../views/invite.ts";

export const inviteRoutes = new Hono();

inviteRoutes.get("/invite/:token", (c) => {
  const fridge = findFridgeByInviteToken(c.req.param("token"));
  if (!fridge) return c.html(inviteNotFoundView(), 404);
  const existing = getMember(fridge.id, c.get("deviceId"));
  if (existing) return c.redirect(`/f/${fridge.id}`);
  return c.html(inviteJoinView(fridge.name, fridge.invite_token));
});

inviteRoutes.post("/invite/:token/join", async (c) => {
  const token = c.req.param("token");
  const fridge = findFridgeByInviteToken(token);
  if (!fridge) return c.html(inviteNotFoundView(), 404);

  const deviceId = c.get("deviceId");
  const form = await c.req.formData();
  const nickname = String(form.get("nickname") ?? "").trim();
  if (!nickname) {
    return c.html(inviteJoinView(fridge.name, token, { error: "Enter a name housemates will recognise." }), 400);
  }

  const existing: Member | undefined = getMember(fridge.id, deviceId);
  if (!existing) {
    db.prepare("INSERT INTO members (id, fridge_id, device_id, nickname) VALUES (?, ?, ?, ?)").run(
      newId(),
      fridge.id,
      deviceId,
      nickname,
    );
  }
  return c.redirect(`/f/${fridge.id}`);
});
