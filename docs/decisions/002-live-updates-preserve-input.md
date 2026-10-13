# 002: When several people are in a move-out page at once, keep shared state current but never destroy what someone is typing

## Status

Accepted — crit 9.

## The problem

MoveOut now has to be real-time: a mover adding an item, confirming a
request, or cancelling a booking has to show up for everyone else looking at
that page within about a second, without a reload. That alone just says
*when* data moves. It doesn't say what the page does with an update that
arrives while a specific person is in the middle of something — and that's
where the actual decision is, not in the transport.

The scenario that forced the choice: Alice has the "Request this" form open
on the desk lamp, has typed her name and a note, and is still deciding on a
pickup time. At that exact moment the mover confirms Bob for the same lamp.
What should Alice's screen do?

- Ignore it, and let her submit a request for an item that's no longer
  available — the server will reject it, but she won't find out until after
  she's typed everything and hit submit.
- Reload or re-render the page to show the new state — and wipe her
  half-written note and name in the process.
- Something in between: tell her the lamp is gone *right now*, leave what
  she typed alone, and let her decide what to do next.

This is the kind of question the brief singles out directly: "what happens
when two people change the same thing at once" and "what reaches other
people live, and what waits." It has to be answered once, for the whole app,
not improvised per screen.

## Options considered

**A. Full-page refresh on any change.** Simplest possible rule: a change
anywhere on the page triggers a reload (or an equivalent full re-render) of
everything. Trivially consistent — there's never a stale element on screen —
and the cheapest to build and reason about.

**B. Delay all updates while a person is actively editing something.**
Suppress incoming changes globally the moment any input on the page has
focus or a non-empty value, and apply them all at once when the person
finishes (blurs the field, closes the form, submits). Protects input
completely, at the cost of showing *stale shared state* for however long the
person is editing — which could be the entire rest of the crit demo if they
leave a field focused.

**C. Update shared state promptly, but never touch what a person is
mid-edit on.** Patch the page continuously — item availability, confirmation
status, who else applied — the instant it changes, but treat any element
containing an open form, a typed value, a selected file, or the keyboard
focus as off-limits for replacement until the person is done with it. Show
the *status* change next to their input instead of inside it.

## Decision

**C.** Shared, read-only state (item availability, an application's status,
who's confirmed, the list of pickup times) updates live, continuously, for
everyone watching. A specific person's own in-progress input — the fields of
an open "request this" or "change timeslot" form (or, on the mover's side,
the "add an item" form and its chosen photo), an in-progress IME composition,
keyboard focus, an expanded `<details>` — is never overwritten by someone
else's update. When the two conflict (the item Alice has the form open for
gets reserved by someone else), she sees an inline notice next to her
still-intact form, and the submit button is disabled; her name and note are
untouched, and if the item becomes available again she can still send what
she typed. When a card's removal itself is what the conflicting update
would do (the item she was on gets withdrawn entirely), it's left on screen
— disabled, with the same notice — until she stops editing it, rather than
either destroyed immediately or left silently looking valid forever.

### Why, against README's "what good means"

- *"A request is unambiguous"* and *"the mover knows the next action"* argue
  for the shared-state side: if the lamp is gone, everyone watching should
  see that immediately, not after their next click.
- *"Cancellation leaves a way forward"* and *"details and outcomes are
  handled carefully"* argue for the input-preservation side: a person who
  was about to request something shouldn't lose that attempt to a page
  update they didn't cause, especially right after being told the thing they
  wanted just disappeared.
- *"The mover knows the next action"* also rules out B on the mover's own
  manage page specifically — a mover reading the open-requests list while
  deciding who to confirm needs that list current *while they're reading it*,
  not frozen until they stop moving their mouse over it.

C is the only option that serves both halves of that argument at once.

### Why not A

