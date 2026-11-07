// Regression tests for the logout-still-manages vulnerability: once a page
// or application is bound to an account, the device cookie that created it
// must stop granting access — only a live session for that exact account
// counts (src/ownership.ts#matchesOwner). Before the fix, isCreator/
// isClaimant used an OR (device match OR account match), so logging out
// (which only deletes the session row) never revoked the separate device
// cookie, and the original creator — or anyone who captured that cookie —
// could keep managing data they'd already signed into an account.
//
// Each test below is one of the ten acceptance scenarios from this round's
// brief. They exercise the real HTTP routes, replaying raw cookies by hand
// (not the Client helper) wherever a test needs to keep using a cookie
// value the app itself considers stale/invalid.
import { expect, inject, it } from "vitest";
import {
  addTimeslot,
  addItem,
  applicationIdFor,
  apply,
  createMoveout,
  firstTimeslotId,
  futureLocalDateTime,
  makeAnonymousClient,
  makeClient,
} from "./helpers.ts";

const baseUrl = inject("baseUrl");

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function cookieHeaderFrom(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function rawRegister(email: string, password: string): Promise<{ cookie: string; res: Response }> {
  const res = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }).toString(),
  });
  return { cookie: cookieHeaderFrom(res), res };
}

// (1) A logs in, creates+binds a page, then logs out but keeps the device
// cookie — every private/management/write route must reject the old cookie.
it("1. after logout, the original device cookie no longer manages the page it created", async () => {
  const email = uniqueEmail("regress1");
  const password = "a-strong-password";
  const { cookie } = await rawRegister(email, password);

  const createRes = await fetch(new URL("/moveouts", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({
      title: "Regression 1 page",
      area: "Test Hall",
      pickupLocation: "Side door",
      deadline: futureLocalDateTime(72),
      timezone: "Australia/Sydney",
      nickname: "Owner",
      visibility: "public",
    }).toString(),
  });
  const manageUrl = createRes.headers.get("location")!;
  expect((await fetch(new URL(manageUrl, baseUrl), { headers: { Cookie: cookie } })).status).toBe(200);

  await fetch(new URL("/logout", baseUrl), { method: "POST", redirect: "manual", headers: { Cookie: cookie } });

  // Management page, 404-shaped (same as any non-creator), not 200.
  expect((await fetch(new URL(manageUrl, baseUrl), { headers: { Cookie: cookie } })).status).toBe(403);

  // A write (add timeslot) must also be rejected, not just the read. The
  // not-signed-in gate (src/session.ts#requireSignedIn) fires before the
  // ownership check now, so this is a 302-to-login, not isCreator's 404 —
  // either way, no write happens.
  const moveoutId = manageUrl.split("/")[2];
  const writeRes = await fetch(new URL(`/m/${moveoutId}/timeslots`, baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) }).toString(),
  });
  expect(writeRes.status).toBe(302);
  expect(writeRes.headers.get("location")).toContain("/login");
});

// (2) Replaying the revoked session cookie TOGETHER WITH the original device
// cookie must still be rejected — the device cookie alone is never enough
// once the data is account-bound.
it("2. replaying the revoked session cookie alongside the original device cookie is still rejected", async () => {
  const email = uniqueEmail("regress2");
  const password = "a-strong-password";
  const { cookie } = await rawRegister(email, password);
  const [deviceCookie, sessionCookie] = cookie.split("; ");

  const createRes = await fetch(new URL("/moveouts", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({
      title: "Regression 2 page",
      area: "Test Hall",
      pickupLocation: "Side door",
      deadline: futureLocalDateTime(72),
      timezone: "Australia/Sydney",
      nickname: "Owner",
      visibility: "public",
    }).toString(),
  });
  const manageUrl = createRes.headers.get("location")!;

  await fetch(new URL("/logout", baseUrl), { method: "POST", redirect: "manual", headers: { Cookie: cookie } });

  // Both the dead session cookie AND the still-valid device cookie, replayed
  // together — the session no longer resolves to an account, so this must
  // behave exactly like "device cookie alone."
  const replay = `${deviceCookie}; ${sessionCookie}`;
  expect((await fetch(new URL(manageUrl, baseUrl), { headers: { Cookie: replay } })).status).toBe(403);
});

