import { html } from "hono/html";
import { layout } from "./layout.ts";

export async function inviteJoinView(
  fridgeName: string,
  token: string,
  opts: { error?: string } = {},
): Promise<string> {
  const body = html`
    <h1>Join ${fridgeName}</h1>
    ${opts.error ? html`<p class="error" role="alert">${opts.error}</p>` : ""}
    <form method="post" action="/invite/${token}/join">
      <div class="field">
        <label for="nickname">Your name</label>
        <input id="nickname" name="nickname" required maxlength="40" autofocus placeholder="What should housemates call you?" />
      </div>
      <button type="submit">Join fridge</button>
    </form>
  `;
  return layout(`Join ${fridgeName}`, body);
}

export async function inviteNotFoundView(): Promise<string> {
  const body = html`
    <h1>This invite link isn't valid</h1>
    <p>Ask whoever sent it for a fresh one, or <a href="/">start your own fridge</a>.</p>
  `;
  return layout("Invite not found", body);
}
