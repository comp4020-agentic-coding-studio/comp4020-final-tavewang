// Accounts (src/auth.ts, src/routes/auth.ts) sit on top of the existing
// anonymous device-cookie identity — never a replacement. These tests cover
// the brief this round actually asked for: register/login/logout, claiming
// anonymous data into an account, a different device reaching the same
// account's data after signing in, cross-account isolation, and that
// logging out actually revokes the session server-side rather than just
// asking the browser to forget a cookie.
import { expect, inject, it } from "vitest";
import {
  addItem,
  addTimeslot,
  apply,
  applicationIdFor,
  createMoveout,
  firstTimeslotId,
  futureLocalDateTime,
  makeClient,
} from "./helpers.ts";

const baseUrl = inject("baseUrl");

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

it("registering creates an account and claims this device's existing anonymous move-out page", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Claim-on-register test", deadline: futureLocalDateTime(72), nickname: "Owner" });

  const email = uniqueEmail("register-claim");
  const res = await owner.post("/register", { email, password: "a-strong-password" });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Linked 1 move-out page");

  // The same client (same device, now also signed in) still manages it,
  // and /mine lists it under the account view.
  expect((await owner.get(moveout.manageUrl)).status).toBe(200);
  const mine = await (await owner.get("/mine")).text();
  expect(mine).toContain("Claim-on-register test");
});

it("a second, independent client can log into the same account and manage a page it never created", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Cross-device manage test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  const email = uniqueEmail("cross-device");
  await owner.post("/register", { email, password: "a-strong-password" });

  // A brand new "browser" — no cookies in common with `owner` at all.
  const otherDevice = makeClient(baseUrl);
  expect((await otherDevice.get(moveout.manageUrl)).status).toBe(403); // not signed in yet: no access

  const loginRes = await otherDevice.post("/login", { email, password: "a-strong-password" });
  expect(loginRes.status).toBe(200);

  // Now it can reach and manage the SAME page, purely through the account.
  expect((await otherDevice.get(moveout.manageUrl)).status).toBe(200);
  const mine = await (await otherDevice.get("/mine")).text();
  expect(mine).toContain("Cross-device manage test");

  // And can actually perform a creator-only write (add a timeslot), not
  // just view the page.
  const addRes = await otherDevice.post(`/m/${moveout.moveoutId}/timeslots`, {
    startsAt: futureLocalDateTime(2),
    endsAt: futureLocalDateTime(3),
  });
  expect(addRes.status).toBe(302);
});

it("registering claims this device's anonymous application, reachable from a different device after login", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Claim-application test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Claimed Lamp" });

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  await apply(claimant, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" });

  const email = uniqueEmail("claim-application");
  const registerRes = await claimant.post("/register", { email, password: "a-strong-password" });
  const registerBody = await registerRes.text();
  expect(registerBody).toContain("Linked");
  expect(registerBody).toMatch(/1\s*request/);

  // A different device logs into the same account and can act on that
  // request (confirm it first from the owner side, then set departure
  // status from the new device).
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  expect((await owner.post(`/applications/${appId}/confirm`)).status).toBe(302);

  const otherDevice = makeClient(baseUrl);
  await otherDevice.post("/login", { email, password: "a-strong-password" });
  const departureRes = await otherDevice.post(`/applications/${appId}/departure`, { status: "departed" });
  expect(departureRes.status).toBe(302);
});

it("an unrelated account cannot manage someone else's page or act on someone else's application", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Isolation test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Isolated Lamp" });
  await owner.post("/register", { email: uniqueEmail("isolation-owner"), password: "a-strong-password" });

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  await apply(claimant, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" });
  await claimant.post("/register", { email: uniqueEmail("isolation-claimant"), password: "a-strong-password" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  await owner.post(`/applications/${appId}/confirm`);

  // A third, completely unrelated account.
  const stranger = makeClient(baseUrl);
  await stranger.post("/register", { email: uniqueEmail("isolation-stranger"), password: "a-strong-password" });

  expect((await stranger.get(moveout.manageUrl)).status).toBe(403);
  expect((await stranger.post(`/applications/${appId}/departure`, { status: "arrived" })).status).toBe(404);
  expect((await stranger.post(`/applications/${appId}/cancel`)).status).toBe(404);
  expect((await stranger.post(`/items/${itemId}/withdraw`)).status).toBe(404);
});

it("logging out revokes the session — the old cookie value can't be replayed for a write", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Logout revocation test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  const email = uniqueEmail("logout-revocation");
  await owner.post("/register", { email, password: "a-strong-password" });

  // Grab the raw session cookie value before logging out, the same way a
  // stolen cookie would be replayed — this test drives raw fetch, not the
  // Client helper, so it can keep using this exact cookie string after the
  // Client's own jar has moved on.
  const loginRes = await fetch(new URL("/login", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "a-strong-password" }).toString(),
  });
  const setCookieHeader = loginRes.headers.get("set-cookie") ?? "";
  const sessionMatch = setCookieHeader.match(/session=([^;,]+)/);
  expect(sessionMatch).not.toBeNull();
  const sessionCookie = `session=${sessionMatch![1]}`;

  // Confirm the session actually works before logging out.
  const beforeLogout = await fetch(new URL(moveout.manageUrl, baseUrl), { headers: { Cookie: sessionCookie } });
  expect(beforeLogout.status).toBe(200);

  await fetch(new URL("/logout", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { Cookie: sessionCookie },
  });

  // The exact same session cookie value, replayed after logout, is now
  // indistinguishable from an anonymous visitor — it can no longer reach
  // the manage page (a fresh anonymous device never created this page) or
  // perform the write.
  const afterLogout = await fetch(new URL(moveout.manageUrl, baseUrl), { headers: { Cookie: sessionCookie } });
  expect(afterLogout.status).toBe(403);

  const addRes = await fetch(new URL(`/m/${moveout.moveoutId}/timeslots`, baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: sessionCookie },
    body: new URLSearchParams({ startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) }).toString(),
  });
  expect(addRes.status).toBe(404);
});

