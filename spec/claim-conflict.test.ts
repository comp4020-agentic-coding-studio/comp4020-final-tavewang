// Regression for a real 500 error, found by Codex: `claimAnonymousDataForAccount`
// (src/auth.ts) used to run all of a device's unclaimed applications'
// account-linking UPDATEs inside ONE transaction with no per-row isolation
// — so the moment any single row's claim collided with
// `applications_one_active_per_identity` (this account already has its own
// active request for the same item, sent from a different device), the
// thrown SqliteError propagated straight out of the whole transaction,
// aborting the login/register request entirely and returning a bare 500.
// Correct credentials, no session created, no way to sign in at all until
// the conflicting data was somehow removed by hand.
//
// The fix claims each application in its own SAVEPOINT: a conflicting row
// is rolled back to its pre-claim state (left exactly as it was — still
// reachable and manageable from the same anonymous device) without
// aborting any other row's claim or the session being created around the
// whole pass. This file drives real HTTP routes against a real running
// server, using genuine pre-existing "old data" fixtures (inserted directly
// into the database, the same way a volume that's been running since before
// this fix would actually have it) — never a mocked unique-constraint
// error — to reproduce the failure and confirm the fix.
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 8143;
const baseUrl = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-claim-conflict-test-"));

function startServer(): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  });
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never answered at ${baseUrl}`);
}

async function stopServer(proc: ChildProcessWithoutNullStreams): Promise<void> {
  await new Promise<void>((resolve) => {
    proc.once("exit", () => resolve());
    proc.kill("SIGTERM");
  });
}

let server: ChildProcessWithoutNullStreams;

interface Client {
  get(path: string): Promise<Response>;
  post(path: string, data?: Record<string, string>): Promise<Response>;
  cookieHeader(): string;
}

function makeRawClient(): Client {
  const cookies = new Map<string, string>();
  const request = async (method: string, path: string, data?: Record<string, string>): Promise<Response> => {
    const cookieHeader = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(data ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: data ? new URLSearchParams(data).toString() : undefined,
    });
    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  };
  return {
    get: (p) => request("GET", p),
    post: (p, d) => request("POST", p, d),
    cookieHeader: () => Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; "),
  };
}

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

function futureLocalDateTime(hoursFromNow: number): string {
  const date = new Date(Date.now() + hoursFromNow * 3600_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "Australia/Sydney",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

beforeAll(async () => {
  server = startServer();
  await waitForServer();
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
});

// Builds: an owner's page with one item + one timeslot, account A already
// having its OWN active application for that item (from a real device,
// over real HTTP), and then inserts a genuinely pre-existing, unbound
// application directly into the database for a SECOND device cookie on the
// SAME item — simulating "this browser has had this app installed since
// before accounts existed, with its own unclaimed request" exactly as a
// real production volume would have it, never a mocked constraint error.
async function setupConflictFixture(nicknameSuffix: string) {
  const owner = makeRawClient();
  await owner.post("/register", { email: uniqueEmail(`claim-owner-${nicknameSuffix}`), password: "a-strong-password" });
  const createRes = await owner.post("/moveouts", {
    title: `Claim conflict test ${nicknameSuffix}`,
    area: "Test Hall",
    pickupLocation: "Door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = createRes.headers.get("location")!;
  const moveoutId = manageUrl.split("/")[2];
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  await owner.post(`/m/${moveoutId}/items`, { name: `Conflict Item ${nicknameSuffix}`, category: "Other" });

  const visitor = makeRawClient();
  await visitor.post("/register", { email: uniqueEmail(`claim-visitor-${nicknameSuffix}`), password: "a-strong-password" });
  const publicPage = await (await visitor.get(`/m/${moveoutId}`)).text();
  const itemId = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1];
  const timeslotId = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/)![1];

  const accountEmail = uniqueEmail(`claim-account-${nicknameSuffix}`);
  const accountPassword = "a-strong-password";
  const accountDevice = makeRawClient();
  await accountDevice.post("/register", { email: accountEmail, password: accountPassword });
  const applyRes = await accountDevice.post(`/m/${moveoutId}/apply`, { itemId, timeslotId, nickname: `AccountDevice-${nicknameSuffix}` });
  if (applyRes.status !== 302) throw new Error(`account's own apply failed: ${applyRes.status} ${await applyRes.text()}`);

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const accountRow = db.prepare("SELECT id FROM accounts WHERE email = ?").get(accountEmail) as { id: string };
  const accountId = accountRow.id;

  // The conflicting device: a fresh, never-registered cookie jar with its
  // own genuine, unbound (claimer_account_id IS NULL) application for the
  // SAME item, inserted directly — this is what a real pre-existing
  // anonymous request from before accounts looks like in the database.
  const conflictDevice = makeRawClient();
  await conflictDevice.get("/"); // picks up a device cookie
  const conflictDeviceCookie = conflictDevice.cookieHeader();
  const conflictDeviceId = conflictDeviceCookie.match(/device=([^;]+)/)![1];
  const conflictAppId = `conflict-app-${nicknameSuffix}`;
  db.prepare(
    `INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, status) VALUES (?,?,?,?,?,?)`,
  ).run(conflictAppId, itemId, timeslotId, conflictDeviceId, `ConflictDevice-${nicknameSuffix}`, "pending");
  db.close();

  return { owner, moveoutId, itemId, timeslotId, accountEmail, accountPassword, accountId, conflictDevice, conflictAppId };
}

