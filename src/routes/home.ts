import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db.ts";
import { newMoveoutId } from "../ids.ts";
import { zonedDateTimeToUtc, isValidTimeZone } from "../tz.ts";
import { listApplicationsWithContext, listMoveoutsCreatedBy } from "../ownership.ts";
import { notifyDevice, onDeviceChange, pumpSSE } from "../live.ts";
import { homeView } from "../views/home.ts";
import { logEvent } from "../log.ts";

export const homeRoutes = new Hono();

// Device-scoped, not moveout-scoped: the home page's "your requests" summary
// spans every move-out this browser has touched. `deviceId` comes from the
// cookie (src/session.ts), never from anything the client sends, so a
// visitor can only ever subscribe to their own updates.
homeRoutes.get("/events", (c) => {
  const deviceId = c.get("deviceId");
  return streamSSE(c, (stream) => pumpSSE(stream, (notify) => onDeviceChange(deviceId, notify)));
});

homeRoutes.get("/", (c) => {
  const deviceId = c.get("deviceId");
  const myMoveouts = listMoveoutsCreatedBy(deviceId);
  const myApplications = listApplicationsWithContext(deviceId);
  return c.html(homeView(myMoveouts, myApplications));
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

  if (!title || !area || !pickupLocation || !nickname || !deadlineRaw) {
    return c.html(
      homeView([], [], { error: "Every field is required to create a move-out page." }),
      400,
    );
  }
  if (!isValidTimeZone(timezone)) {
    return c.html(homeView([], [], { error: `"${timezone}" isn't a recognised timezone.` }), 400);
  }
  const deadlineAt = zonedDateTimeToUtc(deadlineRaw, timezone);
  if (!deadlineAt) {
    return c.html(homeView([], [], { error: "That deadline date/time isn't valid." }), 400);
  }

  const id = newMoveoutId();
  db.prepare(
    `INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, timezone, creator_device_id, creator_nickname)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, area, pickupLocation, deadlineAt.toISOString(), timezone, deviceId, nickname);
  logEvent({ event: "moveout.create", actor: deviceId, outcome: "success", moveoutId: id });

  // So another already-open tab on this same device (its home page's
  // "Your move-out pages" list) picks this up without a manual reload.
  notifyDevice(deviceId);
  return c.redirect(`/m/${id}/manage`);
});
