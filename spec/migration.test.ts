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
import { makeClient } from "./helpers.ts";

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
  const visitor = makeClient(baseUrl);
  const page = await (await visitor.get("/m/legacy-moveout")).text();
  expect(page).toContain("Pre-existing Legacy Lamp");

  // Not in the pool — the whole point of defaulting to unlisted rather than
  // public, so an old page is never silently exposed by this migration.
  const pool = await (await visitor.get("/")).text();
  expect(pool).not.toContain("Pre-existing Legacy Lamp");
});

it("a pre-Crit-11 item migrates to the 'Other' category rather than a guessed one", async () => {
  const owner = makeClient(baseUrl);
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
