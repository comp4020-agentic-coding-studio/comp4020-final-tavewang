import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type Visibility = "public" | "unlisted";

export interface Moveout {
  id: string;
  title: string;
  area: string;
  pickup_location: string;
  deadline_at: string; // UTC ISO
  timezone: string;
  creator_device_id: string;
  creator_nickname: string;
  visibility: Visibility;
  created_at: string;
}

export interface Timeslot {
  id: string;
  moveout_id: string;
  starts_at: string; // UTC ISO
  ends_at: string; // UTC ISO
  created_at: string;
}

export type ItemStatus = "open" | "reserved" | "handed_over" | "withdrawn";

// Fixed set (CLAUDE.md): a category belongs to the item, not the move-out
// page — one page can list a lamp (Furniture) and a textbook (Books & Study).
// "Other" is also the default for items that existed before Crit 11 added
// this column; migrating them to a guessed category would be putting words
// in the original poster's mouth, not a neutral default.
export const ITEM_CATEGORIES = [
  "Furniture",
  "Kitchen",
  "Electronics",
  "Books & Study",
  "Clothing",
  "Household",
  "Sports & Outdoors",
  "Other",
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

export function isItemCategory(value: string): value is ItemCategory {
  return (ITEM_CATEGORIES as readonly string[]).includes(value);
}

export interface Item {
  id: string;
  moveout_id: string;
  name: string;
  category: ItemCategory;
  photo_path: string | null;
  condition_notes: string | null;
  additional_notes: string | null;
  status: ItemStatus;
  created_at: string;
}

export type ApplicationStatus = "pending" | "confirmed" | "cancelled" | "completed";

export interface Application {
  id: string;
  item_id: string;
  timeslot_id: string;
  claimer_device_id: string;
  claimer_nickname: string;
  note: string | null;
  status: ApplicationStatus;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  created_at: string;
}

const dataDir = process.env.DATA_DIR ?? "./data";
mkdirSync(dataDir, { recursive: true });
mkdirSync(join(dataDir, "uploads"), { recursive: true });

export const uploadsDir = join(dataDir, "uploads");

// A distinct filename from Fridge Rescue's "app.db" on purpose: the Fly
// volume is the same one that direction used (same app, same /data), and its
// old "app.db" still has a Fridge-Rescue-shaped `items` table with no
// `moveout_id` column. `CREATE TABLE IF NOT EXISTS` would silently keep that
// incompatible table rather than fail loudly, so MoveOut gets its own file
// instead of attempting a migration of data that belonged to a different,
// abandoned application. Discovered as a crash on the first post-pivot
// deploy (see PROCESS.md) and fixed this way rather than hand-editing the
// live volume.
export const db = new DatabaseSync(join(dataDir, "moveout.db"));
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

// items.status and applications.status are deliberately separate columns
// (not one combined field) — an item can have several applications over its
// life, only ever one of them active, and the item's own status (reserved /
// handed over / withdrawn) outlives any single application's row.
db.exec(`
  CREATE TABLE IF NOT EXISTS moveouts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    area TEXT NOT NULL,
    pickup_location TEXT NOT NULL,
    deadline_at TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
    creator_device_id TEXT NOT NULL,
    creator_nickname TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS timeslots (
    id TEXT PRIMARY KEY,
    moveout_id TEXT NOT NULL REFERENCES moveouts(id),
    starts_at TEXT NOT NULL,
    ends_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    moveout_id TEXT NOT NULL REFERENCES moveouts(id),
    name TEXT NOT NULL,
    photo_path TEXT,
    condition_notes TEXT,
    additional_notes TEXT,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reserved', 'handed_over', 'withdrawn')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS applications (
    id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL REFERENCES items(id),
    timeslot_id TEXT NOT NULL REFERENCES timeslots(id),
    claimer_device_id TEXT NOT NULL,
    claimer_nickname TEXT NOT NULL,
    note TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'cancelled', 'completed')),
    confirmed_at TEXT,
    cancelled_at TEXT,
    cancel_reason TEXT,
    completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS items_moveout_idx ON items (moveout_id, status);
  CREATE INDEX IF NOT EXISTS applications_item_idx ON applications (item_id, status);

  -- The uniqueness rule lives in the schema, not in application code: a
  -- device can hold at most one active (pending or confirmed) application
  -- per item, but may re-apply after cancelling.
  CREATE UNIQUE INDEX IF NOT EXISTS applications_one_active_per_device
    ON applications (item_id, claimer_device_id)
    WHERE status IN ('pending', 'confirmed');
`);

// Crit 11: the browse pool. Two additive, re-runnable migrations — never a
// DROP or a rebuild — so this is safe to run against a volume that already
// has Crit 7-10 data on it. `schema_migrations` guards the one-time *data*
// backfill (visibility defaulting existing pages to 'unlisted'); the column
// adds themselves are guarded by inspecting the live schema instead, since
// `ALTER TABLE ADD COLUMN` has no `IF NOT EXISTS` in SQLite.
function hasColumn(table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[];
  return columns.some((c) => c.name === column);
}

function migrationApplied(name: string): boolean {
  return db.prepare("SELECT 1 FROM schema_migrations WHERE name = ?").get(name) !== undefined;
}

function markMigrationApplied(name: string): void {
  db.prepare("INSERT OR IGNORE INTO schema_migrations (name) VALUES (?)").run(name);
}

if (!hasColumn("moveouts", "visibility")) {
  // New pages default to 'public' at the INSERT site (src/routes/home.ts),
  // not here — this column add only has to supply a value for rows that
  // already exist. The 'unlisted' default here is what keeps a pre-Crit-11
  // move-out page out of the public pool the instant this migration runs,
  // before its creator has ever seen or chosen a visibility setting.
  db.exec("ALTER TABLE moveouts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'unlisted' CHECK (visibility IN ('public', 'unlisted'))");
}
if (!migrationApplied("backfill_visibility_unlisted")) {
  // Belt-and-braces alongside the DEFAULT above: makes the intent explicit
  // (every pre-existing page is unlisted, full stop) and gives this backfill
  // its own idempotency marker independent of the column's existence, in
  // case a future migration ever changes that default.
  db.exec("UPDATE moveouts SET visibility = 'unlisted' WHERE visibility IS NULL");
  markMigrationApplied("backfill_visibility_unlisted");
}

if (!hasColumn("items", "category")) {
  const categoryList = ITEM_CATEGORIES.map((c) => `'${c.replace(/'/g, "''")}'`).join(",");
  db.exec(
    `ALTER TABLE items ADD COLUMN category TEXT NOT NULL DEFAULT 'Other' CHECK (category IN (${categoryList}))`,
  );
}

db.exec(`
  CREATE INDEX IF NOT EXISTS moveouts_visibility_idx ON moveouts (visibility, deadline_at);
  CREATE INDEX IF NOT EXISTS items_category_idx ON items (category, status);
`);

// Wraps a set of statements in a transaction. Node's single-threaded event
// loop plus node:sqlite's synchronous calls mean no other request's
// statements can interleave inside this block, so this is as much about
// atomicity (all-or-nothing on a thrown error) as it is about concurrency —
// the concurrency guarantee itself comes from each guarded UPDATE's WHERE
// clause (see routes/applications.ts).
export function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
