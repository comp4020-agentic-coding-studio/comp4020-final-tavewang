# Process overview

This is the current version of this file, written for crit 8, replacing a
prior draft from earlier this same week. It's meant to be rewritten, not
appended to, as the project moves through crits 9 and 10 — this is where
things stood after this session, not a running log.

## The pivot this file has to be honest about

Earlier this week, this same repo had a working crit 8 submission for a
different project — Fridge Rescue, a shared-fridge item tracker — built,
tested, and deployed to this app's `*.fly.dev` URL. I then changed final-
project direction to MoveOut, a move-out item hand-off tool, for reasons that
are mine to record here rather than the agent's to invent: **TODO (you)** —
say briefly why the direction changed. The commit history shows both: the
Fridge Rescue commits stay in the log unmodified, and the MoveOut commits sit
on top of them as a real pivot, not a rewrite. The stack question below was
re-asked rather than assumed to still hold, even though the answer turned out
to be the same.

## What I asked for

I gave the agent the final project brief, crit 8's spec, and a detailed
functional spec of my own for MoveOut: the identity model (a browser cookie,
not accounts), the item/request fields, the full confirm/cancel/complete
rules including the two-separate-status-columns requirement, what's
explicitly out of scope this week, and what each of `README.md`, `CLAUDE.md`,
`PROCESS.md`, and the reflection needed to contain. The agent worked from
that brief; it chose the stack and data model within it, proposed a plan
(schema, routes, concurrency approach, photo-upload approach, order of work),
and I reviewed and approved that plan before implementation began.

## Stack decision (ADR)

**Unchanged from the Fridge Rescue build: Node 24 (built-in `node:sqlite`) +
Hono, no bundler, no ORM.** The pivot changed the application, not this
question, so the reasoning is restated rather than re-derived:

- `node:sqlite` over `better-sqlite3` — same synchronous API, but built into
  the Node 24 runtime `mise.toml` already pins, verified directly in this
  repo with no flag required, so the Docker image needs no compiler
  toolchain. `fly.toml` fixes one machine and `--ha=false`, so there's exactly
  one process and one DB file.
- Hono (`hono` + `@hono/node-server`) for routing, cookies, and
  auto-escaping HTML — the only "framework" dependency.
- No client-side framework; server-rendered forms are keyboard-operable and
  work with JavaScript off.
- Node 24.21 runs `.ts` files directly (verified again, same as before), so
  the Dockerfile still has nothing to compile.

**New for this app:**

- **Timezone handling** (`src/tz.ts`): the brief requires a declared,
  displayed timezone (default `Australia/Sydney`) with correct deadline/
  timeslot comparisons against real time. Rejected pulling in a date library
  for this — Node's `Intl.DateTimeFormat` already carries full IANA tz data,
  and the wall-clock↔UTC conversion is a well-known ~20-line technique (ask
  `Intl` what a UTC guess renders as in the target zone, correct by the
  difference). Verified directly against both a DST and non-DST date for
  `Australia/Sydney` before building the rest of the app on top of it.
- **Photo upload** (`src/uploads.ts`): the brief allows dropping this if the
  environment fights it. Verified first, in isolation, that Node's built-in
  `Request.formData()` (via `@hono/node-server`) parses a real
  `multipart/form-data` upload into a `File` with a working
  `.arrayBuffer()` — it does, so no upload dependency (e.g. `multer`) was
  needed. Validates MIME type (JPEG/PNG/WebP only) and a 5 MB cap before
  writing under `DATA_DIR/uploads/`, serving it back through a route that
  only ever reads a generated, pattern-matched filename (no path traversal
  surface from user input).
- **Two status columns, enforced by schema**: a partial unique index
  (`applications(item_id, claimer_device_id) WHERE status IN ('pending',
  'confirmed')`) makes "at most one active request per device per item" a
  database guarantee rather than an application-level check — verified
  directly that a second active insert is rejected and that re-applying
  after a cancellation is allowed.

## Concurrency and the state machine

Every transition is a single guarded `UPDATE ... WHERE id = ? AND status =
'<required state>'`, wrapped (with its paired item/application update) in a
transaction for atomicity. This is the same answer as Fridge Rescue's claim
race, applied to a two-table state machine instead of one: confirming an
application only succeeds if the item's `status = 'open' → 'reserved'` update
also lands a row, so two confirmations racing on two different pending
requests for the same item resolve to exactly one winner — verified with a
real concurrent `Promise.all` test, not just by argument.

## What's verified, and how

- **Locally verified** (`pnpm typecheck`, `pnpm test`, 11 tests in
  `spec/moveout.test.ts`): permission guards (non-creator can't manage or
  confirm; a claimant can't cancel someone else's request); the pickup
  location stays hidden from an unconfirmed requester; concurrent
  confirmations resolve to exactly one; cancelling a confirmed booking
  reopens the item for a backup request; applying past the deadline is
  rejected; a completed record persists across repeated reads; a mover can't
  request their own item or hold two active requests from one device;
  withdrawing an item cancels its pending requests. Writing these tests
  caught two real bugs before this ever reached a crit: a withdrawn item's
  own application history was dropping off the claimant's page (fixed in
  `src/routes/moveout.ts` by resolving against the full item list, not the
  public withdrawn-filtered one), and a waitlisted applicant row had no
  stable way to be addressed from outside the confirm button it doesn't
  render (fixed by tagging every row with `data-application-id` in
  `src/views/moveout-manage.ts`).
- **Verified manually, scripted but real** (a Python client simulating
  separate mover/claimant browsers, not a mocked unit test): the full
  create → add item/timeslot → apply → confirm → view-with-location →
  cancel → reopen → re-confirm → complete flow; photo upload end-to-end,
  including rejecting an oversized file; restarting the local Node process
  against the same `DATA_DIR` and confirming both a database row and an
  uploaded photo file survived.
- **Not yet verified against the live deployment** at the point this
  paragraph was written — see below for what's expected to be re-run against
  the actual `*.fly.dev` URL, including the redeploy-doesn't-lose-data check
  this week's spec specifically calls out.

## TODO (you)

- Say why the direction changed from Fridge Rescue to MoveOut (above).
- Once the live checks below are run, record the real result here as
  "deployed-verified," not folded into the local result silently.
- Record anything you changed, pushed back on, or disagreed with once you've
  actually reviewed this version yourself — this file currently reflects the
  agent session that produced it, not a correction you've made yet.
- Your own view on the two-status-column design and the no-management-token
  decision: do you agree, or would either get revisited once crit 9's
  real-time requirement is in front of you?
