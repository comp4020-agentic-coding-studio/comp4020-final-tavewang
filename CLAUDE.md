# Your harness

Rules for working on Fridge Rescue, derived from the design decisions in
`README.md`'s "what good means" section and `PROCESS.md`'s stack ADR. If a
change would break one of these, it needs README's argument updated first, not
a quiet exception here.

## Ownership and sharing

- An item belongs to whoever added it (`owner_member_id`). Only the owner may
  change its name, quantity, use-by date, or its `shared` flag — and only
  while its `status` is `'kept'`.
- Sharing is opt-in and off by default. An item is claimable by someone other
  than its owner only when `shared = 1 AND status = 'kept'`.
- "Use by" is a reminder the owner set, not a food-safety claim the app makes.
  Never phrase it, or any copy near it, as a safety verdict.

## State transitions (the whole model)

`kept → claimed → kept → … → used`. Used is terminal — no route changes a used
item back to anything else.

- `kept → claimed`: only a member who is **not** the owner, only when
  `shared = 1`.
- `claimed → kept` (unclaim): only the member who holds the claim
  (`claimed_by_member_id`), never the owner and never a bystander.
- `kept → used` or `claimed → used`: the claimant can use what they claimed;
  the owner can use their own item only while nobody else has claimed it.
- Nobody may edit, re-share, or reassign an item while it is `claimed` — the
  claimant must unclaim it first. Don't add an owner override for this; it's
  the one invariant the brief calls out explicitly.

## Enforcement is server-side, always

- Every mutation is a single `UPDATE ... WHERE id = ? AND <required current
  state>` statement, checked against the requester's resolved `member` row —
  never a read-then-write, and never enforced only by hiding a button in the
  view. A 0-row update means someone else changed it first; return a plain
  conflict message (409/403), not a crash.
- This is also the whole concurrency story: two claims racing each other both
  run the same guarded `UPDATE`, and only one can match `status = 'kept'`
  before the other's write lands. Don't "fix" a double-claim bug by adding a
  lock, a queue, or a read-then-check in the handler — if one shows up, the
  guarded `UPDATE`'s `WHERE` clause is wrong, not the strategy.

## Identity and isolation

- A member is `(fridge_id, device_id)` plus a nickname. `device_id` comes only
  from the httpOnly cookie `session.ts` sets — never from a client-supplied
  field. Two different device cookies with the same nickname are two
  different members; never deduplicate members by nickname.
- Every route resolves the fridge from the **entity being acted on** (the item
  or fridge id in the URL), then checks the requester is a member of that
  specific fridge, before reading or returning anything about it. A fridge or
  item outside the requester's membership 404s — it doesn't reveal that the
  id exists.
- Never log, print, or echo back an invite token or a device cookie value in
  full. They're the only thing standing in for a password in this app.

## Accessibility and legibility

- Status is always shown as text ("Claimed by Bob", "Shareable"), never colour
  alone.
- Every interactive control is a real `<form>`, `<button>`, or `<input>` with
  an associated `<label>` — keyboard-operable by default. Don't attach
  behaviour to a bare `<div onclick>` or `<span>`.
- The one piece of client JS (copy-invite-link) is progressive enhancement
  only: the page must work, and the link must still be readable and
  selectable, with JavaScript off.

## Persistence and scope

- All durable state (fridges, members, items, claims, history) lives in the
  SQLite file under `DATA_DIR`. Nothing load-bearing goes in a module-level
  variable, a browser's `localStorage`, or a container's writable layer
  outside `/data`.
- Out of scope this crit, on purpose: real-time sync, partial-quantity claims,
  accounts/email, AI features, notifications. Don't add any of these as a
  "quick win" without first updating README's "good" argument — a feature not
  argued for there isn't one the spec or the marker is looking for.
