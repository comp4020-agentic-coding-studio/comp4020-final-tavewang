import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export interface Moveout {
  id: string;
  title: string;
  area: string;
  pickup_location: string;
  deadline_at: string; // UTC ISO
  timezone: string;
  creator_device_id: string;
  creator_nickname: string;
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

export interface Item {
  id: string;
  moveout_id: string;
  name: string;
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

export const db = new DatabaseSync(join(dataDir, "app.db"));
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