it("1-7. correct-password login succeeds despite a claim conflict, isolates identity verification from claim outcome, and never silently drops or double-counts data", async () => {
  const { accountEmail, accountPassword, accountId, conflictDevice, conflictAppId } = await setupConflictFixture("main");

  // Wrong password must never proceed to any claim logic or grant anything.
  const wrongPwDevice = makeRawClient();
  const wrongPwRes = await wrongPwDevice.post("/login", { email: accountEmail, password: "totally-wrong-password" });
  expect(wrongPwRes.status).toBe(401);
  const wrongPwMine = await (await wrongPwDevice.get("/mine")).text();
  expect(wrongPwMine).not.toContain(accountEmail);

  // The real bug: the conflicting device logs in with the CORRECT password.
  // Before the fix this returned 500 with no session at all.
  const loginRes = await conflictDevice.post("/login", { email: accountEmail, password: accountPassword });
  expect(loginRes.status).toBe(200);
  const loginBody = await loginRes.text();
  expect(loginBody).not.toContain("Internal Server Error");
  // Honest reporting: never claims "everything was linked" when the
  // conflicting application specifically wasn't.
  expect(loginBody).toContain("Conflict Item main");
  expect(loginBody).toContain("wasn&#39;t linked");

  // The conflicting application was left untouched: still pending, still
  // unclaimed by this (or any) account, still fully owned by its original
  // device — never silently cancelled, deleted, or force-claimed.
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const conflictApp = db.prepare("SELECT status, claimer_account_id FROM applications WHERE id = ?").get(conflictAppId) as {
    status: string;
    claimer_account_id: string | null;
  };
  expect(conflictApp.status).toBe("pending");
  expect(conflictApp.claimer_account_id).toBeNull();

  // No account-level duplicate was created by the attempted claim: the
  // account still has exactly one active application for that item.
  const activeForAccount = db
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE claimer_account_id = ? AND status IN ('pending','confirmed')")
    .get(accountId) as { n: number };
  expect(activeForAccount.n).toBe(1);
  db.close();

  // The device that hit the conflict is still logged in and can manage
  // (here, cancel) the application the conflict left in its care — the
  // real, usable "resolve it and try again" path, not a dead end.
  const managePage = await (await conflictDevice.get(`/m/${(await conflictDevice.get("/mine")).url}`)).text().catch(() => "");
  void managePage;
  const cancelRes = await conflictDevice.post(`/applications/${conflictAppId}/cancel`);
  expect(cancelRes.status).toBe(302);

  // Re-logging in now (no more conflict) claims it as expected: idempotent,
  // no duplicate, no half-claimed state. (The cancelled row is no longer a
  // candidate for claiming — only pending/confirmed rows are, so this just
  // confirms a second login attempt is safe and doesn't error.)
  const secondLoginRes = await conflictDevice.post("/login", { email: accountEmail, password: accountPassword });
  expect(secondLoginRes.status).toBe(200);
});

