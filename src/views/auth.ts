import { html } from "hono/html";
import { layout } from "./layout.ts";
import type { Account } from "../db.ts";

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
export async function accountClaimedView(account: Account, claimed: { moveouts: number; applications: number }, next = "/mine"): Promise<string> {
  const claimedAny = claimed.moveouts > 0 || claimed.applications > 0;
  const body = html`
    <h1>Welcome, ${account.email}</h1>
    ${claimedAny
      ? html`<p>
          Linked ${claimed.moveouts} move-out page${claimed.moveouts === 1 ? "" : "s"} and
          ${claimed.applications} request${claimed.applications === 1 ? "" : "s"} from this
          browser to your account.
        </p>`
      : html`<p>This browser had no existing pages or requests to link.</p>`}
    <p><a href="${next}">Continue</a></p>
  `;
  return layout("Signed in", body, account);
}
