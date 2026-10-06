import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deviceMiddleware } from "./session.ts";
import { renderReadmeHtml } from "./render.ts";
import { layout } from "./views/layout.ts";
import { uploadsDir } from "./db.ts";
import { SAFE_UPLOAD_NAME, contentTypeFor } from "./uploads.ts";
import { homeRoutes } from "./routes/home.ts";
import { moveoutRoutes } from "./routes/moveout.ts";
import { itemRoutes } from "./routes/items.ts";
import { applicationRoutes } from "./routes/applications.ts";

const app = new Hono();
app.use("*", deviceMiddleware);

const styles = readFileSync(new URL("./styles.css", import.meta.url), "utf8");
app.get("/styles.css", (c) => c.body(styles, 200, { "Content-Type": "text/css; charset=utf-8" }));

app.get("/uploads/:name", async (c) => {
  const name = c.req.param("name");
  if (!SAFE_UPLOAD_NAME.test(name)) return c.notFound();
  try {
    const bytes = await readFile(join(uploadsDir, name));
    return c.body(bytes, 200, { "Content-Type": contentTypeFor(name) });
  } catch {
    return c.notFound();
  }
});

// Served at request time (not baked in at build) so edits to README.md show
// up on reload; spec/invariants.test.ts checks its headings land here.
app.get("/readme/", (c) => {
  return c.html(`<!doctype html>
<html lang="en-AU">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>About · MoveOut</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="readme">${renderReadmeHtml()}</main>
  </body>
</html>`);
});

app.route("/", homeRoutes);
app.route("/", moveoutRoutes);
app.route("/", itemRoutes);
app.route("/", applicationRoutes);

app.notFound((c) => c.html(layout("Not found", html`<h1>Not found</h1><p><a href="/">Go home</a></p>`), 404));

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  console.log(`MoveOut listening on http://0.0.0.0:${info.port}`);
});
