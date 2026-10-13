# Your harness

Rules for working on MoveOut, derived from the design decisions in
`README.md`'s "what good means" section and `PROCESS.md`'s stack ADR. If a
change would break one of these, it needs README's argument updated first,
not a quiet exception here.

## Identity, ownership, and the share link

- A visitor's identity is a single long-lived `device` cookie
  (`src/session.ts`), set on first visit. Never trust a client-supplied id
  field for who someone is — always resolve identity from that cookie.
- A move-out page's creator is `moveouts.creator_device_id`, set once at
  creation. Every creator-only action (add item, add timeslot, withdraw,
  confirm, complete, creator-initiated cancel) checks the requester's device
  against *that specific page's* value — never a different page's, never a
  value the client sent.
- There is **no separate management token**, on purpose: the brief requires
  the share link to never double as management auth, so the simplest way to
  guarantee that is to not have a second secret at all. `/m/:id` is the only
  URL for a page; whether a visitor sees the public apply view or the
  creator's dashboard is decided purely by whether their device matches
  `creator_device_id`. Don't add a management token, a magic "admin" query
  parameter, or anything else that would let *knowing a URL* substitute for
  being recognised as the creator.
- A nickname is display text only, never an identity key. The same nickname
  from two different devices is two different people — identity is always
  `(entity, device_id)`, never nickname.

## Two status columns, not one

`items.status` (`open` / `reserved` / `handed_over` / `withdrawn`) and
`applications.status` (`pending` / `confirmed` / `cancelled` / `completed`)
are separate columns on separate tables, by design — don't collapse them into
one field. An item can have several applications over its life; only ever one
of them active at a time; the item's own status outlives any single
application's row.

Transitions, and who may cause them:

- `pending → confirmed`: creator only, and only if the item is still `open`
  **and** the application's chosen timeslot hasn't already passed — if it has,
  the fix is for the claimant to change their own timeslot
  (`POST /applications/:id/timeslot`), never a creator override.
- `pending|confirmed → cancelled`: the claimant, on their own application, any
  time. The creator, only on a `confirmed` one, and only with a non-empty
  reason that gets stored and shown back to the claimant — never a silent
  revocation of a confirmed booking.
- `confirmed → completed`: creator only.
- `open → withdrawn`: creator only, and only while the item is still `open`
  — an item with a confirmed reservation must be unclaimed (cancelled) first,
  never withdrawn out from under a confirmed claimant. Withdrawing cascades
  to auto-cancel that item's still-pending applications (reason: "Item
  withdrawn by the mover") rather than leaving them stranded and unreachable.
- `reserved → open`: automatic, inside the same transaction as cancelling the
  confirmed application that held it — never a separate manual step.

`cancelled` and `completed` are terminal. Nothing ever moves an application
out of either state.

## Confirming is the one place two requests can race

Guard every state transition with a single `UPDATE ... WHERE id = ? AND
status = '<required current state>'` — never read-then-check-then-write. This
is what makes two simultaneous confirmations on different pending
applications for the *same item* resolve to exactly one winner: both
requests run the identical guarded `items.status = 'open' → 'reserved'`
update, and only one can still find `status = 'open'` once the other's write
has landed (Node's single-threaded loop plus `node:sqlite`'s synchronous
calls mean the two can't interleave mid-statement). If a double-confirmation
bug ever shows up, the fix is a missing or wrong `WHERE` clause, not a lock,
a queue, or an application-level mutex.

`/applications/:id/confirm` guards **two** rows this way inside one
transaction — `items.status: 'open' → 'reserved'` and
`applications.status: 'pending' → 'confirmed'` — and **both** guards'
results must be checked, not just the first. A real bug fixed in crit-9
review: confirming an application that had just been cancelled (stale page,
double-click) found the item still `open` (so that `UPDATE` succeeded,
`changes === 1`) but the application no longer `pending` (so its `UPDATE`
correctly matched zero rows) — and the route returned the *application*
update's `changes` as the overall result without ever checking whether the
*item* update should be undone. The item ended up `reserved` with no
confirmed application pointing at it: effectively stuck, since nothing else
transitions `reserved → open` except cancelling a confirmed booking that
didn't exist. The fix: throw inside the transaction the moment **either**
guarded update reports zero rows changed, so `withTransaction`'s `ROLLBACK`
undoes the item's write too — a transaction's atomicity only protects you if
every step's own success is actually checked before you decide the whole
thing succeeded. See the regression test in `spec/moveout.test.ts`
("confirming an already-cancelled application...").

`src/db.ts`'s `withTransaction` wraps the item+application pair of updates
for atomicity (all-or-nothing if something throws); the concurrency guarantee
itself comes from the guarded `WHERE`, not from the transaction boundary.

## The deadline gate

Applying and confirming both check `now <= moveouts.deadline_at` and refuse
once it's passed. Cancelling and completing are **never** blocked by the
deadline — an existing confirmed booking must stay actionable (so it can
still be marked picked up, or cancelled with a reason) after the deadline
passes. Nothing auto-completes, auto-withdraws, or auto-cancels anything
because a deadline passed — every transition is an explicit action by a
person, never a background sweep.

## Timezones

A move-out page declares one IANA timezone (`moveouts.timezone`, default
`Australia/Sydney`). Every deadline and timeslot is stored as a real UTC
instant (`src/tz.ts#zonedDateTimeToUtc`), converted from the wall-clock value
entered in that timezone — never stored as a naive local string, and never
compared against `now` without first being a real instant. Display always
names the timezone (`formatInZone`) rather than leaving it implicit.

## Persistence

All durable state — move-out pages, timeslots, items, applications, and
uploaded photos — lives under `DATA_DIR` (the SQLite file plus
`DATA_DIR/uploads/`). Nothing load-bearing goes in a module-level variable,
browser storage, or a container path outside `DATA_DIR`.

The one deliberate exception: `src/live.ts`'s in-memory subscriber lists for
the SSE streams. That's transport state, not a business record — losing it
on a restart just means every open tab's `EventSource` reconnects (it does
this on its own; see below) and re-syncs, not that anything was lost. Don't
promote it to a table, and don't add anything *else* to it beyond "who's
currently listening."

