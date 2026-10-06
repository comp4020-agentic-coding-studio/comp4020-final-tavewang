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
partial-quantity requests. Don't add any of these as a "quick win" without
first updating `README.md`'s "good" argument — a feature not argued for there
isn't one the spec or the marker is looking for.
