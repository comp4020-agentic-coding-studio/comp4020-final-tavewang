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
  // Nullable: most pages still belong to an anonymous device only. Set once
  // the creating device is signed in, at creation time or by the one-time
  // claim-on-login pass (src/auth.ts#claimAnonymousDataForAccount) — never
  // cleared back to NULL once set, since "this page belongs to account X"
  // is a one-way fact once true.
  creator_account_id: string | null;
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

// The claimant's own travel state toward a confirmed pickup — independent of
// applications.status (CLAUDE.md: don't collapse separate lifecycles into one
// field). "Arrived" is not "handed over": the actual handover is still the
// creator's existing complete action.
export type DepartureStatus = "not_departed" | "departed" | "arrived";

export interface Application {
  id: string;
  item_id: string;
  timeslot_id: string;
  claimer_device_id: string;
  claimer_nickname: string;
  note: string | null;
  status: ApplicationStatus;
  departure_status: DepartureStatus;
  confirmed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  created_at: string;
  // Same nullable, one-way-settable shape as moveouts.creator_account_id —
  // see that field's comment.
  claimer_account_id: string | null;
}

// An account is an email + password credential that a device can sign into,
// layered ON TOP OF the existing device-cookie identity — never a
// replacement for it. A visitor who never registers behaves exactly as
// before. `password_hash` is scrypt output, never a plaintext password or a
// reversible encoding of one (CLAUDE.md-style rule: never store what you
// wouldn't want to see in a leak).
export interface Account {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
}

// A server-side, revocable login session — the cookie carries only this
// row's unguessable id, never the account id or password hash directly, so
// "sign out" (deleting the row) makes that cookie value immediately useless
// even if an attacker already has it. Session rows, like src/live.ts's
// in-memory subscriber lists, are transport/auth state, but UNLIKE those —
// a revoked session must survive a server restart, so this one lives in
// SQLite, not memory.
export interface AccountSession {
  id: string;
  account_id: string;
  created_at: string;
}

// A proposal to move a CONFIRMED booking to a different timeslot already on
// the same move-out page — never a second, parallel timeslot system. At most
// one 'pending' proposal may exist per application at a time (enforced by the
// partial unique index below, the same pattern as
// applications_one_active_per_device).
export type RescheduleStatus = "pending" | "accepted" | "declined" | "withdrawn" | "invalidated";