it("rejects registering with an email already in use, and rejects login with a wrong password or unknown email", async () => {
  const email = uniqueEmail("duplicate-check");
  const first = makeClient(baseUrl);
  expect((await first.post("/register", { email, password: "a-strong-password" })).status).toBe(200);

  const second = makeClient(baseUrl);
  const dupRes = await second.post("/register", { email, password: "another-password" });
  expect(dupRes.status).toBe(400);
  expect(await dupRes.text()).toContain("already exists");

  const wrongPassword = makeClient(baseUrl);
  const wrongPasswordRes = await wrongPassword.post("/login", { email, password: "totally-wrong" });
  expect(wrongPasswordRes.status).toBe(401);

  const unknownEmail = makeClient(baseUrl);
  const unknownEmailRes = await unknownEmail.post("/login", { email: uniqueEmail("never-registered"), password: "whatever12345" });
  expect(unknownEmailRes.status).toBe(401);
});

it("rejects an invalid email format and a too-short password at registration", async () => {
  const client = makeClient(baseUrl);
  const badEmailRes = await client.post("/register", { email: "not-an-email", password: "a-strong-password" });
  expect(badEmailRes.status).toBe(400);

  const shortPasswordRes = await client.post("/register", { email: uniqueEmail("short-password"), password: "short" });
  expect(shortPasswordRes.status).toBe(400);
});

// Regression: the write-side claimant check (isClaimant, src/ownership.ts)
// was widened to match on account as well as device, but GET /m/:id's "Your
// requests" query was a separate, hand-written SQL statement that only
// checked claimer_device_id — so a different device, signed into the same
// account, could already successfully POST /applications/:id/departure (the
// write-side check passed) but would see an empty "Your requests" section,
// unable to find the application id to act on it through the UI at all.
// Caught by scripts/browser-verify-accounts.mjs's rendered-page check
// before being fixed here at the HTTP level.
it("a different device, signed into the same account, sees the request in its own 'Your requests' section — not just able to POST a write blindly", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Read-path account test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Read-path Item" });

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  await apply(claimant, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" });
  const email = uniqueEmail("read-path");
  await claimant.post("/register", { email, password: "a-strong-password" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  await owner.post(`/applications/${appId}/confirm`);

  const otherDevice = makeClient(baseUrl);
  await otherDevice.post("/login", { email, password: "a-strong-password" });
  const otherDevicePublicPage = await (await otherDevice.get(moveout.publicUrl)).text();
  expect(otherDevicePublicPage).toContain(`data-application-id="${appId}"`);
  expect(otherDevicePublicPage).toContain("Confirmed pickup time");
});

it("logging into an existing account from a device that already belongs to a DIFFERENT account does not reassign that device's data", async () => {
  // Device A registers account A, creating a page owned by account A.
  const deviceA = makeClient(baseUrl);
  const emailA = uniqueEmail("no-reassign-a");
  await deviceA.post("/register", { email: emailA, password: "a-strong-password" });
  // No apostrophe in the title: hono/html escapes it to &#39; in the
  // rendered page, which would make a plain .toContain() check on the raw
  // title string fail for a reason that has nothing to do with what this
  // test is actually about (ownership not being reassigned).
  const moveoutA = await createMoveout(deviceA, { title: "Device A page", deadline: futureLocalDateTime(72), nickname: "OwnerA" });

  // The SAME device (deviceA's cookies) now logs into a SECOND, pre-existing
  // account B — claimAnonymousDataForAccount must not silently move
  // moveoutA from account A to account B, since moveoutA already has a
  // non-null creator_account_id (A's) at the time this login's claim pass
  // runs.
  const emailB = uniqueEmail("no-reassign-b");
  const deviceBOriginal = makeClient(baseUrl);
  await deviceBOriginal.post("/register", { email: emailB, password: "a-strong-password" });
  await deviceA.post("/login", { email: emailB, password: "a-strong-password" });

  // Account A must still own it — fetch from a THIRD client logged into
  // account A to prove ownership didn't move.
  const checkA = makeClient(baseUrl);
  await checkA.post("/login", { email: emailA, password: "a-strong-password" });
  const mineA = await (await checkA.get("/mine")).text();
  expect(mineA).toContain("Device A page");

  // And account B's own "mine" must NOT show it.
  const mineB = await (await deviceBOriginal.get("/mine")).text();
  expect(mineB).not.toContain("Device A page");
  void moveoutA;
});
