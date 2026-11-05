import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { db, type Account } from "./db.ts";
import { newId } from "./ids.ts";

// Accounts sit ON TOP OF the existing anonymous device-cookie identity
// (src/session.ts) — never replace it. A device that never signs in behaves
// exactly as before; signing in only ever ADDS the ability to also reach
// your pages/requests from a different device. Every existing ownership
// check (isCreator, a claimant's own application) keeps working on the
// device id alone; accounts widen those checks to "OR this device's signed-
// in account matches," never narrow them.

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

// ---- Claiming anonymous data into an account on login/register --------
// The device that just signed in (or just registered) may already have
// anonymous move-out pages and applications tied only to its device cookie.
// This is the one-time, one-way pass that associates them with the account
// — it only ever touches rows this SPECIFIC device already owned (matched
// by creator_device_id / claimer_device_id, never by anything the client
// could otherwise influence), and only rows not already claimed by a
// DIFFERENT account (so logging into account B on a device that previously
// claimed data for account A can't silently reassign A's data to B).
export function claimAnonymousDataForAccount(deviceId: string, accountId: string): { moveouts: number; applications: number } {
  const moveoutsResult = db
    .prepare(
      `UPDATE moveouts SET creator_account_id = ?
       WHERE creator_device_id = ? AND (creator_account_id IS NULL OR creator_account_id = ?)`,
    )
    .run(accountId, deviceId, accountId);
  const applicationsResult = db
    .prepare(
      `UPDATE applications SET claimer_account_id = ?
       WHERE claimer_device_id = ? AND (claimer_account_id IS NULL OR claimer_account_id = ?)`,
    )
    .run(accountId, deviceId, accountId);
  return { moveouts: Number(moveoutsResult.changes), applications: Number(applicationsResult.changes) };
}
