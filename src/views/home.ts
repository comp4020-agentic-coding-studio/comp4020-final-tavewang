import { html } from "hono/html";
import { layout } from "./layout.ts";
import { applicationStatusLabel } from "./status.ts";
import type { Moveout } from "../db.ts";
import type { ApplicationWithContext } from "../ownership.ts";

// "My MoveOut": the creator/claimant management home, as it was before Crit
// 11 added the public Browse pool at "/" — moved to its own URL so a
// returning user with pages or requests of their own always has a fixed
// place to find them, regardless of what's trending in the public pool.
export async function mineView(
  myMoveouts: Moveout[],
  myApplications: ApplicationWithContext[],
  opts: { error?: string } = {},
): Promise<string> {
  const body = html`
    <h1>My MoveOut</h1>
    <p id="connection-status" class="conn-status" role="status" aria-live="polite" hidden></p>
    <p class="lede">The move-out pages you've created, and the requests you've sent.</p>
    <p class="muted">
      This browser remembers who you are; clearing its cookies or switching
      browsers loses that identity, with no way to recover it.
    </p>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <section data-live-section="my-moveouts" ${myMoveouts.length === 0 ? "hidden" : ""}>
      <h2>Your move-out pages</h2>
      <ul class="plain-list" data-live-list="my-moveouts">
        ${myMoveouts.length === 0
          ? html`<li data-placeholder></li>`
          : myMoveouts.map(
              (m) => html`
                <li data-moveout-id="${m.id}">
                  <a href="/m/${m.id}/manage">${m.title}</a>
                  <span class="muted"> — ${m.visibility === "public" ? "Public" : "Unlisted"}</span>
                </li>
              `,
            )}
      </ul>
    </section>
    <section data-live-section="home-requests" ${myApplications.length === 0 ? "hidden" : ""}>
      <h2>Your requests</h2>
      <ul class="plain-list" data-live-list="home-requests">
        ${myApplications.length === 0
          ? html`<li data-placeholder></li>`
          : myApplications.map(
              (a) => html`
                <li data-application-id="${a.id}">
                  <a href="/m/${a.moveout_id}">${a.item_name}</a>
                  <span class="muted">— ${a.moveout_title} · ${applicationStatusLabel(a)}</span>
                </li>
              `,
            )}
      </ul>
    </section>
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
        <fieldset class="field visibility-field">
          <legend>Who can find this page?</legend>
          <label class="radio-row">
            <input type="radio" name="visibility" value="public" checked />
            <span><strong>Public</strong> — its open items appear in Browse for anyone to find.</span>
          </label>
          <label class="radio-row">
            <input type="radio" name="visibility" value="unlisted" />
            <span><strong>Unlisted</strong> — only reachable by the link you share; never in Browse.</span>
          </label>
          <p class="muted">You can change this later from the page's manage view.</p>
        </fieldset>
        <button type="submit">Create move-out page</button>
      </form>
    </section>

    <script src="/live.js" data-live="/events"></script>
  `;
  return layout("My MoveOut", body);
}