it("8. a confirmed booking involved in a claim conflict is never cancelled or corrupted", async () => {
  const { owner, moveoutId, itemId, accountEmail, accountPassword, conflictDevice, conflictAppId } = await setupConflictFixture("confirmed");

  // Confirm the ACCOUNT's own (non-conflicting) application first, so the
  // conflict this test cares about is specifically "device's unclaimed
  // request vs. the account's own CONFIRMED one" — the highest-stakes case,
  // since a confirmed booking must never be silently touched by a claim
  // conflict.
  const managePage = await (await owner.get(`/m/${moveoutId}/manage`)).text();
  const appIdMatch = managePage.match(/data-application-id="([A-Za-z0-9_-]+)"[^>]*>\s*<span>AccountDevice-confirmed/);
  expect(appIdMatch).not.toBeNull();
  const confirmRes = await owner.post(`/applications/${appIdMatch![1]}/confirm`);
  expect(confirmRes.status).toBe(302);

  const beforeDb = new DatabaseSync(join(dataDir, "moveout.db"));
  const beforeConfirmed = beforeDb.prepare("SELECT status FROM applications WHERE id = ?").get(appIdMatch![1]) as { status: string };
  expect(beforeConfirmed.status).toBe("confirmed");
  beforeDb.close();

  const loginRes = await conflictDevice.post("/login", { email: accountEmail, password: accountPassword });
  expect(loginRes.status).toBe(200);
  expect(loginRes.status).not.toBe(500);

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  // The confirmed booking is completely untouched.
  const confirmedAfter = db.prepare("SELECT status, confirmed_at FROM applications WHERE id = ?").get(appIdMatch![1]) as {
    status: string;
    confirmed_at: string | null;
  };
  expect(confirmedAfter.status).toBe("confirmed");
  expect(confirmedAfter.confirmed_at).not.toBeNull();
  // The conflicting application was left unclaimed, not force-cancelled.
  const conflictApp = db.prepare("SELECT status, claimer_account_id FROM applications WHERE id = ?").get(conflictAppId) as {
    status: string;
    claimer_account_id: string | null;
  };
  expect(conflictApp.status).toBe("pending");
  expect(conflictApp.claimer_account_id).toBeNull();
  // The item itself stayed 'reserved' (the confirmed booking's doing),
  // never reverted by the failed/partial claim attempt.
  const item = db.prepare("SELECT status FROM items WHERE id = ?").get(itemId) as { status: string };
  expect(item.status).toBe("reserved");
  db.close();
});

