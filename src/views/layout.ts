import { html } from "hono/html";
import type { Account } from "../db.ts";

// Every view in this app is written the same way: an `async` function
// returning an `html` tagged template. hono/html's `html` auto-escapes any
// plain value you interpolate (a nickname, an item name) but passes through
// anything already built with `html`/`raw`, so nesting view fragments never
// double-escapes. Declaring these `async` keeps the return type a plain
// Promise<string> even though nothing here is actually asynchronous — it
// sidesteps the sync/async union hono/html's types would otherwise produce.
//
// `account` is optional and defaults to undefined (anonymous) so every
// existing call site compiles unchanged; pass it wherever the route already
// resolved `c.get("account")`, so the header reflects real sign-in state.
export async function layout(title: string, body: unknown, account?: Account): Promise<string> {
  return html`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title} · MoveOut</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <header class="site-header">
      <a class="brand" href="/">📦 MoveOut</a>
      <nav class="site-nav">
        <a href="/">Browse</a>
        <a href="/mine">My MoveOut</a>
        <a class="muted-link" href="/readme/">About this app</a>
        ${account
          ? html`
              <span class="muted account-chip">${account.email}</span>
              <form method="post" action="/logout" class="inline-form">
                <button type="submit" class="muted-link link-button">Log out</button>
              </form>
            `
          : html`<a href="/login">Log in</a> <a href="/register">Register</a>`}
      </nav>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}
