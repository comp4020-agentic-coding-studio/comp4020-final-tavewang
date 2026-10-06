import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import { readFileSync } from "node:fs";
import { deviceMiddleware } from "./session.ts";
import { renderReadmeHtml } from "./render.ts";
import { layout } from "./views/layout.ts";
import { homeRoutes } from "./routes/home.ts";
import { inviteRoutes } from "./routes/invite.ts";
import { fridgeRoutes } from "./routes/fridge.ts";
import { itemRoutes } from "./routes/items.ts";

const app = new Hono();
app.use("*", deviceMiddleware);

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
app.get("/styles.css", (c) => c.body(styles, 200, { "Content-Type": "text/css; charset=utf-8" }));

// Served at request time (not baked in at build) so edits to README.md show
// up on reload; spec/invariants.test.ts checks its headings land here.
app.get("/readme/", (c) => {
  return c.html(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About · Fridge Rescue</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="readme">${renderReadmeHtml()}</main>
  </body>
</html>`);
});

// Mounted before inviteRoutes so the static "/invite/go" path (see
// routes/home.ts) is matched instead of inviteRoutes' "/invite/:token".
app.route("/", homeRoutes);
app.route("/", inviteRoutes);
app.route("/", fridgeRoutes);
app.route("/", itemRoutes);

app.notFound((c) => c.html(layout("Not found", html`<h1>Not found</h1><p><a href="/">Go home</a></p>`), 404));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`Fridge Rescue listening on http://0.0.0.0:${info.port}`);
});
