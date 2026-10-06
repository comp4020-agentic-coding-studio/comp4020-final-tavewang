# Crit 8 reflection

**Status: scaffold only — the two prompts below need your own first-person
account before the cutoff. Nothing in this file is a finished reflection.**

## What actually happened this week (facts, for reference while you write)

- Built and deployed a first crit 8 submission (Fridge Rescue, a shared-fridge
  tracker) earlier this week, with its own working spec, docs, and a live
  deployment.
- Changed direction to MoveOut, a move-out item hand-off tool, and gave Claude
  Code a detailed functional spec for it: identity via browser cookie (no
  accounts), items and timeslots, a request/confirm/cancel/complete lifecycle
  with two separate status fields, and specific privacy and concurrency
  rules (pickup location hidden until confirmed; only one active confirmation
  per item, enforced even under two simultaneous confirm attempts).
- Reviewed and approved an implementation plan (schema, routes, timezone
  handling, photo-upload approach) before implementation began.
- Got a working app: create a page, add items and pickup times, request,
  confirm, cancel (by either side, with a reason required from the mover),
  mark picked up, a manage dashboard organised as not-yet-arranged / upcoming
  / completed.
- Verified the timezone conversion and the multipart photo upload path in
  isolation before building the rest of the app on top of either.
- Added `spec/moveout.test.ts` (11 tests), which caught two real bugs
  (a dropped application history on a withdrawn item; an unaddressable
  waitlisted applicant row) before they reached a crit.
- Verified locally end-to-end (typecheck, automated tests, a scripted
  multi-browser walkthrough, a restart-persistence check including an
  uploaded photo); deployment/live verification status is recorded honestly
  in `PROCESS.md` rather than assumed here.

## Prompt 1: What was the breakthrough that moved the work forward?

**TODO (you).** Candidates worth considering, if one of them is actually true
for you: realising that "one active confirmation per item" could be a
database constraint and a guarded `UPDATE`'s `WHERE` clause instead of
application-level locking; deciding to verify the timezone conversion and the
photo upload in isolation *before* building routes around either, rather than
discovering either was broken later; or something about what changed between
specifying Fridge Rescue and specifying MoveOut that made the second spec
easier or harder to hand to an agent. Don't use one of these if it isn't
actually what moved things forward for you — name the real one, including if
it was the decision to pivot away from Fridge Rescue itself.

## Prompt 2: What did this work change about who I want to be as a software developer?

**TODO (you).** This is yours to answer honestly; a fabricated answer is worse
than a short true one. If nothing changed yet, it's fine to say that and say
what you're watching for across crits 9 and 10 instead.

*(150–300 words total once both prompts are answered.)*
