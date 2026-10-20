# 004: A move-out page's visibility is an explicit, server-checked flag, not an inference from its content

## Status

Accepted — Crit 11 (product direction change, authorised for this round).

## The problem

MoveOut moved from "share a link, anyone with it can browse and request"
to "anyone can discover public items from a central pool." That's a real
privacy boundary change, not a cosmetic one: a page that used to be
reachable only by a link someone chose to share could, without a deliberate
switch, become reachable by anyone typing a few words into a search box.

Two sub-problems follow directly:

1. Every move-out page that already existed before this change was created
   under the old "link-only" assumption. Treating it as public by default
   the moment this code ships would publish things their creators never
   agreed to show a stranger.
2. The pool has to be fast and simple to query — this is a small app with
   no search index, a shared-cpu-1x Fly machine, and node:sqlite, not a
   search service.

## Options considered

1. **Infer visibility from content** (e.g. "public once it has an item and
   a timeslot"). Rejected: implicit, surprising, and gives a creator no way
   to say "I want a link-only page on purpose" even when it's otherwise
   complete.
2. **A separate "discoverable" marketplace entity, distinct from the
   move-out page.** Would let one page expose different items to the pool
   vs. its own link. Rejected as more product than this crit's brief asked
   for, and a second source of truth for what an item's state is — CLAUDE.md
   already treats one item having one authoritative status row as a hard
   rule; a second visibility surface per item would duplicate that.
3. **A single `visibility` column on `moveouts`, explicit, server-checked,
   creator-only to change, defaulting existing rows to the more private
   state (chosen).** One flag, one place, matches the brief's own language
   (Public / Unlisted), and composes cleanly with the existing ownership
   check (`isCreator`) rather than adding a second permission model.

## Decision

Option 3. `moveouts.visibility` is `'public'` or `'unlisted'`
(`src/db.ts`). New pages choose at creation, defaulting to `'public'` in
the form but requiring an explicit POST field either way
(`src/routes/home.ts`) — never silently assumed. The migration that adds
the column (`src/db.ts`) defaults every **pre-existing** row to
`'unlisted'`, regardless of the column's own SQL default matching, as a
deliberate belt-and-braces: a page created before this flag existed should
never retroactively become more exposed than its creator agreed to.
Changing visibility is a creator-only POST (`/m/:id/visibility`), checked
the same way every other creator-only action is — a mismatched device gets
404, not a 403 that would at least confirm the page exists.

The pool query itself (`src/ownership.ts#listBrowseItems`,
`#countBrowseItems`) is one parameterised SQL statement with
`visibility = 'public' AND status = 'open' AND deadline_at > ?` as its base
`WHERE`, plus optional category/search clauses — never a broader fetch
filtered after the fact in application code or in the browser. This is
what makes "an unlisted page's items never reach the pool" a property of
the query itself, not of every call site remembering to check.

## Consequences

- An unlisted page stays exactly as reachable as it always was (its own
  link still works) — "unlisted" means "not discoverable," never
  "inaccessible," matching how the brief uses the word.
- Flipping visibility either direction has to notify the pool's SSE bus
  (`notifyPublicPool`), not just the page's own subscribers — implemented,
  but it is one more place a future write that touches `items.status` or
  `moveouts.visibility` has to remember to call.
- A public page's full detail page is still only reachable by its own URL;
  Browse only ever links to `/m/:id#item-:id`, never exposes a separate
  "public API" shape with different fields than the page a direct visitor
  sees.
