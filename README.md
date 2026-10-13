# MoveOut

MoveOut helps students arrange free collection of unwanted possessions before
a moving deadline. A mover lists items, offers pickup windows and shares one
link through an existing group. Recipients request an item and a time; the
mover confirms one recipient and records the eventual handover.

## The problem and design references

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/)
documents usable goods being discarded during student move-outs. It identifies
convenience among the factors to investigate in donation behaviour. This
grounds the problem; it does not establish that missed pickups cause the waste
or that MoveOut will reduce it. The project's hypothesis is that making
arrangements visible can ease the work of giving things away.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/)
offers a useful model for software serving a small, specific group. Applied
here, one mover and a few recipients should be enough for the tool to help.
Sharing a page through an existing community keeps discovery simple and
limits the first version's scope.

Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/)
explains why people need clear feedback to understand what happened and what
to do next. For MoveOut, that suggests explicit distinctions between requesting,
confirmation, cancellation and collection. These references frame the design rationale;
the proposed benefits still need testing with people moving out.

## What good means here

Good means helping both people complete a handover with clear expectations
and little avoidable coordination.

- **A request is unambiguous.** Submitting interest shows "waiting for
  confirmation"; it must not suggest a pickup is already booked.
- **Commitments are reliable.** One item can have only one confirmed
  recipient. Confirmation must remain exclusive when requests arrive together.
- **The mover knows the next action.** The dashboard groups unarranged items,
  upcoming pickups and completed handovers.
- **Cancellation leaves a way forward.** Cancelling a booking reopens the
  item. A mover cancelling must give a reason. Backup requests remain for a
  new decision; nobody is automatically committed to a pickup.
- **Details and outcomes are handled carefully.** Exact pickup locations are
  withheld until confirmation. Completed handovers remain in the history.
- **An update from someone else never costs you your own.** Shared state —
  whether an item's still available, who's confirmed, who else has applied —
  updates live for everyone on the page, within about a second. It never
  does that by overwriting a form you're still filling in: if the item you
  were requesting gets reserved while you're mid-form, you're told right
  there, your typed name and note stay exactly as you left them, and nothing
  gets submitted on a stale decision. See
  [docs/decisions/002-live-updates-preserve-input.md](docs/decisions/002-live-updates-preserve-input.md)
  for the full argument and its trade-offs.

## Scope and trade-offs

The current implementation supports creating pages, photos, pickup windows,
requests, confirmation, cancellation and completion, and — as of crit 9 —
real-time updates: item status, applications, confirmations and cancellations
reach every open session on that page within about a second, with no reload,
over Server-Sent Events (`src/live.ts`, `src/public/live.js`). With
JavaScript unavailable, the app still works exactly as before: a normal form
submission, and the next page reflects it.

Not yet live-updated: the manage page's withdrawn-items count, which still
needs a reload to pick up — a deliberately accepted gap, not an oversight
(see [the ADR](docs/decisions/002-live-updates-preserve-input.md)). The
real-time transport is also single-machine: it holds connections in the
process's own memory, which is correct for this course's one-machine Fly
deployment and would need rework (e.g. a shared pub/sub) if the app ever ran
on more than one instance at once.

Free local collection keeps payments, delivery, bidding, ratings, in-app chat
and an online "who's here" list outside this version. Existing groups can
distribute the link; a campus-wide market would expand the problem beyond
arranging a handover.

Identity belongs to a browser cookie. Clearing it or changing devices loses
access to that identity; account recovery is not implemented. Knowing a share
link does not grant management access. Condition descriptions come from the
mover and are not independently verified. Photos are limited to one per item,
up to 5 MB, in JPEG, PNG or WebP format.

## How the claims will be checked

Existing tests exercise ownership, location visibility before confirmation,
competing confirmations, cancellation, deadlines and retained handover
records, plus a regression test for a stale-confirmation bug review found in
the new real-time write path (confirming an already-cancelled application
used to wrongly reserve the item; see PROCESS.md). `spec/live.test.ts` adds a
mechanical check on the real-time claim itself: it measures, rather than
assumes, the delay between a write (an application, a confirmation) and the
resulting push to an open event stream, including the claimant's own
device-scoped stream. What that kind of test can't see — whether a
half-filled form on screen survives someone else's update, whether focus
holds, whether a chosen photo on the mover's add-item form stays chosen — is
checked by driving an actual browser instead (`scripts/browser-verify.mjs`,
several independent browser identities). IME composition is checked there
only with synthetic (script-dispatched) composition events, not a real
input-method editor — see the ADR and PROCESS.md for that boundary. Repeated
reads are not a restart or redeployment test; verification evidence and its
limits are recorded in [PROCESS.md](PROCESS.md).

Human evaluation should ask a new recipient to request and cancel an item,
then explain its status without coaching. A mover should identify their next
pickup and remaining decisions. Observed confusion, additional messages and
completed handovers will help assess usefulness; no user trial or measured
waste reduction is claimed yet.

## Running it

```sh
pnpm install
pnpm dev
pnpm check
pnpm check:evidence
```

Start the server before running checks. It defaults to port 8080. SQLite
(`moveout.db`) and photos live under `DATA_DIR`: `./data` locally, `/data` on
the configured Fly volume.
