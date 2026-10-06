import { Hono } from "hono";
import { db } from "../db.ts";
import { newMoveoutId } from "../ids.ts";
import { zonedDateTimeToUtc, isValidTimeZone } from "../tz.ts";
import { listApplicationsWithContext, listMoveoutsCreatedBy } from "../ownership.ts";
import { homeView } from "../views/home.ts";

export const homeRoutes = new Hono();

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

  return c.redirect(`/m/${id}/manage`);
});
