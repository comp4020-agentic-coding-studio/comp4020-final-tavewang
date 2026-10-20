import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isItemCategory } from "../db.ts";
import { countBrowseItems, listBrowseItems, type BrowseSort } from "../ownership.ts";
import { onPublicPoolChange, pumpSSE } from "../live.ts";
import { browseView } from "../views/browse.ts";

export const browseRoutes = new Hono();

function parseSort(value: string | undefined): BrowseSort {
  return value === "deadline" ? "deadline" : "newest";
}

browseRoutes.get("/", (c) => {
  const rawSearch = c.req.query("q") ?? "";
  // Bound the length server-side — this becomes a bound SQL parameter either
  // way, so it's not an injection guard, just sane input hygiene (no reason
  // to accept or echo back a multi-kilobyte query string).
  const search = rawSearch.slice(0, 100);
  const rawCategory = c.req.query("category") ?? "";
  const category = isItemCategory(rawCategory) ? rawCategory : "";
  const sort = parseSort(c.req.query("sort"));

  const query = { search: search || undefined, category: category || undefined, sort };
  const total = countBrowseItems(query);
  const items = listBrowseItems(query);

  return c.html(browseView(items, total, { search, category, sort }));
});

// Same shape as the per-moveout and per-device streams (src/live.ts): no
// data on the wire, just "the pool changed, go re-fetch your current view."
// A subscriber here only ever re-fetches "/" with whatever search/category/
// sort it already had — never gains visibility into anything beyond what
// GET "/" already serves to a public, unauthenticated visitor.
browseRoutes.get("/browse/events", (c) => {
  return streamSSE(c, (stream) => pumpSSE(stream, (notify) => onPublicPoolChange(notify)));
});
