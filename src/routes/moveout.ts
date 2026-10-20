import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { db, isItemCategory, type Application, type Item, type Timeslot } from "../db.ts";
import { getMoveout, isCreator, listItems, listTimeslots } from "../ownership.ts";
import { newId } from "../ids.ts";
import { zonedDateTimeToUtc } from "../tz.ts";
import { saveUploadedPhoto, isUploadRejection } from "../uploads.ts";
import { notifyDevice, notifyMoveout, notifyPublicPool, onMoveoutChange, pumpSSE } from "../live.ts";
import { moveoutPublicView, moveoutNotFoundView } from "../views/moveout-public.ts";
import { moveoutManageView, type OpenItemEntry, type UpcomingEntry, type CompletedEntry } from "../views/moveout-manage.ts";
import { logEvent } from "../log.ts";

export const moveoutRoutes = new Hono();

function shareUrlFor(c: Context, moveoutId: string): string {
  return new URL(`/m/${moveoutId}`, c.req.url).toString();
}

moveoutRoutes.get("/m/:id", (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.html(moveoutNotFoundView(), 404);
  const deviceId = c.get("deviceId");
  if (isCreator(moveout, deviceId)) return c.redirect(`/m/${moveout.id}/manage`);

  const allItems = listItems(moveout.id);
  const items = allItems.filter((i) => i.status !== "withdrawn");
  const now = new Date().toISOString();
  const validSlots = listTimeslots(moveout.id).filter(
    (s) => s.starts_at > now && s.starts_at <= moveout.deadline_at,
  );

  const myApps = db
    .prepare(
      `SELECT a.* FROM applications a JOIN items i ON i.id = a.item_id
       WHERE i.moveout_id = ? AND a.claimer_device_id = ? ORDER BY a.created_at DESC`,
    )
    .all(moveout.id, deviceId) as unknown as Application[];
  // Resolved against the FULL item list, not the public (withdrawn-excluded)
  // one — a claimant's own application history (including "cancelled
  // because the item was withdrawn") should still show up for them even
  // after the item itself is gone from the public list.
  const itemById = new Map(allItems.map((i) => [i.id, i]));
  const myApplications = myApps
    .map((app) => ({ app, item: itemById.get(app.item_id) }))
    .filter((x): x is { app: Application; item: Item } => Boolean(x.item));
  const requestedItemIds = new Set(
    myApps.filter((a) => a.status === "pending" || a.status === "confirmed").map((a) => a.item_id),
  );

  return c.html(moveoutPublicView(moveout, items, validSlots, myApplications, requestedItemIds));
});

moveoutRoutes.get("/m/:id/manage", (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.html(moveoutNotFoundView(), 404);
  const deviceId = c.get("deviceId");
  if (!isCreator(moveout, deviceId)) return c.html(moveoutNotFoundView(), 403);

  const items = listItems(moveout.id);
  const timeslots = listTimeslots(moveout.id);
  const slotById = new Map(timeslots.map((s) => [s.id, s]));
  const now = new Date().toISOString();

  const openItems: OpenItemEntry[] = items
    .filter((i) => i.status === "open")
    .map((item) => {
      const pending = (
        db
          .prepare("SELECT * FROM applications WHERE item_id = ? AND status = 'pending' ORDER BY created_at")
          .all(item.id) as unknown as Application[]
      ).map((app) => {
        const timeslot = slotById.get(app.timeslot_id) as Timeslot;
        return { app, timeslot, timeslotHasPassed: timeslot.starts_at <= now };
      });
      return { item, pending };
    });

  const confirmed = db
    .prepare(
      `SELECT a.* FROM applications a JOIN items i ON i.id = a.item_id
       WHERE i.moveout_id = ? AND a.status = 'confirmed'`,
    )
    .all(moveout.id) as unknown as Application[];
  const itemById = new Map(items.map((i) => [i.id, i]));
  const upcoming: UpcomingEntry[] = confirmed
    .map((app) => {
      const item = itemById.get(app.item_id);
      const timeslot = slotById.get(app.timeslot_id);
      if (!item || !timeslot) return null;
      const waitlist = (
        db
          .prepare("SELECT * FROM applications WHERE item_id = ? AND status = 'pending' ORDER BY created_at")
          .all(item.id) as unknown as Application[]
      ).map((a) => {
        const slot = slotById.get(a.timeslot_id) as Timeslot;
        return { app: a, timeslot: slot, timeslotHasPassed: slot.starts_at <= now };
      });
      return { app, item, timeslot, waitlist };
    })
    .filter((x): x is UpcomingEntry => x !== null)
    .sort((a, b) => a.timeslot.starts_at.localeCompare(b.timeslot.starts_at));

  const completedApps = db
    .prepare(
      `SELECT a.* FROM applications a JOIN items i ON i.id = a.item_id
       WHERE i.moveout_id = ? AND a.status = 'completed' ORDER BY a.completed_at DESC`,
    )
    .all(moveout.id) as unknown as Application[];
  const completed: CompletedEntry[] = completedApps
    .map((app) => {
      const item = itemById.get(app.item_id);
      const timeslot = slotById.get(app.timeslot_id);
      if (!item || !timeslot) return null;
      return { app, item, timeslot };
    })
    .filter((x): x is CompletedEntry => x !== null);

  const withdrawnItems = items.filter((i) => i.status === "withdrawn");

  return c.html(
    moveoutManageView(moveout, shareUrlFor(c, moveout.id), {
      openItems,
      upcoming,
      completed,
      withdrawnItems,
      timeslots,
    }),
  );
});

