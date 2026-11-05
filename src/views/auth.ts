import { html } from "hono/html";
import { layout } from "./layout.ts";
import type { Account } from "../db.ts";

export async function registerView(opts: { error?: string; email?: string } = {}): Promise<string> {
  const body = html`
    <h1>Register</h1>
    <p class="lede">
      An account lets you reach the pages you've created and the requests
      you've sent from a different device — this browser's items and
      requests get linked to it automatically when you register.
    </p>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/register" class="stacked-form">
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
    <p class="muted">Already have an account? <a href="/login">Log in</a>.</p>
  `;
  return layout("Register", body);
}

export async function loginView(opts: { error?: string; email?: string } = {}): Promise<string> {
  const body = html`
    <h1>Log in</h1>
    <p class="lede">
      Signing in on a new device links it to the same account, so you can
      reach pages and requests you made elsewhere.
    </p>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/login" class="stacked-form">
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
    <p class="muted">No account yet? <a href="/register">Register</a>.</p>
  `;
  return layout("Log in", body);
}

export async function accountClaimedView(account: Account, claimed: { moveouts: number; applications: number }): Promise<string> {
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
    <p><a href="/mine">Go to My MoveOut</a></p>
  `;
  return layout("Signed in", body, account);
}
