import { html } from "hono/html";
import { layout } from "./layout.ts";
import type { Fridge } from "../db.ts";

interface Membership {
  fridge: Fridge;
  nickname: string;
}

export async function homeView(memberships: Membership[], opts: { error?: string } = {}): Promise<string> {
  const body = html`
    <h1>Fridge Rescue</h1>
    <p class="lede">
      Know what's in the shared fridge, what's up for grabs, and who's already
      got it — so nobody takes the same half-bag of spinach twice.
    </p>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    ${memberships.length > 0
      ? html`
          <section>
            <h2>Your fridges</h2>
            <ul class="fridge-list">
              ${memberships.map(
                (m) =>
                  html`<li><a href="/f/${m.fridge.id}">${m.fridge.name}</a> <span class="muted">— as ${m.nickname}</span></li>`,
              )}
            </ul>
          </section>
        `
      : ""}
    <section>
      <h2>Start a fridge</h2>
      <form method="post" action="/fridges">
        <div class="field">
          <label for="fridgeName">Fridge name</label>
          <input id="fridgeName" name="fridgeName" required maxlength="80" placeholder="e.g. 14 Mercer St" />
        </div>
        <div class="field">
          <label for="nickname">Your name</label>
          <input
            id="nickname"
            name="nickname"
            required
            maxlength="40"
            placeholder="What should housemates call you?"
          />
        </div>
        <button type="submit">Create fridge</button>
      </form>
    </section>
    <section>
      <h2>Join a fridge</h2>
      <p>Paste the invite link a housemate sent you.</p>
      <form method="get" action="/invite/go">
        <div class="field">
          <label for="inviteUrl">Invite link</label>
          <input id="inviteUrl" name="inviteUrl" type="text" required placeholder="https://.../invite/..." />
        </div>
        <button type="submit">Open invite</button>
      </form>
    </section>
  `;
  return layout("Home", body);
}