export interface RescheduleProposal {
  id: string;
  application_id: string;
  proposed_by_device_id: string;
  proposed_by_account_id: string | null;
  new_timeslot_id: string;
  reason: string | null;
  status: RescheduleStatus;
  created_at: string;
  resolved_at: string | null;
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

  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS account_sessions (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS account_sessions_account_idx ON account_sessions (account_id);

  CREATE INDEX IF NOT EXISTS items_moveout_idx ON items (moveout_id, status);
  CREATE INDEX IF NOT EXISTS applications_item_idx ON applications (item_id, status);
`);
// `applications_one_active_per_device` (one active application per item per
// DEVICE) used to be created right here, unconditionally, on every single
// startup — including ones where `applications_one_active_per_identity`
// (the account-scoped successor, created further down) had already fully
// replaced it. That was a real bug, found this round: this `CREATE TABLE
// IF NOT EXISTS .. db.exec(...)` block runs before the one-time migration
// below gets anywhere near dropping the old index, so on an already-
// migrated database holding data the account-scoped rule correctly
// allows — e.g. two different accounts each independently applying for the
// same item, which never violates `applications_one_active_per_identity`
// — this unconditional `CREATE UNIQUE INDEX` for the OLD, device-only rule
// found that same data violating ITS narrower rule and failed outright,
// taking the whole server down before it could reach the code that would
// have dropped this index. The old index is created ONLY below, inside the
// one-time migration, and only for a database that doesn't already have the
// new one — never unconditionally at every startup.

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

// Final-project pickup upgrade: departure status + mutual reschedule. Both
// additive and re-runnable, same pattern as the Crit 11 migrations above —
// never a DROP or rebuild, safe against a volume that already has Crit 1-11
// data on it.
if (!hasColumn("applications", "departure_status")) {
  // Every pre-existing application (and every new one on an application that
  // isn't yet confirmed) defaults to 'not_departed' — nobody's status is
  // invented by this migration, it's just the correct starting point for a
  // claimant who hasn't set anything yet.
  db.exec(
    `ALTER TABLE applications ADD COLUMN departure_status TEXT NOT NULL DEFAULT 'not_departed'
     CHECK (departure_status IN ('not_departed', 'departed', 'arrived'))`,
  );
}

// Accounts: two additive, nullable columns linking a moveout/application
// back to the account that owns the device that created/claimed it — never
// a replacement for the existing *_device_id columns, which remain the
// source of truth for "whose browser did this." A pre-existing row has
// NULL here (nobody claimed it into an account yet), which is correct, not
// a gap to backfill: there's no account to guess it into.
if (!hasColumn("moveouts", "creator_account_id")) {
  db.exec("ALTER TABLE moveouts ADD COLUMN creator_account_id TEXT REFERENCES accounts(id)");
}
if (!hasColumn("applications", "claimer_account_id")) {
  db.exec("ALTER TABLE applications ADD COLUMN claimer_account_id TEXT REFERENCES accounts(id)");
}
db.exec(`
  CREATE INDEX IF NOT EXISTS moveouts_creator_account_idx ON moveouts (creator_account_id);
  CREATE INDEX IF NOT EXISTS applications_claimer_account_idx ON applications (claimer_account_id);
`);

// A real bug, found this round: `applications_one_active_per_device` only
// ever scoped uniqueness to (item_id, claimer_device_id) — so once accounts
// existed, the SAME account signed into two different devices could submit
// two independently-valid, non-duplicate-looking active applications for
// the same item, because each had its own distinct device id. The intended
// rule (CLAUDE.md) is one active request per PARTY, and a party is an
// account once it has one, not a device — exactly the identity rule
// src/ownership.ts#matchesOwner already uses for authorization, now also
// enforced at the database level for this invariant.
//
// Migration order matters: any pre-existing duplicate rows (two active
// applications from the same account on the same item, created before this
// fix existed) must be resolved — not deleted — before the new unique index
// can even be created, since SQLite refuses to build a UNIQUE index over
// data that already violates it. `dedupeDuplicateAccountApplications` runs
// exactly once (guarded by schema_migrations, not by "does the index already
// exist", so a volume that already has the index can't skip a dedup pass it
// still needs if somehow re-run against older data) and keeps a record of
// every row it touches: the winning application's status/timeslot is
// untouched, and every other active row for that (item, account) pair is
// CANCELLED (never deleted) with a specific, auditable reason — preserving
// its id, its history, and its link to the account that made it.
function dedupeDuplicateAccountApplications(): void {
  const duplicateGroups = db
    .prepare(
      `SELECT item_id, claimer_account_id FROM applications
       WHERE status IN ('pending', 'confirmed') AND claimer_account_id IS NOT NULL
       GROUP BY item_id, claimer_account_id
       HAVING COUNT(*) > 1`,
    )
    .all() as unknown as { item_id: string; claimer_account_id: string }[];

  for (const group of duplicateGroups) {
    const activeApps = db
      .prepare(
        `SELECT id, status, created_at FROM applications
         WHERE item_id = ? AND claimer_account_id = ? AND status IN ('pending', 'confirmed')
         ORDER BY (status = 'confirmed') DESC, created_at ASC`,
      )
      .all(group.item_id, group.claimer_account_id) as unknown as { id: string; status: string; created_at: string }[];
    // Keep exactly one: the confirmed one if there is one (an item can only
    // ever have a single confirmed application at a time, so there's never
    // more than one to prefer), otherwise the oldest pending request — the
    // same "first request wins" principle a human reading the history would
    // expect, never a random pick.
    const [winner, ...losers] = activeApps;
    for (const loser of losers) {
      db.prepare(
        `UPDATE applications SET status = 'cancelled', cancelled_at = datetime('now'),
         cancel_reason = 'Automatically closed: this account already had another active request for this item from a different device.'
         WHERE id = ? AND status IN ('pending', 'confirmed')`,
      ).run(loser.id);
    }
    void winner;
  }
}

if (!migrationApplied("dedupe_account_duplicate_applications")) {
  withTransaction(() => {
    dedupeDuplicateAccountApplications();
  });
  markMigrationApplied("dedupe_account_duplicate_applications");
}

// Supersedes applications_one_active_per_device: COALESCE(account, device)
// means an unbound application is still scoped by device alone (unchanged
// behaviour for pre-accounts data), while a bound one is scoped by account
// regardless of which device sent it — closing the cross-device duplicate-
// apply gap without weakening the existing device-level rule for anyone who
// hasn't signed in.
db.exec("DROP INDEX IF EXISTS applications_one_active_per_device");
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS applications_one_active_per_identity
    ON applications (item_id, COALESCE(claimer_account_id, claimer_device_id))
    WHERE status IN ('pending', 'confirmed');
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS reschedule_proposals (
    id TEXT PRIMARY KEY,
    application_id TEXT NOT NULL REFERENCES applications(id),
    proposed_by_device_id TEXT NOT NULL,
    new_timeslot_id TEXT NOT NULL REFERENCES timeslots(id),
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'withdrawn', 'invalidated')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    resolved_at TEXT
  );

  CREATE INDEX IF NOT EXISTS reschedule_application_idx ON reschedule_proposals (application_id, status);

  -- At most one pending proposal per application at a time — mirrors
  -- applications_one_active_per_device's pattern of putting the invariant in
  -- the schema, not just application code.
  CREATE UNIQUE INDEX IF NOT EXISTS reschedule_one_pending_per_application
    ON reschedule_proposals (application_id)
    WHERE status = 'pending';
`);

// reschedule_proposals already existed before accounts, so its own
// account_id column needs the same ALTER-after-CREATE treatment as
// moveouts/applications above, not a column baked into the CREATE TABLE —
// that statement above runs unconditionally every startup and would error
// re-adding a column SQLite already added on a previous run.
if (!hasColumn("reschedule_proposals", "proposed_by_account_id")) {
  db.exec("ALTER TABLE reschedule_proposals ADD COLUMN proposed_by_account_id TEXT REFERENCES accounts(id)");
}

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
