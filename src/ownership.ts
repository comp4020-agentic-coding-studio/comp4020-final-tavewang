import { db, type Application, type Item, type ItemCategory, type Moveout } from "./db.ts";

export function getMoveout(id: string): Moveout | undefined {
  return db.prepare("SELECT * FROM moveouts WHERE id = ?").get(id) as Moveout | undefined;
}

export function isCreator(moveout: Moveout, deviceId: string): boolean {
  return moveout.creator_device_id === deviceId;
}

export function getItem(id: string): Item | undefined {
  return db.prepare("SELECT * FROM items WHERE id = ?").get(id) as Item | undefined;
}

export function getApplication(id: string): Application | undefined {
  return db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Application | undefined;
}

export function listItems(moveoutId: string): Item[] {
  return db.prepare("SELECT * FROM items WHERE moveout_id = ? ORDER BY created_at").all(moveoutId) as unknown as Item[];
}

export function listTimeslots(moveoutId: string) {
  return db
    .prepare("SELECT * FROM timeslots WHERE moveout_id = ? ORDER BY starts_at")
    .all(moveoutId) as unknown as import("./db.ts").Timeslot[];
}

export function listApplicationsForItem(itemId: string): Application[] {
  return db
    .prepare("SELECT * FROM applications WHERE item_id = ? ORDER BY created_at")
    .all(itemId) as unknown as Application[];
}

export function listApplicationsForDevice(deviceId: string): Application[] {
  return db
    .prepare("SELECT * FROM applications WHERE claimer_device_id = ? ORDER BY created_at DESC")
    .all(deviceId) as unknown as Application[];
}

export interface ApplicationWithContext extends Application {
  item_name: string;
  moveout_id: string;
  moveout_title: string;
}

// For the home page: "your requests" needs to link back to the moveout each
// application belongs to, without the caller having to join it by hand.
export function listApplicationsWithContext(deviceId: string): ApplicationWithContext[] {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, m.id AS moveout_id, m.title AS moveout_title
       FROM applications a
       JOIN items i ON i.id = a.item_id
       JOIN moveouts m ON m.id = i.moveout_id
       WHERE a.claimer_device_id = ?
       ORDER BY a.created_at DESC`,
    )
    .all(deviceId) as unknown as ApplicationWithContext[];
}

export function listMoveoutsCreatedBy(deviceId: string): Moveout[] {
  return db
    .prepare("SELECT * FROM moveouts WHERE creator_device_id = ? ORDER BY created_at DESC")
    .all(deviceId) as unknown as Moveout[];
}

// ---- Crit 11: the public browse pool -------------------------------------
// Every query here is scoped server-side to exactly what's allowed to be
// public — `visibility = 'public'` and `status = 'open'` are WHERE clauses
// on the query itself, never a filter applied to an already-fetched,
// broader result. There is no code path that reads an unlisted page's items
// or a withdrawn/reserved/handed-over item and relies on the view layer to
// hide it (CLAUDE.md).

export type BrowseSort = "newest" | "deadline";

export interface BrowseItemRow extends Item {
  moveout_title: string;
  moveout_area: string;
  moveout_deadline_at: string;
  moveout_timezone: string;
}

export interface BrowseQuery {
  search?: string;
  category?: ItemCategory;
  sort?: BrowseSort;
  limit?: number;
  offset?: number;
}

// shortcut: offset pagination, not a keyset cursor — simple, and at this
// app's realistic scale (one course's worth of move-outs) a page is never
// deep enough for the O(offset) scan to matter. Revisit if the pool ever
// holds enough concurrent public items that "page 40" becomes a real request.
const BROWSE_DEFAULT_LIMIT = 24;
const BROWSE_MAX_LIMIT = 100;

export function countBrowseItems(query: BrowseQuery): number {
  const { whereSql, params } = browseWhere(query);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM items i JOIN moveouts m ON m.id = i.moveout_id WHERE ${whereSql}`,
    )
    .get(...params) as unknown as { n: number };
  return row.n;
}

export function listBrowseItems(query: BrowseQuery): BrowseItemRow[] {
  const { whereSql, params } = browseWhere(query);
  const limit = Math.min(Math.max(query.limit ?? BROWSE_DEFAULT_LIMIT, 1), BROWSE_MAX_LIMIT);
  const offset = Math.max(query.offset ?? 0, 0);
  const orderSql = query.sort === "deadline" ? "m.deadline_at ASC" : "i.created_at DESC";
  return db
    .prepare(
      `SELECT i.*, m.title AS moveout_title, m.area AS moveout_area,
              m.deadline_at AS moveout_deadline_at, m.timezone AS moveout_timezone
       FROM items i JOIN moveouts m ON m.id = i.moveout_id
       WHERE ${whereSql}
       ORDER BY ${orderSql}
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as BrowseItemRow[];
}

// Builds the shared WHERE clause + bound params for both the count and the
// page query, so the two can never drift out of sync with each other.
// `search` only ever matches the item's name and its own public condition
// notes — never an application's note, a claimant's nickname, or any
// pickup-location text (CLAUDE.md: those never reach a public query at all).
function browseWhere(query: BrowseQuery): { whereSql: string; params: (string | number)[] } {
  const now = new Date().toISOString();
  const clauses = [
    "m.visibility = 'public'",
    "i.status = 'open'",
    "m.deadline_at > ?",
  ];
  const params: (string | number)[] = [now];

  if (query.category) {
    clauses.push("i.category = ?");
    params.push(query.category);
  }
  const search = query.search?.trim();
  if (search) {
    clauses.push("(i.name LIKE ? ESCAPE '\\' OR i.condition_notes LIKE ? ESCAPE '\\' OR i.additional_notes LIKE ? ESCAPE '\\')");
    const escaped = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    params.push(escaped, escaped, escaped);
  }
  return { whereSql: clauses.join(" AND "), params };
}
