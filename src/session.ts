import type { Context, MiddlewareHandler } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { newDeviceId } from "./ids.ts";
import { accountForSession } from "./auth.ts";
import type { Account } from "./db.ts";

declare module "hono" {
  interface ContextVariableMap {
    deviceId: string;
    // Set only when the request's session cookie resolves to a real,
    // non-revoked session (src/auth.ts#accountForSession) — undefined for
    // every anonymous visitor, exactly like before accounts existed.
    account: Account | undefined;
  }
}

const COOKIE_NAME = "device";
const SESSION_COOKIE_NAME = "session";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function cookieOpts(c: Context) {
  return {
    httpOnly: true,
    sameSite: "Lax" as const,
    secure: new URL(c.req.url).protocol === "https:",
    path: "/",
    maxAge: ONE_YEAR_SECONDS,
  };
}

// Every visitor gets an unguessable device cookie on their first request,
// before they've joined (or created) any fridge. Membership is keyed off
// this id, not off a nickname, so two people who both type "Sam" are still
// two different members, and the same browser keeps its identity across a
// refresh without needing an account.
//
// A SECOND, independent cookie (`session`) optionally layers an account on
// top: if present and it resolves to a live row in `account_sessions`
// (src/auth.ts), `c.get("account")` is set for every route this request
// touches. A forged, expired-looking, or already-signed-out-of session
// cookie resolves to undefined exactly like no cookie at all — never a
// crash, never a silent fallback to some other identity.
export const deviceMiddleware: MiddlewareHandler = async (c, next) => {
  let deviceId = getCookie(c, COOKIE_NAME);
  if (!deviceId) {
    deviceId = newDeviceId();
    setCookie(c, COOKIE_NAME, deviceId, cookieOpts(c));
  }
  c.set("deviceId", deviceId);

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  const account = accountForSession(sessionId);
  if (sessionId && !account) {
    // The cookie points at a session that no longer exists (signed out
    // elsewhere, or never existed) — clear it so the browser stops sending
    // a dead credential on every request, rather than silently ignoring it
    // forever.
    deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
  }
  c.set("account", account);

  await next();
};

export function setSessionCookie(c: Context, sessionId: string): void {
  setCookie(c, SESSION_COOKIE_NAME, sessionId, cookieOpts(c));
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

export function getSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE_NAME);
}

// A safe "come back here after logging in" path: only ever a path on THIS
// app (starting with exactly one `/`, never `//` which some browsers treat
// as protocol-relative to an attacker's own host, and never an absolute
// URL) — an open-redirect guard. A path that fails this check is dropped in
// favour of a neutral default, never passed through to the browser.
export function safeNextPath(raw: string | undefined, fallback = "/mine"): string {
  if (!raw) return fallback;
  if (!raw.startsWith("/") || raw.startsWith("//")) return fallback;
  if (raw.includes("\\")) return fallback; // some browsers also normalise backslashes into a host separator
  return raw;
}
