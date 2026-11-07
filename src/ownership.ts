import { db, type Application, type Item, type ItemCategory, type Moveout, type RescheduleProposal } from "./db.ts";

export function getMoveout(id: string): Moveout | undefined {
  return db.prepare("SELECT * FROM moveouts WHERE id = ?").get(id) as Moveout | undefined;
}

// The ownership rule, stated once and shared by every *_account_id /
// *_device_id pair in this app (moveouts.creator_*, applications.claimer_*,
// reschedule_proposals.proposed_by_*):
//
//   - Once an entity is bound to an account (`entityAccountId !== null`),
//     identity is ACCOUNT-ONLY. The device id that originally created it is
//     no longer a valid credential for it, even from the literal original
//     browser — only a live session signed into that exact account counts.
//   - Until it's bound (`entityAccountId === null`), identity is still
//     device-only, exactly as the app worked before accounts existed. This
//     is what preserves legacy-data recognition and lets an unclaimed page
//     be found and claimed at all.
//
// This used to be an OR (device match alone was always sufficient, with
// account as an extra alternative) — a real vulnerability: signing out
// (deleting the session row) never revoked the separate, independent
// `device` cookie, so anyone who kept that cookie — including the original
// creator after logging out, or anyone who copied it — could still pass
// `creator_device_id === deviceId` and manage data that had since been
// claimed into an account. Binding an entity to an account must REPLACE its
// device-based authorization, not sit alongside it.
function matchesOwner(entityAccountId: string | null, entityDeviceId: string, deviceId: string, accountId: string | undefined): boolean {
  if (entityAccountId !== null) return accountId !== undefined && accountId === entityAccountId;
  return entityDeviceId === deviceId;
}

export function isCreator(moveout: Moveout, deviceId: string, accountId?: string): boolean {
  return matchesOwner(moveout.creator_account_id, moveout.creator_device_id, deviceId, accountId);
}

// Same account-replaces-device rule as isCreator, for "is this requester the
// claimant on this specific application" — the other half of every
// creator/claimant pair in this app.
export function isClaimant(app: Application, deviceId: string, accountId?: string): boolean {
  return matchesOwner(app.claimer_account_id, app.claimer_device_id, deviceId, accountId);
}

// Whether the CURRENT requester (deviceId/accountId) is the same party that
// made a given reschedule proposal — the reschedule routes' own "is this
// mine" check, same account-replaces-device rule, extracted here so
// src/routes/reschedule.ts doesn't keep its own divergent copy of this logic
// (it used to, and the two were a correctness risk waiting to drift apart).
export function isProposer(proposal: RescheduleProposal, deviceId: string, accountId?: string): boolean {
  return matchesOwner(proposal.proposed_by_account_id, proposal.proposed_by_device_id, deviceId, accountId);
}

// Whether two STORED identities (not "the current requester vs a stored
// row" — two historical actors, e.g. "who proposed this" vs "who created
// the page") refer to the same party, under the same account-replaces-
// device rule. Needed because once either side is account-bound, comparing
// their device ids directly is meaningless — only matching accounts (or,
// when both are still unbound, matching devices) counts as "the same
// person."
function sameOwner(aDeviceId: string, aAccountId: string | null, bDeviceId: string, bAccountId: string | null): boolean {
  if (aAccountId !== null || bAccountId !== null) return aAccountId !== null && bAccountId !== null && aAccountId === bAccountId;
  return aDeviceId === bDeviceId;
}

// A SQL fragment implementing the same account-replaces-device rule as
// matchesOwner, for queries that can't call a JS predicate per row (e.g.
// "every application the current requester may see on this move-out page").
// `prefix` is the table alias (e.g. "a" for applications), matching that
// alias's `claimer_device_id`/`claimer_account_id` (or
// `creator_device_id`/`creator_account_id`) columns. Returns the WHERE
// fragment and its three bound params, in order.
export function ownerMatchSql(prefix: string, kind: "claimer" | "creator"): { sql: string; bind: (deviceId: string, accountId: string | null) => [string, string | null, string | null] } {
  const deviceCol = `${prefix}.${kind}_device_id`;
  const accountCol = `${prefix}.${kind}_account_id`;
  return {
    // Unbound (accountCol IS NULL): device must match.
    // Bound (accountCol IS NOT NULL): the requester's account must match it
    // — device is never consulted once bound, by design (see matchesOwner).
    sql: `((${accountCol} IS NULL AND ${deviceCol} = ?) OR (${accountCol} IS NOT NULL AND ? IS NOT NULL AND ${accountCol} = ?))`,
    bind: (deviceId, accountId) => [deviceId, accountId, accountId],
  };
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
  // Display only ("who proposed this"), but still has to use the same
  // account-replaces-device rule as every authorization check — otherwise,
  // once the page is account-bound, a creator proposing from their account
  // would be mislabelled as "not the creator" here even though they ARE the
  // authorized creator everywhere else.
  const proposedByCreator = sameOwner(
    proposal.proposed_by_device_id,
    proposal.proposed_by_account_id,
    moveout.creator_device_id,
    moveout.creator_account_id,
  );
  return { proposal, newTimeslot, proposedByCreator };
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

// This device's own still-unclaimed (claimer_account_id IS NULL) active
// applications — used only to show a signing-in visitor exactly which of
// their own requests didn't get linked because of a conflict with their
// account's existing request for the same item
// (src/auth.ts#claimAnonymousDataForAccount), with enough context (item
// name, moveout id) to link straight to the page where they can resolve it.
// Deliberately NOT scoped to "pending"/"confirmed" only — a device's
// already-cancelled or completed history has no bearing on a fresh
// conflict, but this helper is only ever called with the specific ids the
// claim pass just reported as conflicted, so the caller already knows which
// rows matter.
export function getApplicationsWithContext(applicationIds: string[]): ApplicationWithContext[] {
  if (applicationIds.length === 0) return [];
  const placeholders = applicationIds.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT a.*, i.name AS item_name, m.id AS moveout_id, m.title AS moveout_title,
              m.timezone AS moveout_timezone, t.starts_at AS timeslot_starts_at
       FROM applications a
       JOIN items i ON i.id = a.item_id
       JOIN moveouts m ON m.id = i.moveout_id
       JOIN timeslots t ON t.id = a.timeslot_id
       WHERE a.id IN (${placeholders})
       ORDER BY a.created_at DESC`,
    )
    .all(...applicationIds) as unknown as ApplicationWithContext[];
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
