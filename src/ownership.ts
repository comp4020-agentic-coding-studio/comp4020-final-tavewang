import { db, type Application, type Item, type ItemCategory, type Moveout, type RescheduleProposal } from "./db.ts";

export function getMoveout(id: string): Moveout | undefined {
  return db.prepare("SELECT * FROM moveouts WHERE id = ?").get(id) as Moveout | undefined;
}

// Matches if either the requester's device created the page (the original,
// account-free rule) OR the requester is signed into the account that owns
// it (`accountId`, from `c.get("account")?.id` — undefined for an anonymous
// visitor, which never matches a non-null `creator_account_id`). This is
// what lets a different device, once signed into the same account, manage a
// page it didn't itself create — CLAUDE.md's device-identity rule still
// holds for the anonymous case; accounts only ever widen this check, never
// replace or weaken it.
export function isCreator(moveout: Moveout, deviceId: string, accountId?: string): boolean {
  if (moveout.creator_device_id === deviceId) return true;
  return accountId !== undefined && moveout.creator_account_id === accountId;
}

// Same device-OR-account widening as isCreator, for "is this requester the
// claimant on this specific application" — the other half of every
// creator/claimant pair in this app. A claimant who registers or signs in
// on a second device can act on their own request from there exactly as if
// it were the original device.
export function isClaimant(app: Application, deviceId: string, accountId?: string): boolean {
  if (app.claimer_device_id === deviceId) return true;
  return accountId !== undefined && app.claimer_account_id === accountId;
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

export function getPendingReschedule(applicationId: string): RescheduleProposal | undefined {
  return db
    .prepare("SELECT * FROM reschedule_proposals WHERE application_id = ? AND status = 'pending'")
    .get(applicationId) as RescheduleProposal | undefined;
}

export function getReschedule(id: string): RescheduleProposal | undefined {
  return db.prepare("SELECT * FROM reschedule_proposals WHERE id = ?").get(id) as RescheduleProposal | undefined;
}

export interface PendingRescheduleView {
  proposal: RescheduleProposal;
  newTimeslot: import("./db.ts").Timeslot;
  proposedByCreator: boolean;
}

// Resolved view of an application's one-or-zero pending reschedule, for
// rendering on either side (the creator's manage page or the claimant's own
// public page) — both need the same facts: who proposed, the candidate new
// time, and the reason.
export function pendingRescheduleView(applicationId: string, moveout: Moveout): PendingRescheduleView | undefined {
  const proposal = getPendingReschedule(applicationId);
  if (!proposal) return undefined;
  const newTimeslot = db.prepare("SELECT * FROM timeslots WHERE id = ?").get(proposal.new_timeslot_id) as
    | import("./db.ts").Timeslot
    | undefined;
  if (!newTimeslot) return undefined;
  return { proposal, newTimeslot, proposedByCreator: proposal.proposed_by_device_id === moveout.creator_device_id };
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
  moveout_timezone: string;
  timeslot_starts_at: string | null;
}

// For the home page: "your requests" needs to link back to the moveout each
// application belongs to, without the caller having to join it by hand. Also
// carries the confirmed pickup time so "My MoveOut" is a clear entry point
// to it, not just a bare status label the claimant has to click through to
// understand.
export function listApplicationsWithContext(deviceId: string): ApplicationWithContext[] {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, m.id AS moveout_id, m.title AS moveout_title,
              m.timezone AS moveout_timezone, t.starts_at AS timeslot_starts_at
       FROM applications a
       JOIN items i ON i.id = a.item_id
       JOIN moveouts m ON m.id = i.moveout_id
       JOIN timeslots t ON t.id = a.timeslot_id
       WHERE a.claimer_device_id = ?
       ORDER BY a.created_at DESC`,
    )
    .all(deviceId) as unknown as ApplicationWithContext[];
}

// Account-scoped equivalent of listApplicationsWithContext — every request
// sent by ANY device this account has claimed data on, same reasoning as
// listMoveoutsCreatedByAccount above.
export function listApplicationsWithContextForAccount(accountId: string): ApplicationWithContext[] {
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, m.id AS moveout_id, m.title AS moveout_title,
              m.timezone AS moveout_timezone, t.starts_at AS timeslot_starts_at
       FROM applications a
       JOIN items i ON i.id = a.item_id
       JOIN moveouts m ON m.id = i.moveout_id
       JOIN timeslots t ON t.id = a.timeslot_id
       WHERE a.claimer_account_id = ?
       ORDER BY a.created_at DESC`,
    )
    .all(accountId) as unknown as ApplicationWithContext[];
}

export function listMoveoutsCreatedBy(deviceId: string): Moveout[] {
  return db
    .prepare("SELECT * FROM moveouts WHERE creator_device_id = ? ORDER BY created_at DESC")
    .all(deviceId) as unknown as Moveout[];
}

// Account-scoped: every page created by ANY device this account has signed
// into and claimed data on — this is what makes "log in on a new device"
// actually reach a page made on an old one. `creator_account_id` is only
// ever set by src/auth.ts#claimAnonymousDataForAccount or at creation time
// while already signed in, never by anything a client sends directly.
export function listMoveoutsCreatedByAccount(accountId: string): Moveout[] {
  return db
    .prepare("SELECT * FROM moveouts WHERE creator_account_id = ? ORDER BY created_at DESC")
    .all(accountId) as unknown as Moveout[];
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
