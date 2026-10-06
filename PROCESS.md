# Process overview

This is the first version of this file, written for crit 8. It's meant to be
rewritten, not appended to, as the project moves through crits 9 and 10 — this
is where things stood after this week's session, not a running log.

## What I asked for

I gave Claude Code the final project brief and crit 8's spec, plus a specific
project: **Fridge Rescue**, a shared-fridge tracker for housemates (list what's
in the fridge, mark things shareable, claim a shared item so two people don't
take the same half bag of spinach, keep a history once it's used), and a
detailed functional spec of my own — the member/identity model, the item
fields, the claim/unclaim/use rules, what's explicitly out of scope this week,
and what each of `README.md`, `CLAUDE.md`, `PROCESS.md`, and the reflection
needed to contain. The agent worked from that brief; it chose the stack and
data model within it, proposed a plan, and I reviewed and approved that plan
(stack, schema, routes, concurrency approach, order of work) before any code
was written.

## Stack decision (ADR)

**Node 24 (built-in `node:sqlite`) + Hono, no bundler, no ORM.**

Alternatives considered and rejected:

- **`better-sqlite3` instead of `node:sqlite`.** Same synchronous API shape,
  but a native addon — it would need a compiler toolchain in the Docker image
  (or a prebuilt binary matching the exact Node/libc combination, which is a
  real failure mode on Alpine). `node:sqlite` is built into the Node 24
  runtime the template already pins, verified directly in this repo before
  committing to it, with no flag required. That removes an entire class of
  "works locally, breaks in the container" failure for a one-machine app.
- **Express or a hand-rolled `node:http` router instead of Hono.** Either
  works, but both would mean writing (and getting right) cookie parsing and
  HTML escaping by hand. Hono's `hono/cookie` and `hono/html` (an
  auto-escaping tagged template) cover exactly that, as roughly 100KB of
  dependency rather than a framework with its own opinions about everything
  else. It's the only "framework" dependency in the app.
- **A client-side framework / SPA.** Rejected outright: this app is
  form-and-list shaped, not interaction-heavy, and server-rendered HTML forms
  are keyboard-operable and work with JavaScript off for free — relevant given
  the accessibility requirements in the brief and spec.
- **A build step (tsc/bundler).** Also verified directly: Node 24.21 runs
  `.ts` files unmodified (type-stripping), the same way `spec/*.ts` already
  runs via Vitest. So the Docker image has nothing to compile — one stage,
  `pnpm install --prod`, copy `src/`, run it.

`marked` renders `README.md` to HTML for `/readme/`; everything else is Node
built-ins.

## Data model and permissions

Three tables: `fridges`, `members` (keyed by `(fridge_id, device_id)`, not by
nickname, so two members called "Sam" are still two different people, and a
browser's identity survives a refresh via an httpOnly cookie, not an account),
and `items`, whose `shared` flag and `status` column (`kept` / `claimed` /
`used`) together encode every visibility state the spec describes without a
separate table for claims or history — "used" items simply stay in `items`
with `status = 'used'`, which is what the history view reads.

Every state change is one `UPDATE ... WHERE id = ? AND <the state it must
currently be in>` — not a read, then a check, then a write. That turned out to
double as the concurrency answer the spec explicitly asks for (two people
claiming the same item at once): both requests run the identical guarded
`UPDATE`, and only one can match `status = 'kept'` before the other's write
lands — the loser gets a 409, not a corrupted claim. This is recorded in
`CLAUDE.md` as a rule, not just an implementation detail, specifically so a
future "fix" doesn't replace it with a less-correct read-then-write pattern.

## What's verified, and how

- **Locally verified:** `pnpm typecheck` and `pnpm test` pass against the app
  running on a throwaway `DATA_DIR`. `spec/fridge.test.ts` (new this week)
  exercises, over real HTTP with per-member cookie jars: an unshared item
  can't be claimed by a non-owner; a non-member is refused both read and write
  access to another fridge; two concurrent claims on the same item resolve to
  exactly one winner; only the claimant can unclaim their own claim; a used
  item disappears from the current view but keeps its owner and claimant in
  history; an owner can use their own unclaimed item directly; identical
  nicknames in different browsers stay distinct members.
- **Verified manually, not by `spec/`:** cross-restart persistence — the
  Vitest run never restarts the server mid-test, so this was checked by
  stopping and restarting the local Node process against the same `DATA_DIR`
  and confirming a previously-added item was still in the SQLite file
  afterwards. The architectural guarantee (the only writable state is the
  SQLite file under the Fly-mounted volume at `/data`; `fly.toml` fixes that
  mount) is what should make this hold across an actual Fly restart or
  redeploy too, but that specific case is **not yet verified against the live
  deployment**.
- **Not yet verified at all:** the deployed `*.fly.dev` URL, pending
  `mise.local.toml`'s `FLY_API_TOKEN`.

## TODO (you)

- Once this deploys, redo the manual walkthrough (two browsers, phone width,
  keyboard-only) against the live URL and record the result here —
  honestly, as "deployed-verified," not folded into the local result above.
- Record anything you changed, pushed back on, or disagreed with once you've
  actually reviewed this version yourself — this file currently reflects the
  single agent session that produced it, not a correction you've made yet.
- Add your own view on the `node:sqlite` vs. `better-sqlite3` call and the
  no-framework-on-the-client call: do you agree with the trade-off, or would
  you reconsider either once crit 9's real-time requirement is in front of
  you?
