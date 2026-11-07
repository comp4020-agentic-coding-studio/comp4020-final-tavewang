import { html } from "hono/html";
import { layout } from "./layout.ts";
import type { Account } from "../db.ts";
import type { ClaimResult } from "../auth.ts";
import type { ApplicationWithContext } from "../ownership.ts";

export async function registerView(
  opts: { error?: string; email?: string; next?: string; notice?: string; hasUnclaimedData?: boolean } = {},
): Promise<string> {
  const next = opts.next ?? "/mine";
  const body = html`
    <h1>Register</h1>
    <p class="lede">
      An account lets you reach the pages you've created and the requests
      you've sent from a different device.
    </p>
    ${opts.notice ? html`<p class="notice" role="status">${opts.notice}</p>` : ""}
    ${opts.hasUnclaimedData
      ? html`<p class="notice" role="status">
          This browser has an older page or request from before you had an account. Registering
          links it to your new account — nobody else can claim it, and it isn't accessible until
          you do.
        </p>`
      : ""}
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/register" class="stacked-form">
      <input type="hidden" name="next" value="${next}" />
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required maxlength="200" value="${opts.email ?? ""}" autocomplete="email" />
      </div>
      <div class="field">
        <label for="password">Password (at least 8 characters)</label>
        <input id="password" name="password" type="password" required minlength="8" autocomplete="new-password" />
      </div>
      <button type="submit">Create account</button>
    </form>
    <p class="muted">Already have an account? <a href="/login?next=${encodeURIComponent(next)}">Log in</a>.</p>
  `;
  return layout("Register", body);
}

export async function loginView(
  opts: { error?: string; email?: string; next?: string; notice?: string; hasUnclaimedData?: boolean } = {},
): Promise<string> {
  const next = opts.next ?? "/mine";
  const body = html`
    <h1>Log in</h1>
    <p class="lede">
      Signing in on a new device links it to the same account, so you can
      reach pages and requests you made elsewhere.
    </p>
    ${opts.notice ? html`<p class="notice" role="status">${opts.notice}</p>` : ""}
    ${opts.hasUnclaimedData
      ? html`<p class="notice" role="status">
          This browser has an older page or request from before you had an account. Logging in
          links it to your account if it isn't already claimed by a different one.
        </p>`
      : ""}
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/login" class="stacked-form">
      <input type="hidden" name="next" value="${next}" />
      <div class="field">
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required maxlength="200" value="${opts.email ?? ""}" autocomplete="email" />
      </div>
      <div class="field">
        <label for="password">Password</label>
        <input id="password" name="password" type="password" required autocomplete="current-password" />
      </div>
      <button type="submit">Log in</button>
    </form>
    <p class="muted">No account yet? <a href="/register?next=${encodeURIComponent(next)}">Register</a>.</p>
  `;
  return layout("Log in", body);
}

// Lands between a successful login/register and wherever the visitor was
// trying to go (`next`) — a deliberate stop, not a silent redirect, so the
// action that required signing in (e.g. "create a page") gets completed by
// the person actually clicking through, never auto-replayed on their behalf.
//
// `claimed.conflictedApplications` (src/auth.ts#ClaimResult) is this
// round's addition: a request this device had sitting unclaimed turned out
// to collide with a request the account already had, for the same item,
// from a different device — so it was deliberately left unclaimed rather
// than silently dropped or auto-cancelled. This view says exactly that,
// and the real way to continue is to resolve the conflict in the UI
// (cancel whichever of the two duplicate requests the account doesn't want)
// and come back — never claims "everything was linked" when something
// wasn't.
export async function accountClaimedView(
  account: Account,
  claimed: ClaimResult,
  next = "/mine",
  conflictedApplications: ApplicationWithContext[] = [],
): Promise<string> {
  const linkedAny = claimed.moveouts > 0 || claimed.applications > 0 || claimed.rescheduleProposals > 0;
  const linkedParts: string[] = [];
  if (claimed.moveouts > 0) linkedParts.push(`${claimed.moveouts} move-out page${claimed.moveouts === 1 ? "" : "s"}`);
  if (claimed.applications > 0) linkedParts.push(`${claimed.applications} request${claimed.applications === 1 ? "" : "s"}`);
  const body = html`
    <h1>Welcome, ${account.email}</h1>
    ${linkedAny
      ? html`<p>Linked ${linkedParts.join(" and ")} from this browser to your account.</p>`
      : html`<p>This browser had no existing pages or requests to link.</p>`}
    ${conflictedApplications.length > 0
      ? html`<p class="notice" role="status">
          This browser also had ${conflictedApplications.length} request${conflictedApplications.length === 1 ? "" : "s"} for
          an item your account already has its own active request for, sent from a different device. To avoid two active
          requests for the same item, ${conflictedApplications.length === 1 ? "it wasn't" : "they weren't"} linked to your
          account — ${conflictedApplications.length === 1 ? "it's" : "they're"} untouched and still reachable from this
          browser below. Cancel whichever of the two duplicate requests you don't want, then sign in again on this browser
          to link the one you keep.
        </p>
        <ul class="plain-list">
          ${conflictedApplications.map(
            (app) => html`
              <li>
                <a href="/m/${app.moveout_id}">${app.item_name}</a>
                <span class="muted"> — ${app.moveout_title}</span>
              </li>
            `,
          )}
        </ul>`
      : ""}
    <p><a href="${next}">Continue</a></p>
  `;
  return layout("Signed in", body, account);
}