it("9. one browser with a claimable page, a non-conflicting application, AND a conflicting application all resolve correctly in one login, with no half-completed state", async () => {
  const owner = makeRawClient();
  await owner.post("/register", { email: uniqueEmail("claim-mixed-owner"), password: "a-strong-password" });
  const createRes = await owner.post("/moveouts", {
    title: "Mixed claim test",
    area: "Test Hall",
    pickupLocation: "Door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = createRes.headers.get("location")!;
  const moveoutId = manageUrl.split("/")[2];
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  await owner.post(`/m/${moveoutId}/items`, { name: "Mixed Item A", category: "Other" });
  await owner.post(`/m/${moveoutId}/items`, { name: "Mixed Item B", category: "Other" });

  const accountEmail = uniqueEmail("claim-mixed-account");
  const accountPassword = "a-strong-password";
  const accountDevice = makeRawClient();
  await accountDevice.post("/register", { email: accountEmail, password: accountPassword });

  const managePageForIds = await (await owner.get(`/m/${moveoutId}/manage`)).text();
  const itemIds = Array.from(managePageForIds.matchAll(/data-item-id="([A-Za-z0-9_-]+)"/g)).map((m) => m[1]);
  expect(itemIds.length).toBeGreaterThanOrEqual(2);
  const [itemAId, itemBId] = itemIds;

  const visitorForSlots = makeRawClient();
  await visitorForSlots.post("/register", { email: uniqueEmail("claim-mixed-visitor"), password: "a-strong-password" });
  const publicPage = await (await visitorForSlots.get(`/m/${moveoutId}`)).text();
  const timeslotId = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/)![1];

  // Account applies (from its own device) for Item A only.
  const applyRes = await accountDevice.post(`/m/${moveoutId}/apply`, { itemId: itemAId, timeslotId, nickname: "AccountOwnApply" });
  expect(applyRes.status).toBe(302);

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const accountRow = db.prepare("SELECT id FROM accounts WHERE email = ?").get(accountEmail) as { id: string };
  const accountId = accountRow.id;

  // The browser about to sign in: a THIRD device with three kinds of
  // pre-existing, unbound data —
  //  (a) a claimable page (its own move-out page, unbound creator)
  //  (b) a non-conflicting application (Item B, which the account has no
  //      existing application for)
  //  (c) a conflicting application (Item A, which the account DOES already
  //      have an active application for)
  const mixedDevice = makeRawClient();
  await mixedDevice.get("/");
  const mixedDeviceId = mixedDevice.cookieHeader().match(/device=([^;]+)/)![1];

  db.prepare(
    `INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, timezone, creator_device_id, creator_nickname, visibility)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run("mixed-claimable-page", "Mixed Claimable Page", "Hall", "Door", "2030-01-01T00:00:00.000Z", "Australia/Sydney", mixedDeviceId, "Mixed Owner", "unlisted");
  db.prepare(
    `INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, status) VALUES (?,?,?,?,?,?)`,
  ).run("mixed-nonconflict-app", itemBId, timeslotId, mixedDeviceId, "MixedNonConflict", "pending");
  db.prepare(
    `INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, status) VALUES (?,?,?,?,?,?)`,
  ).run("mixed-conflict-app", itemAId, timeslotId, mixedDeviceId, "MixedConflict", "pending");
  db.close();

  const loginRes = await mixedDevice.post("/login", { email: accountEmail, password: accountPassword });
  expect(loginRes.status).toBe(200);
  const loginBody = await loginRes.text();
  expect(loginBody).not.toContain("Internal Server Error");
  // Reports exactly one linked page and one linked (non-conflicting)
  // request, and separately surfaces the one conflicted request.
  expect(loginBody).toContain("Linked");
  expect(loginBody).toMatch(/1\s*move-out page/);
  expect(loginBody).toMatch(/1\s*request/);
  expect(loginBody).toContain("Mixed Item A");

  const afterDb = new DatabaseSync(join(dataDir, "moveout.db"));
  const claimablePage = afterDb.prepare("SELECT creator_account_id FROM moveouts WHERE id = ?").get("mixed-claimable-page") as {
    creator_account_id: string | null;
  };
  expect(claimablePage.creator_account_id).toBe(accountId);
  const nonConflictApp = afterDb.prepare("SELECT claimer_account_id FROM applications WHERE id = ?").get("mixed-nonconflict-app") as {
    claimer_account_id: string | null;
  };
  expect(nonConflictApp.claimer_account_id).toBe(accountId);
  const conflictApp = afterDb.prepare("SELECT claimer_account_id, status FROM applications WHERE id = ?").get("mixed-conflict-app") as {
    claimer_account_id: string | null;
    status: string;
  };
  expect(conflictApp.claimer_account_id).toBeNull();
  expect(conflictApp.status).toBe("pending");
  // No half-completed state: exactly one active application per item for
  // THIS test's own two items (the account's own original one for Item A,
  // the newly-claimed one for Item B) plus the untouched conflict row —
  // scoped to these two item ids since this test file shares one database
  // across its several scenarios.
  const activeCount = afterDb
    .prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending' AND item_id IN (?, ?)")
    .get(itemAId, itemBId) as { n: number };
  expect(activeCount.n).toBe(3); // account's Item A app, newly-claimed Item B app, untouched conflict app
  afterDb.close();
});

it("10. logging out after a claim conflict still properly revokes access via the old device cookie", async () => {
  const { accountEmail, accountPassword, conflictDevice } = await setupConflictFixture("logout");
  const loginRes = await conflictDevice.post("/login", { email: accountEmail, password: accountPassword });
  expect(loginRes.status).toBe(200);

  const mineBeforeLogout = await (await conflictDevice.get("/mine")).text();
  expect(mineBeforeLogout).toContain(accountEmail);

  await conflictDevice.post("/logout");
  const mineAfterLogout = await (await conflictDevice.get("/mine")).text();
  expect(mineAfterLogout).not.toContain(accountEmail);
});
