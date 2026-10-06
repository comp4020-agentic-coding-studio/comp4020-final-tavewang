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

## Scope and trade-offs

The current implementation supports creating pages, photos, pickup windows,
requests, confirmation, cancellation and completion. Changes become visible
to other browsers after a refresh; real-time updates are the next crit's work.

Free local collection keeps payments, delivery, bidding and ratings outside
this version. Existing groups can distribute the link; a campus-wide market
and in-app chat would expand the problem beyond arranging a handover.

Identity belongs to a browser cookie. Clearing it or changing devices loses
access to that identity; account recovery is not implemented. Knowing a share
link does not grant management access. Condition descriptions come from the
mover and are not independently verified. Photos are limited to one per item,
up to 5 MB, in JPEG, PNG or WebP format.

## How the claims will be checked

Existing tests exercise ownership, location visibility before confirmation,
competing confirmations, cancellation, deadlines and retained handover
records. Repeated reads are not a restart or redeployment test; verification
evidence and its limits are recorded in [PROCESS.md](PROCESS.md).

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
