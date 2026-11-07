// Regression for a real startup crash, found by Codex: `src/db.ts`'s very
// first `db.exec(...)` block (table creation) used to unconditionally
// `CREATE UNIQUE INDEX IF NOT EXISTS applications_one_active_per_device` —
// the OLD, device-scoped uniqueness rule — on every single startup, before
// the later one-time migration ever got a chance to replace it with the
// account-scoped `applications_one_active_per_identity`. On a database that
// already has data the NEW (correct) rule allows but the OLD rule doesn't —
// the exact case this test produces: the SAME item, two DIFFERENT accounts,
// each with their own valid active application, submitted from the SAME
// device (one account logs out, a different account logs in and applies) —
// that unconditional `CREATE UNIQUE INDEX` for the old rule found its own
// constraint already violated and crashed the whole server before it could
// reach the code that would have dropped it. Fixed by moving the old
// index's creation (and its removal) entirely into the one-time migration,
// guarded the same way every other migration here is, so it's never
// recreated on a database that's already past it.
//
// This test drives the real HTTP routes to produce that exact data shape
// (not a hand-seeded fixture — the brief specifically asks for a REAL
// restart regression), stops the real server process, and restarts it
// against the same DATA_DIR, confirming it comes back up and every
// application and its account ownership survived intact.
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 8142;
const baseUrl = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-restart-test-"));

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