moveoutRoutes.post("/m/:id/visibility", async (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.notFound();
  const deviceId = c.get("deviceId");
  if (!isCreator(moveout, deviceId)) {
    logEvent({ event: "moveout.visibility", actor: deviceId, outcome: "denied", moveoutId: moveout.id, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }
  const form = await c.req.formData();
  const next = String(form.get("visibility") ?? "");
  if (next !== "public" && next !== "unlisted") {
    logEvent({ event: "moveout.visibility", actor: deviceId, outcome: "invalid", moveoutId: moveout.id, status: 400, reasonCode: "bad_value" });
    return c.text('visibility must be "public" or "unlisted".', 400);
  }

  db.prepare("UPDATE moveouts SET visibility = ? WHERE id = ?").run(next, moveout.id);
  logEvent({ event: "moveout.visibility", actor: deviceId, outcome: "success", moveoutId: moveout.id, reasonCode: next });

  notifyMoveout(moveout.id);
  // Either direction can change what the pool shows: going public adds this
  // page's open items to it, going unlisted removes them — both need every
  // open browse tab to re-fetch, not just this page's own subscribers.
  notifyPublicPool();
  return c.redirect(`/m/${moveout.id}/manage`);
});

// Carries no data, just "something on this page changed" — any subscriber,
// public visitor or creator alike, re-fetches the page they already had
// permission to see, and that fetch re-runs the usual ownership checks. So
// this stream needs no permission check beyond "the page exists".
moveoutRoutes.get("/m/:id/events", (c) => {
  const moveoutId = c.req.param("id");
  if (!getMoveout(moveoutId)) return c.notFound();
  return streamSSE(c, (stream) => pumpSSE(stream, (notify) => onMoveoutChange(moveoutId, notify)));
});

moveoutRoutes.post("/m/:id/items", async (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.notFound();
  const deviceId = c.get("deviceId");
  if (!isCreator(moveout, deviceId)) {
    logEvent({ event: "item.add", actor: deviceId, outcome: "denied", moveoutId: moveout.id, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }

  const form = await c.req.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return c.text("Name is required.", 400);
  // Server-validated against the fixed set (src/db.ts#ITEM_CATEGORIES), not
  // trusted from the submitted <select> value — an unrecognised or missing
  // category falls back to "Other" rather than failing the whole submission,
  // same spirit as its migration default for pre-Crit-11 items.
  const rawCategory = String(form.get("category") ?? "");
  const category = isItemCategory(rawCategory) ? rawCategory : "Other";
  const conditionNotes = String(form.get("conditionNotes") ?? "").trim() || null;
  const additionalNotes = String(form.get("additionalNotes") ?? "").trim() || null;

  const photoResult = await saveUploadedPhoto(form.get("photo"));
  if (isUploadRejection(photoResult)) {
    return c.text(photoResult.error, 400);
  }

  const itemId = newId();
  db.prepare(
    `INSERT INTO items (id, moveout_id, name, category, photo_path, condition_notes, additional_notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(itemId, moveout.id, name, category, photoResult, conditionNotes, additionalNotes);
  logEvent({ event: "item.add", actor: deviceId, outcome: "success", moveoutId: moveout.id, itemId, reasonCode: category });

  notifyMoveout(moveout.id);
  if (moveout.visibility === "public") notifyPublicPool();
  return c.redirect(`/m/${moveout.id}/manage`);
});

moveoutRoutes.post("/m/:id/timeslots", async (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.notFound();
  const deviceId = c.get("deviceId");
  if (!isCreator(moveout, deviceId)) {
    logEvent({ event: "timeslot.add", actor: deviceId, outcome: "denied", moveoutId: moveout.id, status: 404, reasonCode: "not_creator" });
    return c.notFound();
  }

  const form = await c.req.formData();
  const startsAt = zonedDateTimeToUtc(String(form.get("startsAt") ?? ""), moveout.timezone);
  const endsAt = zonedDateTimeToUtc(String(form.get("endsAt") ?? ""), moveout.timezone);
  if (!startsAt || !endsAt) return c.text("Start and end times are required.", 400);
  if (endsAt.getTime() <= startsAt.getTime()) return c.text("The end time must be after the start time.", 400);
  if (startsAt.toISOString() > moveout.deadline_at) {
    return c.text("A pickup time can't be later than the deadline.", 400);
  }

  const timeslotId = newId();
  db.prepare("INSERT INTO timeslots (id, moveout_id, starts_at, ends_at) VALUES (?, ?, ?, ?)").run(
    timeslotId,
    moveout.id,
    startsAt.toISOString(),
    endsAt.toISOString(),
  );
  logEvent({ event: "timeslot.add", actor: deviceId, outcome: "success", moveoutId: moveout.id, timeslotId });

  notifyMoveout(moveout.id);
  return c.redirect(`/m/${moveout.id}/manage`);
});

moveoutRoutes.post("/m/:id/apply", async (c) => {
  const moveout = getMoveout(c.req.param("id"));
  if (!moveout) return c.notFound();
  const deviceId = c.get("deviceId");
  if (isCreator(moveout, deviceId)) {
    logEvent({ event: "application.apply", actor: deviceId, outcome: "denied", moveoutId: moveout.id, status: 400, reasonCode: "self_request" });
    return c.text("You can't request your own item.", 400);
  }

  const now = new Date().toISOString();
  if (now > moveout.deadline_at) {
    logEvent({ event: "application.apply", actor: deviceId, outcome: "invalid", moveoutId: moveout.id, status: 403, reasonCode: "deadline_passed" });
    return c.text("The deadline for this move-out has passed — new requests are closed.", 403);
  }

  const form = await c.req.formData();
  const itemId = String(form.get("itemId") ?? "");
  const timeslotId = String(form.get("timeslotId") ?? "");
  const nickname = String(form.get("nickname") ?? "").trim();
  const note = String(form.get("note") ?? "").trim() || null;
  if (!nickname) return c.text("Your name is required.", 400);

  const item = db.prepare("SELECT * FROM items WHERE id = ? AND moveout_id = ?").get(itemId, moveout.id) as
    | Item
    | undefined;
  if (!item || item.status !== "open") {
    logEvent({ event: "application.apply", actor: deviceId, outcome: "conflict", moveoutId: moveout.id, itemId, status: 409, reasonCode: "item_unavailable" });
    return c.text("This item isn't available to request right now.", 409);
  }
  const timeslot = db.prepare("SELECT * FROM timeslots WHERE id = ? AND moveout_id = ?").get(timeslotId, moveout.id) as
    | Timeslot
    | undefined;
  if (!timeslot || timeslot.starts_at <= now || timeslot.starts_at > moveout.deadline_at) {
    logEvent({ event: "application.apply", actor: deviceId, outcome: "invalid", moveoutId: moveout.id, itemId, status: 400, reasonCode: "timeslot_invalid" });
    return c.text("That pickup time isn't valid anymore — pick another.", 400);
  }

  const applicationId = newId();
  try {
    db.prepare(
      `INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(applicationId, item.id, timeslot.id, deviceId, nickname, note);
  } catch (err) {
    // Only the partial unique index (applications_one_active_per_device)
    // means "an active request from this device already exists for this
    // item" — any OTHER database error (disk full, a constraint we didn't
    // expect, node:sqlite internals) is a real server fault, and treating it
    // as a routine duplicate-request conflict would both mislead whoever's
    // reading the logs and hide an actual bug behind a 409 a person would
    // just shrug off. node:sqlite's SqliteError carries the SQLite result
    // code as `errcode` (2067 == SQLITE_CONSTRAINT_UNIQUE); matching on that,
    // not just "any thrown error", is what makes this distinction real.
    const isUniqueConstraint =
      err instanceof Error && "errcode" in err && (err as { errcode?: number }).errcode === 2067;
    if (!isUniqueConstraint) {
      logEvent({ event: "application.apply", actor: deviceId, outcome: "error", moveoutId: moveout.id, itemId, status: 500, reasonCode: "unexpected_db_error" });
      return c.text("Something went wrong on our end — please try again.", 500);
    }
    logEvent({ event: "application.apply", actor: deviceId, outcome: "conflict", moveoutId: moveout.id, itemId, status: 409, reasonCode: "duplicate_active_request" });
    return c.text("You already have a request in for this item.", 409);
  }
  logEvent({ event: "application.apply", actor: deviceId, outcome: "success", moveoutId: moveout.id, itemId, applicationId });

  notifyMoveout(moveout.id);
  notifyDevice(deviceId);
  // Applying for the last open slot on an item doesn't change items.status
  // (still 'open' until confirmed) — so the pool itself only changes once
  // this gets confirmed or the item's withdrawn, both handled where those
  // happen (src/routes/applications.ts, src/routes/items.ts).
  return c.redirect(`/m/${moveout.id}`);
});
