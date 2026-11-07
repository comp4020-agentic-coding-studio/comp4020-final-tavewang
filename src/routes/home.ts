import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db.ts";
import { newMoveoutId } from "../ids.ts";
import { zonedDateTimeToUtc, isValidTimeZone } from "../tz.ts";
import {
  listApplicationsWithContext,
  listApplicationsWithContextForAccount,
  listMoveoutsCreatedBy,
  listMoveoutsCreatedByAccount,
} from "../ownership.ts";
import { notifyAccount, notifyDevice, onAccountChange, onDeviceChange, pumpSSE } from "../live.ts";
import { mineView } from "../views/home.ts";
import { logEvent } from "../log.ts";
import { requireSignedIn } from "../session.ts";

export const homeRoutes = new Hono();

// Device-scoped, not moveout-scoped: "My MoveOut"'s summary spans every
// move-out this browser has touched. `deviceId` comes from the cookie
// (src/session.ts), never from anything the client sends, so a visitor can
// only ever subscribe to their own updates.
//
// When signed in, this ALSO subscribes to the account-scoped bus — fixing a
// real bug: device A creating a page while device B (signed into the same
// account) had "My MoveOut" open didn't notify B at all, since the device
// bus only ever hears about writes made BY that specific device. Which
// account to subscribe to is resolved from `c.get("account")` — the live,
// server-verified session — never from a client-supplied id, so one
// account can never subscribe to (or receive) another's notifications.
homeRoutes.get("/events", (c) => {
  const deviceId = c.get("deviceId");
  const accountId = c.get("account")?.id;
  return streamSSE(c, (stream) =>
    pumpSSE(stream, (notify) => {
      const unsubscribeDevice = onDeviceChange(deviceId, notify);
      if (!accountId) return unsubscribeDevice;
      const unsubscribeAccount = onAccountChange(accountId, notify);
      return () => {
        unsubscribeDevice();
        unsubscribeAccount();
      };
    }),
  );
});

// Crit 11: "/" is now the public Browse pool (src/routes/browse.ts) — this
// is "My MoveOut", the creator/claimant management home from before, moved
// here so a returning user keeps a fixed place to find their own pages and
// requests regardless of what's trending in the public pool.
homeRoutes.get("/mine", (c) => {
  const deviceId = c.get("deviceId");
  const account = c.get("account");
  // Signed in: reach every page/request this ACCOUNT owns, from whichever
  // device created them — this is the whole point of having an account, so
  // a different device than the one that created something can still find
  // and manage it. Anonymous: scoped to this device alone, same as before
  // accounts existed.
  const myMoveouts = account ? listMoveoutsCreatedByAccount(account.id) : listMoveoutsCreatedBy(deviceId);
  const myApplications = account ? listApplicationsWithContextForAccount(account.id) : listApplicationsWithContext(deviceId);
  return c.html(mineView(myMoveouts, myApplications, account));
});

homeRoutes.post("/moveouts", async (c) => {
  const deviceId = c.get("deviceId");
  // Creating a page requires an account (this round's brief) — enforced
  // here on the server, not just by hiding the form in mineView, since a
  // hidden form is not a security boundary. A GET-redirect to login (not a
  // 403) is deliberate: an unauthenticated visitor should be offered the
  // chance to sign in and come straight back, not just rejected.
  const signinRedirect = requireSignedIn(c, "/mine");
  if (signinRedirect) {
    logEvent({ event: "moveout.create", actor: deviceId, outcome: "denied", status: 401, reasonCode: "not_signed_in" });
    return signinRedirect;
  }
  const account = c.get("account")!;
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
      mineView([], [], account, { error: "Every field is required to create a move-out page." }),
      400,
    );
  }
  if (!isValidTimeZone(timezone)) {
    return c.html(mineView([], [], account, { error: `"${timezone}" isn't a recognised timezone.` }), 400);
  }
  const deadlineAt = zonedDateTimeToUtc(deadlineRaw, timezone);
  if (!deadlineAt) {
    return c.html(mineView([], [], account, { error: "That deadline date/time isn't valid." }), 400);
  }

  const id = newMoveoutId();
  // Signed-in creation records creator_account_id right away — no need to
  // wait for a later claim pass, since there's no anonymous period to claim
  // from when the device was already signed in at creation time.
  db.prepare(
    `INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, timezone, creator_device_id, creator_nickname, visibility, creator_account_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, title, area, pickupLocation, deadlineAt.toISOString(), timezone, deviceId, nickname, visibility, account?.id ?? null);
  logEvent({ event: "moveout.create", actor: deviceId, outcome: "success", moveoutId: id, reasonCode: visibility });

  // So another already-open tab on this same device ("My MoveOut"'s "Your
  // move-out pages" list) picks this up without a manual reload — and, now
  // that creation always happens signed in, so does every OTHER device
  // signed into the same account with "My MoveOut" open (the bug this round
  // fixes: this used to only ever notify the creating device).
  notifyDevice(deviceId);
  notifyAccount(account.id);
  return c.redirect(`/m/${id}/manage`);
});
