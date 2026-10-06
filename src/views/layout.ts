import { html } from "hono/html";

// Every view in this app is written the same way: an `async` function
// returning an `html` tagged template. hono/html's `html` auto-escapes any
// plain value you interpolate (a nickname, an item name) but passes through
// anything already built with `html`/`raw`, so nesting view fragments never
// double-escapes. Declaring these `async` keeps the return type a plain
// Promise<string> even though nothing here is actually asynchronous — it
// sidesteps the sync/async union hono/html's types would otherwise produce.
export async function layout(title: string, body: unknown): Promise<string> {
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
      <a class="muted-link" href="/readme/">About this app</a>
    </header>
    <main>${body}</main>
  </body>
</html>`;
}
