import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db.ts";
import { newMoveoutId } from "../ids.ts";
import { zonedDateTimeToUtc, isValidTimeZone } from "../tz.ts";
import { listApplicationsWithContext, listMoveoutsCreatedBy } from "../ownership.ts";
import { notifyDevice, onDeviceChange, pumpSSE } from "../live.ts";
import { mineView } from "../views/home.ts";
import { logEvent } from "../log.ts";

export const homeRoutes = new Hono();

// Device-scoped, not moveout-scoped: "My MoveOut"'s summary spans every
// move-out this browser has touched. `deviceId` comes from the cookie
// (src/session.ts), never from anything the client sends, so a visitor can
// only ever subscribe to their own updates.
homeRoutes.get("/events", (c) => {
  const deviceId = c.get("deviceId");
  return streamSSE(c, (stream) => pumpSSE(stream, (notify) => onDeviceChange(deviceId, notify)));
});

// Crit 11: "/" is now the public Browse pool (src/routes/browse.ts) — this
// is "My MoveOut", the creator/claimant management home from before, moved
// here so a returning user keeps a fixed place to find their own pages and
// requests regardless of what's trending in the public pool.
homeRoutes.get("/mine", (c) => {
  const deviceId = c.get("deviceId");
  const myMoveouts = listMoveoutsCreatedBy(deviceId);
  const myApplications = listApplicationsWithContext(deviceId);
  return c.html(mineView(myMoveouts, myApplications));
});

homeRoutes.post("/moveouts", async (c) => {
  const deviceId = c.get("deviceId");
  const form = await c.req.formData();
  const title = String(form.get("title") ?? "").trim();
  const area = String(form.get("area") ?? "").trim();
  const pickupLocation = String(form.get("pickupLocation") ?? "").trim();
  const nickname = String(form.get("nickname") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "").trim() || "Australia/Sydney";
  const deadlineRaw = String(form.get("deadline") ?? "").trim();
  // Server-validated against a fixed set, never trusted as free text — a
  // missing/unrecognised value defaults to the more private option rather
  // than silently going public (CLAUDE.md).
  const visibility = String(form.get("visibility") ?? "") === "public" ? "public" : "unlisted";

  if (!title || !area || !pickupLocation || !nickname || !deadlineRaw) {
    return c.html(
      mineView([], [], { error: "Every field is required to create a move-out page." }),
      400,
    );
  }
  if (!isValidTimeZone(timezone)) {
    return c.html(mineView([], [], { error: `"${timezone}" isn't a recognised timezone.` }), 400);
  }
  const deadlineAt = zonedDateTimeToUtc(deadlineRaw, timezone);
  if (!deadlineAt) {
    return c.html(mineView([], [], { error: "That deadline date/time isn't valid." }), 400);
  }

  const id = newMoveoutId();
  db.prepare(
    `INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, timezone, creator_device_id, creator_nickname, visibility)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, area, pickupLocation, deadlineAt.toISOString(), timezone, deviceId, nickname, visibility);
  logEvent({ event: "moveout.create", actor: deviceId, outcome: "success", moveoutId: id, reasonCode: visibility });

  // So another already-open tab on this same device ("My MoveOut"'s "Your
  // move-out pages" list) picks this up without a manual reload.
  notifyDevice(deviceId);
  return c.redirect(`/m/${id}/manage`);
});