## Real-time updates (crit 9)

- The SSE stream (`GET /m/:id/events`, `GET /events`) carries no data — just
  "something changed" (`src/live.ts`). The client's only response to it is to
  re-fetch the exact page it already had permission to see, through the
  exact same route and ownership checks as a manual reload. **Never** put
  application data on that stream directly; the moment it needs to, it needs
  its own permission check, which defeats the reason it doesn't have one now.
- A write that depends on current state (confirm, cancel, apply, change
  timeslot) is validated against the live database row by its guarded
  `UPDATE ... WHERE status = '<state>'`, same as always — the real-time path
  adds no second way to call these routes and no reason to trust what a
  client's on-screen state claims is true. `src/public/live.js` only ever
  re-fetches and re-POSTs through the existing routes.
- `src/public/live.js` never replaces a DOM node the person is actively using
  — an open `<details>`, a changed input/select, a chosen file (the mover's
  add-item photo — the claimant's apply form has no file input), current
  keyboard focus, an in-progress IME composition (`isProtected`). It still
  patches the safe, read-only parts of a protected node in place (status badge, tone, an
  item's availability note, a now-visible pickup address, whether an open
  sub-form's controls still make sense) — see `patchSafeBits` and
  `syncApplicationStatus` — so shared state never goes stale just because
  someone's mid-form.
- IME composition protects only the active input and its ancestors. Other
  entities and safe shared-state updates must continue during composition;
  never return early from page-wide resync because an input is composing.
  Do not move its ancestor nodes until composition ends, then reconcile the
  latest fetched state through `scheduleCatchUp`.
- A node that isn't just changed but **gone entirely** from the server's
  current page (withdrawn, or moved from "upcoming" to "completed") and is
  still protected is never silently left looking valid: `markGone` disables
  every control on it and adds an explicit notice, without touching the
  person's typed input. The actual removal happens once they stop editing it
  (`scheduleCatchUp`, fired on `focusout`/`<details>` closing) — never on a
  separate, unrelated SSE push that may not arrive for a while.
- **Reconciliation never moves a DOM node that's already in the right
  place.** A card's position is only changed when it's genuinely out of
  order relative to the newly-fetched list — not on every sync regardless of
  whether anything reordered. Moving a node that contains the focused
  element drops focus to `<body>` (the DOM doesn't preserve it across a
  reposition), so this was a real bug: an *unrelated* list change anywhere
  on the page could silently kick someone out of a field they were still
  typing in, elsewhere in the same list.
- A `<section hidden>` wrapping a list (e.g. home's "Your requests", empty
  until the first application exists) is itself shared read-only state —
  `reconcile`'s `syncSectionVisibility` toggles its `hidden` attribute every
  sync, independent of whatever's protected inside. Reconciling only a
  list's *children* and never the section wrapping it is the bug this
  guards against: the first row ever added to an open tab updated the
  list but left the whole section invisible around it.
- The withdrawn-items summary and keyed list must sync even when initially
  empty. Keep the container mounted, update its count and visibility, and
  preserve the viewer's expanded/collapsed choice and unrelated form drafts.
- Never auto-replay a write whose outcome is unknown (a failed `fetch`,
  a dropped connection mid-request). Show the error, leave the person's input
  alone, and make *them* decide whether to resubmit — don't guess for them.
- Connection status (`#connection-status`) reflects what the SSE connection
  and the last resync fetch actually did, never `navigator.onLine` — a
  machine can report "online" while this app's own connection is down.

## Accessibility and legibility

- Status is always shown as text ("Waiting for confirmation", "Confirmed —
  pickup details below"), never colour alone.
- Every interactive control is a real `<form>`/`<button>`/`<input>`/`<select>`
  with an associated `<label>` — keyboard-operable by default.
- Errors are specific (what was wrong, not just "error") and never discard
  what the person already typed.

## Current scope — don't quietly expand it

Out of scope this crit, on purpose: payments, bidding, delivery, in-app chat,
ratings, AI recommendations, campus identity login, a cross-page marketplace,
email/SMS notifications, automatic backup-promotion, calendar integration,
partial-quantity requests, an online "who's here now" presence list, and a
pickup-capacity limit. Crit 9 adds real-time *sync* of the state that already
exists — it is not licence to add new state. Don't add any of these as a
"quick win" without first updating `README.md`'s "good" argument — a feature
not argued for there isn't one the spec or the marker is looking for.
