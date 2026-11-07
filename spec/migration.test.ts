// Crit 11's schema migration (src/db.ts: visibility + category columns) has
// to run safely against a volume that already has Crit 7-10 data on it —
// never a DROP, never a rebuild, and never guessing what an existing item's
// category should be. This seeds a database file shaped exactly like the
// pre-Crit-11 schema (no visibility/category columns), points a real server
// process at it, and checks what comes out the other side: nothing lost,
// nothing guessed, and the migration doesn't error on a second run.
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeAnonymousClient } from "./helpers.ts";

const PORT = 8139;
const baseUrl = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-migration-test-"));

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

function seedOldSchema() {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  db.exec(`
    CREATE TABLE moveouts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, area TEXT NOT NULL, pickup_location TEXT NOT NULL,
      deadline_at TEXT NOT NULL, timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
      creator_device_id TEXT NOT NULL, creator_nickname TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE timeslots (
      id TEXT PRIMARY KEY, moveout_id TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE items (
      id TEXT PRIMARY KEY, moveout_id TEXT NOT NULL, name TEXT NOT NULL, photo_path TEXT,
      condition_notes TEXT, additional_notes TEXT, status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, item_id TEXT NOT NULL, timeslot_id TEXT NOT NULL,
      claimer_device_id TEXT NOT NULL, claimer_nickname TEXT NOT NULL, note TEXT,
      status TEXT NOT NULL DEFAULT 'pending', confirmed_at TEXT, cancelled_at TEXT,
      cancel_reason TEXT, completed_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  // A far-future deadline so this legacy page would otherwise be eligible
  // for the pool on content grounds alone — the only thing that should be
  // keeping it out is the migration defaulting it to 'unlisted'.
  db.prepare(
    "INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, creator_device_id, creator_nickname) VALUES (?,?,?,?,?,?,?)",
  ).run("legacy-moveout", "Pre-Crit-11 Page", "Legacy Hall", "Legacy Door", "2030-01-01T00:00:00.000Z", "legacy-device", "Legacy Owner");
  db.prepare("INSERT INTO items (id, moveout_id, name, status) VALUES (?,?,?,?)").run(
    "legacy-item",
    "legacy-moveout",
    "Pre-existing Legacy Lamp",
    "open",
  );
  db.prepare(
    "INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, status) VALUES (?,?,?,?,?,?)",
  ).run("legacy-app", "legacy-item", "legacy-timeslot", "legacy-claimer", "Legacy Claimer", "completed");

  // A second legacy page, dedicated to this round's "no anonymous writes on
  // unbound legacy data" checks below — kept separate from legacy-moveout
  // above so those tests (which read its content) aren't disturbed by a
  // write attempt here failing or succeeding.
  db.prepare(
    "INSERT INTO moveouts (id, title, area, pickup_location, deadline_at, creator_device_id, creator_nickname) VALUES (?,?,?,?,?,?,?)",
  ).run("legacy-moveout-2", "Second Legacy Page", "Legacy Hall", "Legacy Door", "2030-01-01T00:00:00.000Z", "legacy-device-2", "Legacy Owner Two");
  db.close();
}

let server: ChildProcessWithoutNullStreams;

beforeAll(async () => {
  seedOldSchema();
  server = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  });
  await waitForServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
  });
  rmSync(dataDir, { recursive: true, force: true });
});

it("a pre-Crit-11 move-out page migrates to unlisted, not public, and keeps its content", async () => {
  // Reachable by its old URL, unaffected by never having had visibility set.
  const visitor = makeAnonymousClient(baseUrl);
  const page = await (await visitor.get("/m/legacy-moveout")).text();
  expect(page).toContain("Pre-existing Legacy Lamp");

  // Not in the pool — the whole point of defaulting to unlisted rather than
  // public, so an old page is never silently exposed by this migration.
  const pool = await (await visitor.get("/")).text();
  expect(pool).not.toContain("Pre-existing Legacy Lamp");
});

it("a pre-Crit-11 item migrates to the 'Other' category rather than a guessed one", async () => {
  const owner = makeAnonymousClient(baseUrl);
  const managePage = await (await owner.get("/m/legacy-moveout/manage")).text();
  // This client isn't the recorded creator device, so it gets the
  // not-found/403 view rather than manage — read the category from the
  // database-backed migration check below instead; this call only confirms
  // the route still answers for the legacy id at all (no crash).
  expect([200, 403]).toContain((await owner.get("/m/legacy-moveout/manage")).status);
  void managePage;

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const item = db.prepare("SELECT category FROM items WHERE id = ?").get("legacy-item") as { category: string };
  expect(item.category).toBe("Other");
  db.close();
});

it("the completed application history from before the migration still reads back intact", async () => {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const app = db.prepare("SELECT * FROM applications WHERE id = ?").get("legacy-app") as {
    status: string;
    claimer_nickname: string;
  };
  expect(app.status).toBe("completed");
  expect(app.claimer_nickname).toBe("Legacy Claimer");
  db.close();
});

it("running the migration logic again against the same database is a no-op, not an error", async () => {
  // The server already ran its migration once at startup (beforeAll). This
  // re-invokes node:sqlite directly against the same file with the same
  // ALTER/UPDATE statements db.ts guards with hasColumn/migrationApplied —
  // simulating a second deploy against a volume the first deploy already
  // migrated. Should be silent and change nothing.
  expect(() => {
    execFileSync(process.execPath, ["--experimental-strip-types", "-e", "import('./src/db.ts')"], {
      cwd: new URL("..", import.meta.url).pathname,
      env: { ...process.env, DATA_DIR: dataDir },
    });
  }).not.toThrow();

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const item = db.prepare("SELECT category FROM items WHERE id = ?").get("legacy-item") as { category: string };
  const moveout = db.prepare("SELECT visibility FROM moveouts WHERE id = ?").get("legacy-moveout") as {
    visibility: string;
  };
  expect(item.category).toBe("Other");
  expect(moveout.visibility).toBe("unlisted");
  db.close();
});

// Final-project pickup upgrade: the database seeded in beforeAll predates
// departure_status and reschedule_proposals entirely (it's the pre-Crit-11
// shape). The server's own startup migration (not this test file reaching
// in by hand) is what has to add them without touching the legacy rows
// above — proving the new migration is exactly as additive and re-runnable
// as the Crit 11 ones it sits beside.
it("a pre-existing application migrates to 'not_departed', and the reschedule table exists, with all legacy data intact", async () => {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const app = db.prepare("SELECT departure_status FROM applications WHERE id = ?").get("legacy-app") as {
    departure_status: string;
  };
  expect(app.departure_status).toBe("not_departed");

  // Table exists and is queryable (would throw if the migration hadn't run).
  const count = db.prepare("SELECT COUNT(*) AS n FROM reschedule_proposals").get() as { n: number };
  expect(count.n).toBe(0);

  // Legacy data untouched by this migration.
  const legacyApp = db.prepare("SELECT status, claimer_nickname FROM applications WHERE id = ?").get("legacy-app") as {
    status: string;
    claimer_nickname: string;
  };
  expect(legacyApp.status).toBe("completed");
  expect(legacyApp.claimer_nickname).toBe("Legacy Claimer");
  db.close();
});

// Accounts: the database seeded in beforeAll predates accounts/sessions and
// the *_account_id columns entirely (it's the pre-Crit-11 shape, migrated
// forward through every intermediate round by the server's own startup
// migration above, same as the reschedule columns were). This is what
// proves a real production volume — one that's been live since before
// accounts existed — upgrades cleanly: existing rows keep their device-only
// identity (NULL account columns, not a guessed or backfilled one), new
// tables exist and are queryable, and nothing about the legacy data changes.
it("accounts/sessions tables exist and legacy rows have NULL account columns, not a guessed one", async () => {
  const db = new DatabaseSync(join(dataDir, "moveout.db"));

  // Tables exist and are queryable (would throw otherwise).
  expect((db.prepare("SELECT COUNT(*) AS n FROM accounts").get() as { n: number }).n).toBe(0);
  expect((db.prepare("SELECT COUNT(*) AS n FROM account_sessions").get() as { n: number }).n).toBe(0);

  const moveout = db.prepare("SELECT creator_account_id FROM moveouts WHERE id = ?").get("legacy-moveout") as {
    creator_account_id: string | null;
  };
  expect(moveout.creator_account_id).toBeNull();

  const app = db.prepare("SELECT claimer_account_id FROM applications WHERE id = ?").get("legacy-app") as {
    claimer_account_id: string | null;
  };
  expect(app.claimer_account_id).toBeNull();

  // Legacy data still intact after this round's migration too.
  const legacyMoveout = db.prepare("SELECT title FROM moveouts WHERE id = ?").get("legacy-moveout") as { title: string };
  expect(legacyMoveout.title).toBe("Pre-Crit-11 Page");
  db.close();
});

// A legacy page's creator can still register an account on the SAME device
// that created it, and that one action both creates the account and links
// the pre-existing page to it — proving the claim pass (src/auth.ts
// #claimAnonymousDataForAccount) works against data that predates accounts
// by several migrations, not just data created in the same session as the
// test.
it("the legacy move-out page's original device can register and claim it into a new account", async () => {
  // Drives the register route directly with the exact `device` cookie value
  // seedOldSchema() recorded as "legacy-moveout"'s creator_device_id — the
  // real scenario this proves is "the original browser from years ago,
  // which still has that cookie, registers today."
  const res = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "device=legacy-device" },
    body: new URLSearchParams({ email: "legacy-owner@example.com", password: "legacypassword1" }).toString(),
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toContain("Linked");

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const account = db.prepare("SELECT id FROM accounts WHERE email = ?").get("legacy-owner@example.com") as { id: string };
  expect(account).toBeTruthy();
  const moveout = db.prepare("SELECT creator_account_id FROM moveouts WHERE id = ?").get("legacy-moveout") as {
    creator_account_id: string | null;
  };
  expect(moveout.creator_account_id).toBe(account.id);
  db.close();
});

// Regression: before this round's fix, isCreator correctly recognised the
// original device cookie on an unbound (pre-accounts) page — that's an
// IDENTITY check — but several write routes treated recognition alone as
// authorization, with no separate "is this request actually signed in"
// gate. An anonymous visitor replaying "legacy-moveout-2"'s own
// creator_device_id cookie (exactly like a browser that's had this app
// installed since before accounts existed, and never registered) could
// still add items, timeslots, or change visibility on it forever. This
// fixture is the real scenario the brief asks for: genuine pre-accounts
// data read from the database, not a freshly-created-then-rejected
// anonymous page, which would prove something narrower.
it("1. an old, still-unbound legacy page's own device cookie can no longer publish items without signing in — nothing is written", async () => {
  const beforeItems = (
    new DatabaseSync(join(dataDir, "moveout.db")).prepare("SELECT COUNT(*) AS n FROM items WHERE moveout_id = ?").get("legacy-moveout-2") as { n: number }
  ).n;
  expect(beforeItems).toBe(0);

  const addItemRes = await fetch(new URL("/m/legacy-moveout-2/items", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "device=legacy-device-2" },
    body: new URLSearchParams({ name: "Should never be added", category: "Other" }).toString(),
  });
  expect(addItemRes.status).toBe(302);
  expect(addItemRes.headers.get("location")).toContain("/login");

  const addTimeslotRes = await fetch(new URL("/m/legacy-moveout-2/timeslots", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "device=legacy-device-2" },
    body: new URLSearchParams({ startsAt: "2029-01-01T10:00", endsAt: "2029-01-01T11:00" }).toString(),
  });
  expect(addTimeslotRes.status).toBe(302);
  expect(addTimeslotRes.headers.get("location")).toContain("/login");

  const visibilityRes = await fetch(new URL("/m/legacy-moveout-2/visibility", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "device=legacy-device-2" },
    body: new URLSearchParams({ visibility: "public" }).toString(),
  });
  expect(visibilityRes.status).toBe(302);
  expect(visibilityRes.headers.get("location")).toContain("/login");

  // Nothing was actually written to the database by any of the three
  // rejected attempts above.
  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const afterItems = (db.prepare("SELECT COUNT(*) AS n FROM items WHERE moveout_id = ?").get("legacy-moveout-2") as { n: number }).n;
  expect(afterItems).toBe(0);
  const afterTimeslots = (db.prepare("SELECT COUNT(*) AS n FROM timeslots WHERE moveout_id = ?").get("legacy-moveout-2") as { n: number }).n;
  expect(afterTimeslots).toBe(0);
  const moveout = db.prepare("SELECT visibility FROM moveouts WHERE id = ?").get("legacy-moveout-2") as { visibility: string };
  expect(moveout.visibility).toBe("unlisted");
  db.close();
});

// (2) Once the SAME device registers (claiming this legacy page into an
// account), it can continue to manage it normally — compatibility with old
// data isn't lost by closing the anonymous-write hole above.
it("2. after registering and claiming, the legacy page's original device can continue to manage it normally", async () => {
  const registerRes = await fetch(new URL("/register", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: "device=legacy-device-2" },
    body: new URLSearchParams({ email: "legacy-owner-2@example.com", password: "legacypassword1" }).toString(),
  });
  expect(registerRes.status).toBe(200);
  const cookie = registerRes.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

  const addItemRes = await fetch(new URL("/m/legacy-moveout-2/items", baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie },
    body: new URLSearchParams({ name: "Added after claiming", category: "Other" }).toString(),
  });
  expect(addItemRes.status).toBe(302);
  expect(addItemRes.headers.get("location")).toContain("/manage");

  const managePage = await (await fetch(new URL("/m/legacy-moveout-2/manage", baseUrl), { headers: { Cookie: cookie } })).text();
  expect(managePage).toContain("Added after claiming");
});