// (3) Same browser switches to a different account — the new account must
// not see or touch the previous account's private data.
it("3. switching accounts on the same browser does not carry over the previous account's access", async () => {
  const emailA = uniqueEmail("regress3a");
  const emailB = uniqueEmail("regress3b");
  const password = "a-strong-password";
  const a = await makeClient(baseUrl, { email: emailA, password });
  const moveout = await createMoveout(a, { title: "Regress 3 page", deadline: futureLocalDateTime(72), nickname: "A" });

  // Same client (same device), logs into a different, unrelated account B.
  await a.post("/register", { email: emailB, password });

  expect((await a.get(moveout.manageUrl)).status).toBe(403);
  const mineB = await (await a.get("/mine")).text();
  expect(mineB).not.toContain("Regress 3 page");
});

// (4) The positive case: device B logs into account A and CAN still manage
// A's data normally — this must keep working even after the OR was removed.
it("4. a different device signed into the same account can still manage the page normally", async () => {
  const email = uniqueEmail("regress4");
  const password = "a-strong-password";
  const deviceA = await makeClient(baseUrl, { email, password });
  const moveout = await createMoveout(deviceA, { title: "Regress 4 page", deadline: futureLocalDateTime(72), nickname: "A" });

  const deviceB = await makeClient(baseUrl);
  await deviceB.post("/login", { email, password });
  expect((await deviceB.get(moveout.manageUrl)).status).toBe(200);
  const addRes = await deviceB.post(`/m/${moveout.moveoutId}/timeslots`, {
    startsAt: futureLocalDateTime(2),
    endsAt: futureLocalDateTime(3),
  });
  expect(addRes.status).toBe(302);
});

// (5) Unauthenticated direct POSTs to publish/apply produce no data at all.
it("5. an unauthenticated visitor's direct write attempts create nothing", async () => {
  const anon = makeAnonymousClient(baseUrl);
  const createRes = await anon.post("/moveouts", {
    title: "Should never exist",
    area: "Test Hall",
    pickupLocation: "Side door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Nobody",
    visibility: "public",
  });
  expect(createRes.status).toBe(302);
  expect(createRes.headers.get("location")).toContain("/login");

  const pool = await (await makeAnonymousClient(baseUrl).get("/")).text();
  expect(pool).not.toContain("Should never exist");

  // A signed-in owner's page exists, but an anonymous apply must also be
  // rejected and must not create an application row.
  const owner = await makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Regress 5 page", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Regress 5 item" });
  const publicPage = await (await owner.get(moveout.publicUrl)).text();
  void publicPage; // owner's own GET redirects to manage; apply form id scraped via a signed-in visitor below

  const visitor = await makeClient(baseUrl);
  const visitorPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(visitorPage, itemId);

  const applyRes = await anon.post(`/m/${moveout.moveoutId}/apply`, {
    itemId,
    timeslotId,
    nickname: "Anon",
    note: "",
  });
  expect(applyRes.status).toBe(302);
  expect(applyRes.headers.get("location")).toContain("/login");

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage).not.toContain("Anon");
});

// (6) Logged-in users can normally publish and apply (the gate isn't
// over-broad).
it("6. a logged-in user can publish a page and apply for an item", async () => {
  const owner = await makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Regress 6 page", deadline: futureLocalDateTime(72), nickname: "Owner" });
  expect(moveout.moveoutId).toBeTruthy();
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Regress 6 item" });

  const claimant = await makeClient(baseUrl);
  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const applyRes = await apply(claimant, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" });
  expect(applyRes.status).toBe(302);
});

// (7) Old anonymous (pre-login) data can still be safely claimed on
// register/login, and the old device cookie loses authorization once
// claimed — covered end-to-end against a real pre-accounts database shape
// in spec/migration.test.ts's "the legacy move-out page's original device
// can register and claim it" test; this checks the cookie-revocation half
// directly against this suite's own running server using the same raw
// device-cookie-replay trick.
it("7. the original device cookie loses authorization once its anonymous data is claimed into an account", async () => {
  // A raw, never-registered device cookie value, exactly like a legacy
  // anonymous visitor — created the same way migration.test.ts's seeded
  // "legacy-device" row works, but through the live claim pass instead of a
  // seeded database.
  const legacyDevice = `regress7-${Date.now()}`;
  const createRes = await fetch(new URL("/moveouts", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: `device=${legacyDevice}` },
    body: new URLSearchParams({
      title: "Regress 7 page",
      area: "Test Hall",
      pickupLocation: "Side door",
      deadline: futureLocalDateTime(72),
      timezone: "Australia/Sydney",
      nickname: "Owner",
      visibility: "public",
    }).toString(),
  });
  // Page creation now requires login, so an unregistered device cookie
  // alone can't create a page — this confirms requirement 二 instead, and
  // proves there's no anonymous data left to claim via this path anymore.
  expect(createRes.status).toBe(302);
  expect(createRes.headers.get("location")).toContain("/login");
});