function uniqueEmail(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

interface Client {
  get(path: string): Promise<Response>;
  post(path: string, data?: Record<string, string>): Promise<Response>;
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
  return { get: (p) => request("GET", p), post: (p, d) => request("POST", p, d) };
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

let moveoutId = "";
let itemId = "";
let timeslotId = "";
let accountAId = "";
let accountBId = "";
const accountAEmail = uniqueEmail("restart-a");
const accountBEmail = uniqueEmail("restart-b");
const PASSWORD = "a-strong-password";

beforeAll(async () => {
  server = startServer();
  await waitForServer();

  // Owner publishes a page with one item and one timeslot.
  const owner = makeRawClient();
  const ownerEmail = uniqueEmail("restart-owner");
  await owner.post("/register", { email: ownerEmail, password: "a-strong-password" });
  const createRes = await owner.post("/moveouts", {
    title: "Restart regression test",
    area: "Test Hall",
    pickupLocation: "Door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = createRes.headers.get("location")!;
  moveoutId = manageUrl.split("/")[2];
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  await owner.post(`/m/${moveoutId}/items`, { name: "Restart Test Item", category: "Other" });

  const visitor = makeRawClient();
  await visitor.post("/register", { email: uniqueEmail("restart-visitor"), password: "a-strong-password" });
  const publicPage = await (await visitor.get(`/m/${moveoutId}`)).text();
  const itemMatch = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/);
  const slotMatch = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/);
  itemId = itemMatch![1];
  timeslotId = slotMatch![1];

  // ONE device (one cookie jar, one `device` cookie throughout): account A
  // applies for the item, logs out, account B applies for the SAME item.
  // Two different accounts means both applications are independently
  // valid under `applications_one_active_per_identity` — the exact shape
  // the old, device-scoped index couldn't tell apart from a real duplicate.
  const sameDevice = makeRawClient();
  await sameDevice.post("/register", { email: accountAEmail, password: PASSWORD });
  const applyA = await sameDevice.post(`/m/${moveoutId}/apply`, { itemId, timeslotId, nickname: "AccountA" });
  if (applyA.status !== 302) throw new Error(`account A apply failed: ${applyA.status} ${await applyA.text()}`);

  await sameDevice.post("/logout");
  await sameDevice.post("/register", { email: accountBEmail, password: PASSWORD });
  const applyB = await sameDevice.post(`/m/${moveoutId}/apply`, { itemId, timeslotId, nickname: "AccountB" });
  if (applyB.status !== 302) throw new Error(`account B apply failed: ${applyB.status} ${await applyB.text()}`);

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const apps = db.prepare("SELECT claimer_account_id FROM applications WHERE item_id = ?").all(itemId) as unknown as {
    claimer_account_id: string;
  }[];
  if (apps.length !== 2) throw new Error(`expected 2 applications before restart, found ${apps.length}`);
  accountAId = apps[0].claimer_account_id;
  accountBId = apps[1].claimer_account_id;
  db.close();
});

afterAll(async () => {
  await stopServer(server);
  rmSync(dataDir, { recursive: true, force: true });
});

it("1. the server restarts successfully against a DATA_DIR holding two different accounts' valid applications for the same item", async () => {
  // Stop the server that created the fixture above, then start a FRESH
  // process against the exact same DATA_DIR — the real scenario: the app
  // gets redeployed/restarted with existing data already on the volume.
  await stopServer(server);
  server = startServer();
  await waitForServer(); // throws (failing this test) if the server never answers

  const health = await fetch(baseUrl);
  expect(health.status).toBe(200);
});

it("2. restarting again (a second, and third, consecutive restart) remains safe", async () => {
  await stopServer(server);
  server = startServer();
  await waitForServer();
  expect((await fetch(baseUrl)).status).toBe(200);

  await stopServer(server);
  server = startServer();
  await waitForServer();
  expect((await fetch(baseUrl)).status).toBe(200);
});

it("3. both applications and their account ownership survived the restarts unchanged", async () => {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const apps = db
    .prepare("SELECT claimer_account_id, claimer_nickname, status FROM applications WHERE item_id = ? ORDER BY created_at")
    .all(itemId) as unknown as { claimer_account_id: string; claimer_nickname: string; status: string }[];
  expect(apps).toHaveLength(2);
  expect(apps[0].claimer_account_id).toBe(accountAId);
  expect(apps[0].claimer_nickname).toBe("AccountA");
  expect(apps[0].status).toBe("pending");
  expect(apps[1].claimer_account_id).toBe(accountBId);
  expect(apps[1].claimer_nickname).toBe("AccountB");
  expect(apps[1].status).toBe("pending");
  db.close();
});

it("4. the new account-scoped index exists, the old device-scoped index is gone, and both accounts can still act on their own application after restart", async () => {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const indexes = db.prepare("PRAGMA index_list(applications)").all() as unknown as { name: string }[];
  expect(indexes.some((i) => i.name === "applications_one_active_per_identity")).toBe(true);
  expect(indexes.some((i) => i.name === "applications_one_active_per_device")).toBe(false);
  db.close();

  // Each account, logging in fresh on a NEW device after the restart, can
  // still see and act on (cancel) its own application — proving this isn't
  // just a database-level check but something the app actually serves
  // correctly post-restart, through the real route.
  const freshDeviceA = makeRawClient();
  await freshDeviceA.post("/login", { email: accountAEmail, password: PASSWORD });
  const pageA = await (await freshDeviceA.get(`/m/${moveoutId}`)).text();
  expect(pageA).toContain("Restart Test Item");
  const appIdMatchA = pageA.match(/data-application-id="([A-Za-z0-9_-]+)"/);
  expect(appIdMatchA).not.toBeNull();
  const cancelA = await freshDeviceA.post(`/applications/${appIdMatchA![1]}/cancel`);
  expect(cancelA.status).toBe(302);

  const freshDeviceB = makeRawClient();
  await freshDeviceB.post("/login", { email: accountBEmail, password: PASSWORD });
  const pageB = await (await freshDeviceB.get(`/m/${moveoutId}`)).text();
  const appIdMatchB = pageB.match(/data-application-id="([A-Za-z0-9_-]+)"/);
  expect(appIdMatchB).not.toBeNull();
  const cancelB = await freshDeviceB.post(`/applications/${appIdMatchB![1]}/cancel`);
  expect(cancelB.status).toBe(302);
});
