import { html } from "hono/html";
import { layout } from "./layout.ts";
import { applicationStatusLabel } from "./status.ts";
import type { Moveout } from "../db.ts";
import type { ApplicationWithContext } from "../ownership.ts";

export async function homeView(
  myMoveouts: Moveout[],
  myApplications: ApplicationWithContext[],
  opts: { error?: string } = {},
): Promise<string> {
  const body = html`
    <h1>MoveOut</h1>
    <p class="lede">
      Moving out and giving things away? Set a deadline, list what's free, and
      let people request a pickup time — without a group chat losing track of
      who's actually coming.
    </p>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    ${myMoveouts.length > 0
      ? html`
          <section>
            <h2>Your move-out pages</h2>
            <ul class="plain-list">
              ${myMoveouts.map((m) => html`<li><a href="/m/${m.id}/manage">${m.title}</a></li>`)}
            </ul>
          </section>
        `
      : ""}
    ${myApplications.length > 0
      ? html`
          <section>
            <h2>Your requests</h2>
            <ul class="plain-list">
              ${myApplications.map(
                (a) => html`
                  <li>
                    <a href="/m/${a.moveout_id}">${a.item_name}</a>
                    <span class="muted">— ${a.moveout_title} · ${applicationStatusLabel(a)}</span>
                  </li>
                `,
              )}
            </ul>
          </section>
        `
      : ""}
    <section>
      <h2>Start a move-out page</h2>
      <form method="post" action="/moveouts" class="stacked-form">
        <div class="field">
          <label for="title">Title</label>
          <input id="title" name="title" required maxlength="100" placeholder="e.g. Sam's room clear-out" />
        </div>
        <div class="field">
          <label for="area">Area (shown publicly — e.g. your hall or suburb)</label>
          <input id="area" name="area" required maxlength="80" placeholder="e.g. Fenner Hall" />
        </div>
        <div class="field">
          <label for="pickupLocation">Exact pickup spot (only shown once a request is confirmed)</label>
          <input id="pickupLocation" name="pickupLocation" required maxlength="140" placeholder="e.g. Fenner Hall, Room 214, side door" />
        </div>
        <div class="field">
          <label for="deadline">Everything must be gone by</label>
          <input id="deadline" name="deadline" type="datetime-local" required />
        </div>
        <div class="field">
          <label for="timezone">Timezone</label>
          <input id="timezone" name="timezone" value="Australia/Sydney" required maxlength="60" />
        </div>
        <div class="field">
          <label for="nickname">Your name</label>
          <input id="nickname" name="nickname" required maxlength="40" placeholder="What should people call you?" />
        </div>
        <button type="submit">Create move-out page</button>
      </form>
    </section>
  `;
  return layout("Home", body);
}