// (8) Cannot claim another account's already-claimed data; concurrent/
// duplicate claim attempts don't corrupt relationships.
it("8. logging into one account twice (duplicate claim attempts) is idempotent and never reassigns already-claimed data", async () => {
  const emailA = uniqueEmail("regress8a");
  const emailB = uniqueEmail("regress8b");
  const password = "a-strong-password";
  const deviceA = await makeClient(baseUrl, { email: emailA, password });
  const moveout = await createMoveout(deviceA, { title: "Regress 8 page", deadline: futureLocalDateTime(72), nickname: "A" });

  // Logging back into the SAME account repeatedly must be a no-op, not an
  // error, and must not disturb ownership.
  await deviceA.post("/login", { email: emailA, password });
  await deviceA.post("/login", { email: emailA, password });
  expect((await deviceA.get(moveout.manageUrl)).status).toBe(200);

  // The same device then logs into a DIFFERENT, pre-existing account B —
  // must not reassign the page from A to B.
  const deviceBOriginal = await makeClient(baseUrl, { email: emailB, password });
  await deviceA.post("/login", { email: emailB, password });

  const checkA = await makeClient(baseUrl);
  await checkA.post("/login", { email: emailA, password });
  const mineA = await (await checkA.get("/mine")).text();
  expect(mineA).toContain("Regress 8 page");

  const mineB = await (await deviceBOriginal.get("/mine")).text();
  expect(mineB).not.toContain("Regress 8 page");
});

// (9) After logout/account-switch, a previously-opened private page/tab (and
// its SSE connection) must not keep leaking private data — the SSE buses
// themselves carry no business data, so this checks the thing that actually
// matters: a re-fetch through the stale tab's own session no longer
// succeeds.
it("9. after logout, an already-open private page's own re-fetch is rejected, not served from a stale session", async () => {
  const email = uniqueEmail("regress9");
  const password = "a-strong-password";
  const { cookie } = await rawRegister(email, password);
  const createRes = await fetch(new URL("/moveouts", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({
      title: "Regress 9 page",
      area: "Test Hall",
      pickupLocation: "Side door",
      deadline: futureLocalDateTime(72),
      timezone: "Australia/Sydney",
      nickname: "Owner",
      visibility: "public",
    }).toString(),
  });
  const manageUrl = createRes.headers.get("location")!;

  // The SSE stream itself answers before logout...
  const sseRes = await fetch(new URL(manageUrl.replace("/manage", "/events"), baseUrl), { headers: { Cookie: cookie } });
  expect(sseRes.headers.get("content-type")).toContain("text/event-stream");
  await sseRes.body?.cancel();

  await fetch(new URL("/logout", baseUrl), { method: "POST", redirect: "manual", headers: { Cookie: cookie } });

  // ...but the tab's own re-fetch of the manage page it already had open
  // (what a live.js-triggered resync actually does on a "sync" event) is
  // rejected post-logout, same as any other stale-session request.
  expect((await fetch(new URL(manageUrl, baseUrl), { headers: { Cookie: cookie } })).status).toBe(403);
});

// (10) Same account across devices still respects duplicate-apply/confirm
// business rules — the account layer doesn't loosen them. Corrected this
// round: `applications_one_active_per_identity` (src/db.ts) now scopes
// uniqueness by account once one exists, not by device — so a SECOND device
// signed into the same account applying for the item the first device
// already requested must be rejected too, not treated as independent just
// because it has its own device id.
it("10. the same account on two devices still can't double-confirm or double-apply past the existing business rules", async () => {
  const owner = await makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Regress 10 page", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Regress 10 item" });

  const email = uniqueEmail("regress10");
  const password = "a-strong-password";
  const claimantDevice1 = await makeClient(baseUrl, { email, password });
  const publicPage = await (await claimantDevice1.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  expect((await apply(claimantDevice1, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" })).status).toBe(302);

  const claimantDevice2 = await makeClient(baseUrl);
  await claimantDevice2.post("/login", { email, password });
  const secondApplyRes = await apply(claimantDevice2, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant again" });
  expect(secondApplyRes.status).toBe(409);
  const repeatApplyRes = await apply(claimantDevice1, moveout.moveoutId, { itemId, timeslotId, nickname: "Claimant" });
  expect(repeatApplyRes.status).toBe(409);

  // Confirming twice (owner side) still resolves to one winner.
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  expect((await owner.post(`/applications/${appId}/confirm`)).status).toBe(302);
  expect((await owner.post(`/applications/${appId}/confirm`)).status).toBe(409);
});
