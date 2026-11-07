import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db, withTransaction, type Account } from "./db.ts";
import { newId } from "./ids.ts";

// Accounts sit ON TOP OF the existing anonymous device-cookie identity
// (src/session.ts): a device that never signs in, and whose data is never
// claimed, behaves exactly as before. But once an entity (a move-out page,
// an application) is claimed into an account, that account becomes the ONLY
// valid credential for it — the device id that originally created it stops
// counting, even from the same literal browser. src/ownership.ts's
// `isCreator`/`isClaimant` enforce this; this file is what performs the
// one-time, one-way claim that flips an entity from "device-owned" to
// "account-owned."

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt, not bcrypt/argon2: no extra dependency (node:crypto ships it),
// and this app's realistic load (a handful of logins per crit, never a
// credential-stuffing target) doesn't need argon2's tuned memory-hardness.
// Salt is stored alongside the hash in one column (`salt:hash`, both hex)
// rather than a second column — one field to migrate, one field to compare.
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

// Constant-time comparison (timingSafeEqual) — a naive `===` on the derived
// hash would let a timing attack narrow down the password byte by byte.
export function verifyPassword(password: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Case-insensitive, trimmed — "Sam@Example.com" and "sam@example.com" are
// the same account, matching how every real mail provider treats the
// domain and most treat the local part. Stored normalised so the UNIQUE
// constraint actually catches a duplicate signup.
export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function getAccountByEmail(email: string): Account | undefined {
  return db.prepare("SELECT * FROM accounts WHERE email = ?").get(normalizeEmail(email)) as Account | undefined;
}

export function getAccountById(id: string): Account | undefined {
  return db.prepare("SELECT * FROM accounts WHERE id = ?").get(id) as Account | undefined;
}

export interface CreateAccountResult {
  ok: boolean;
  account?: Account;
  error?: string;
}

export function createAccount(email: string, password: string): CreateAccountResult {
  const normalized = normalizeEmail(email);
  if (!isValidEmail(normalized)) return { ok: false, error: "That doesn't look like a valid email address." };
  if (password.length < 8) return { ok: false, error: "Password must be at least 8 characters." };

  const id = newId();
  const passwordHash = hashPassword(password);
  try {
    db.prepare("INSERT INTO accounts (id, email, password_hash) VALUES (?, ?, ?)").run(id, normalized, passwordHash);
  } catch (err) {
    const isUniqueConstraint = err instanceof Error && "errcode" in err && (err as { errcode?: number }).errcode === 2067;
    if (!isUniqueConstraint) throw err;
    return { ok: false, error: "An account with that email already exists." };
  }
  return { ok: true, account: getAccountById(id) };
}

// Returns the account on a correct email+password, or undefined — never
// distinguishes "no such email" from "wrong password" to the caller, so a
// route can give one generic rejection message without an email-enumeration
// side channel.
export function verifyLogin(email: string, password: string): Account | undefined {
  const account = getAccountByEmail(email);
  if (!account) return undefined;
  return verifyPassword(password, account.password_hash) ? account : undefined;
}

// ---- Server-side, revocable sessions ---------------------------------
// The cookie carries only this row's id — an unguessable random token, not
// the account id itself — so stealing the cookie value is exactly as bad as
// stealing a session id anywhere else (revocable by deleting the row), and
// nothing about the account is recoverable from the cookie alone without a
// database lookup.

export function createSession(accountId: string): string {
  const id = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO account_sessions (id, account_id) VALUES (?, ?)").run(id, accountId);
  return id;
}

// Looks up the account for a session id, or undefined if the session was
// never created, already signed out of (deleted), or the id is garbage. A
// stale/forged session id is indistinguishable from "not signed in" — never
// leaks whether a given session id format was ever valid.
export function accountForSession(sessionId: string | undefined): Account | undefined {
  if (!sessionId) return undefined;
  const row = db
    .prepare(
      `SELECT a.* FROM account_sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?`,
    )
    .get(sessionId) as Account | undefined;
  return row;
}

// Deletes the row — this is what makes "sign out" actually revoke the
// cookie's value server-side, not just ask the browser nicely to forget it.
// Idempotent: signing out twice (e.g. two tabs) is not an error.
export function destroySession(sessionId: string): void {
  db.prepare("DELETE FROM account_sessions WHERE id = ?").run(sessionId);
}

// For the sign-in page's "you have old data waiting" notice: whether THIS
// device has any still-unclaimed (account_id IS NULL) rows at all — a
// count, never which pages or what they contain, since this is shown to a
// visitor before they've proven who they are. Having unclaimed data on this
// device never grants access to anything already bound to an account (that
// decision is entirely isCreator/isClaimant's, downstream of actually
// signing in) — this is purely informational.
export function hasUnclaimedAnonymousData(deviceId: string): boolean {
  const moveout = db.prepare("SELECT 1 FROM moveouts WHERE creator_device_id = ? AND creator_account_id IS NULL LIMIT 1").get(deviceId);
  if (moveout) return true;
  const application = db.prepare("SELECT 1 FROM applications WHERE claimer_device_id = ? AND claimer_account_id IS NULL LIMIT 1").get(deviceId);
  return Boolean(application);
}

// ---- Claiming anonymous data into an account on login/register --------
// The device that just signed in (or just registered) may already have
// anonymous move-out pages and applications tied only to its device cookie.
// This is the one-time, one-way pass that associates them with the account
// — it only ever touches rows this SPECIFIC device already owned (matched
// by creator_device_id / claimer_device_id, never by anything the client
// could otherwise influence), and only rows not already claimed by a
// DIFFERENT account (so logging into account B on a device that previously
// claimed data for account A can't silently reassign A's data to B).
export interface ClaimResult {
  moveouts: number;
  applications: number;
  rescheduleProposals: number;
  // A real bug, found this round: claiming an application can collide with
  // `applications_one_active_per_identity` (src/db.ts) when the signing-in
  // ACCOUNT already has its own active (pending/confirmed) application for
  // the exact same item, submitted from a different device — e.g. account A
  // already applied for Item X from device 1, and THIS device has its own,
  // still-unclaimed, pre-existing application for that same Item X. Before
  // this fix, that one row's UNIQUE-constraint violation threw out of the
  // whole claim transaction uncaught, taking down the entire login/register
  // request with a 500 — correct credentials, no login at all. Each
  // application is now claimed inside its own SAVEPOINT, so one row's
  // conflict only skips THAT row (left exactly as it was — still device-
  // owned, still fully reachable and manageable from this same anonymous
  // device, since it was never touched) without aborting any other row's
  // claim or the session being created. This count is how many rows hit
  // that specific conflict and were deliberately left unclaimed — never
  // silently dropped, never auto-cancelled, and `hasUnclaimedAnonymousData`
  // will keep reporting them until the conflict is resolved (e.g. by
  // cancelling one of the two competing requests) and this device signs in
  // again.
  conflictedApplications: number;
  // The specific row ids that hit that conflict — so the confirmation page
  // (src/views/auth.ts#accountClaimedView) can link straight to each one
  // rather than just reporting a bare count with nowhere to click.
  conflictedApplicationIds: string[];
}

// Node's SqliteError carries the SQLite result code as `errcode` (2067 ==
// SQLITE_CONSTRAINT_UNIQUE). Matching on that specific code — not "any
// thrown error" — is what keeps a genuine, unexpected database fault (disk
// full, corruption, a constraint nobody anticipated) from being silently
// treated as a routine, recoverable claim conflict; an unexpected error
// still propagates and fails the request loudly, same as everywhere else in
// this app that distinguishes the two.
function isUniqueConstraintError(err: unknown): boolean {
  return err instanceof Error && "errcode" in err && (err as { errcode?: number }).errcode === 2067;
}

// Claims every row of `table` this device owns and hasn't already claimed
// into a DIFFERENT account, one row at a time inside its own SAVEPOINT —
// so a single row's unique-constraint conflict rolls back only that row,
// never the whole claim pass or the session being created around it.
// Returns how many rows were actually claimed and how many hit a conflict
// and were left untouched.
function claimRowsOneAtATime(
  table: "applications" | "reschedule_proposals",
  deviceColumn: string,
  accountColumn: string,
  deviceId: string,
  accountId: string,
): { claimed: number; conflicted: number; conflictedIds: string[] } {
  const candidates = db
    .prepare(
      `SELECT id FROM ${table} WHERE ${deviceColumn} = ? AND (${accountColumn} IS NULL OR ${accountColumn} = ?)`,
    )
    .all(deviceId, accountId) as unknown as { id: string }[];
  let claimed = 0;
  const conflictedIds: string[] = [];
  for (const { id } of candidates) {
    db.exec("SAVEPOINT claim_row");
    try {
      const result = db
        .prepare(
          `UPDATE ${table} SET ${accountColumn} = ?
           WHERE id = ? AND ${deviceColumn} = ? AND (${accountColumn} IS NULL OR ${accountColumn} = ?)`,
        )
        .run(accountId, id, deviceId, accountId);
      db.exec("RELEASE claim_row");
      if (Number(result.changes) > 0) claimed++;
    } catch (err) {
      db.exec("ROLLBACK TO claim_row");
      db.exec("RELEASE claim_row");
      if (!isUniqueConstraintError(err)) throw err;
      conflictedIds.push(id);
    }
  }
  return { claimed, conflicted: conflictedIds.length, conflictedIds };
}

// Wrapped in a transaction: every table's claim pass happens atomically — a
// crash or genuinely unexpected error partway through must not leave one
// table claimed and another not, which src/db.ts#withTransaction's
// rollback-on-throw guarantees. Each individual UPDATE's own WHERE clause
// is still what makes it immune to a race with a concurrent claim attempt
// (re-reading `creator_account_id`/`claimer_account_id`/
// `proposed_by_account_id` at write time, not from an earlier read) — the
// transaction adds cross-table atomicity on top of that, it isn't what
// provides the race safety by itself. Safe to call repeatedly: a row
// already claimed by this exact account matches the same WHERE clause and
// is simply re-written to the value it already has (`changes` still counts
// it, which is fine — this function's callers only use the counts for a
// user-facing summary, never as a correctness signal).
//
// `moveouts` has no equivalent unique-per-account constraint, so it's
// claimed in one bulk UPDATE exactly as before. `applications` and
// `reschedule_proposals` go through claimRowsOneAtATime, since an
// application claim can collide with `applications_one_active_per_identity`
// (see ClaimResult#conflictedApplications above) — reschedule proposals
// have no equivalent conflict (claiming `proposed_by_account_id` doesn't
// interact with `reschedule_one_pending_per_application`, which is keyed by
// `application_id` alone, not by proposer identity), but the same
// one-row-at-a-time shape is used for consistency and so a future
// constraint added to that table doesn't silently regain this bug. Claiming
// a device's own pending reschedule proposals here (not just its
// applications) matters because `isProposer` (src/ownership.ts) stays
// device-scoped for any proposal left with `proposed_by_account_id IS
// NULL` indefinitely — leaving one unclaimed would mean a DIFFERENT device
// that later happened to carry this exact (unguessable) device cookie could
// still act as the original proposer forever, instead of the account
// becoming the sole authority the same way it does for the application
// itself.
export function claimAnonymousDataForAccount(deviceId: string, accountId: string): ClaimResult {
  return withTransaction(() => {
    const moveoutsResult = db
      .prepare(
        `UPDATE moveouts SET creator_account_id = ?
         WHERE creator_device_id = ? AND (creator_account_id IS NULL OR creator_account_id = ?)`,
      )
      .run(accountId, deviceId, accountId);

    const applications = claimRowsOneAtATime("applications", "claimer_device_id", "claimer_account_id", deviceId, accountId);
    const proposals = claimRowsOneAtATime("reschedule_proposals", "proposed_by_device_id", "proposed_by_account_id", deviceId, accountId);

    return {
      moveouts: Number(moveoutsResult.changes),
      applications: applications.claimed,
      rescheduleProposals: proposals.claimed,
      conflictedApplications: applications.conflicted,
      conflictedApplicationIds: applications.conflictedIds,
    };
  });
}