A full reload is disqualified outright by the crit's spec: "collisions...
must not destroy an in-progress edit." It would also undercut the
confirmation-exclusivity guarantee's *legibility* — CLAUDE.md's guarded
`UPDATE ... WHERE status = '<state>'` already makes double-confirmation
impossible at the database level, but a visitor who gets reloaded mid-request
and silently loses their note has no way to tell that from an ordinary bug.

### Why not B

B protects input by making the whole page briefly unreliable for everyone
else. On the mover's manage page — the one screen where several pending
requests for the same item are compared side by side before confirming —
showing stale applicant data while any field anywhere has focus is close to
the opposite of what that page is for. It also has no natural "done editing"
signal for a `<details>` someone opened and then got distracted from; the
staleness window is unbounded.

## Cost and limits of the chosen option

- More implementation surface than A: every live-updated list has to know,
  per entity, whether it's currently safe to replace (`src/public/live.js`'s
  `isProtected`), rather than one unconditional re-render.
- The protection check is coarse ("this card has an open form or a changed
  field," not "this specific field") — if a person has *any* unsaved input
  inside a card, the whole card's structural update is deferred, not just
  the field they're touching. In exchange, the status badge and
  availability notice inside that card still update immediately (see
  `patchSafeBits` in `src/public/live.js`) — only the more disruptive
  full-card replace is held back.
- A held-back update isn't dropped; it's applied automatically the moment the
  card stops being protected (losing focus, the `<details>` closing — see
  `scheduleCatchUp` in `src/public/live.js`), not only on the next unrelated
  SSE push. An earlier version of this decision relied on "the next business
  event happens to touch this page" to apply a deferred update, which could
  in practice mean "never" on a quiet page; that gap was found during review
  and closed before this was considered done.
- The manage page keeps its withdrawn-items container rendered but hidden
  when empty. Its count and keyed item names update live from the first
  withdrawal onwards, without replacing the details element or changing
  the viewer's expanded/collapsed choice.

## How this is verified

- `spec/live.test.ts` checks the *shared-state* half mechanically: an
  applied request, a confirmation, and the claimant's own device-scoped
  stream each produce an SSE push within 1.5s of the write that caused them
  (measured, not just asserted not-to-error — see the logged `[live] ...ms`
  lines in the test output cited in PROCESS.md). `spec/moveout.test.ts` also
  carries a regression test for a correctness bug this decision's own
  implementation introduced and review caught: confirming an
  already-cancelled application used to leave the item wrongly `reserved`.
- The *input-preservation* half — a focused field, a half-filled form, a
  reordered-but-unrelated list, a withdrawn-while-editing card — can only be
  judged by watching an actual browser's DOM, so it's checked with a
  Playwright script (`scripts/browser-verify.mjs`) driving several
  independent browser contexts (separate cookie jars = separate "devices"),
  not by an HTTP client. Its results and limits are in PROCESS.md.
- IME composition specifically is checked only with **synthetic**
  `compositionstart`/`compositionend` events dispatched by the script, not a
  real operating-system input method — Playwright's Chrome driver has no
  actual IME attached. This proves `src/public/live.js`'s own composition
  protection preserves the original input node, text, focus and selection
  while new pickup times and an unrelated withdrawal update before
  composition ends. Only the composing element and its ancestors are
  protected; page-wide updates never wait for composition to finish. This
  is not evidence that a genuine Pinyin/Zhuyin/etc. session behaves identically.
  That gap is real and stated, not papered over — see PROCESS.md and
  reflections/crit-9.md for what a human would still need to check with a
  real IME enabled.

## What would make us reconsider

- If a future crit's data model needs collaborative *text* editing on the
  same field (not just the same item/application) — a shared notes field,
  say — "protect the whole card" stops being fine-grained enough, and this
  would need per-field merge logic instead.
- If the app ever needs more than one Fly machine running MoveOut at once,
  `src/live.ts`'s in-process `EventEmitter` pub/sub stops being correct (an
  update on machine A would never reach a browser connected to machine B).
  The course's `fly.toml` pins this app to one shared-cpu-1x machine, which
  is why that's out of scope now — but it's the first thing to revisit if
  that ever changes.
