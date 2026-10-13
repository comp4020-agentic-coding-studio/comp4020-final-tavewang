# MoveOut

MoveOut helps students arrange free collection of unwanted possessions before a moving deadline. A mover lists items, offers pickup windows and shares one link through an existing group. Recipients request an item and a time; the mover confirms a recipient and records the handover.

## The problem and design references

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) describes usable possessions discarded during student move-outs and investigates convenience in donation behaviour. This grounds the problem, but does not establish that scheduling causes the waste or that MoveOut reduces it. Easier coordination is this project's hypothesis.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) supports designing for a small, specific group. Here, one mover and a few recipients should be enough. Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/) informs the distinction between interest, confirmation and collection: people need feedback that explains what happened and what happens next. These references informed the design rationale, not a completed user evaluation.

## What good means here

Good means completing a handover with clear expectations and little avoidable coordination.

- **Requests are unambiguous.** Applying means waiting for confirmation, not having a pickup booked.
- **Commitments are reliable.** An item has at most one confirmed recipient, including when confirmations compete. Invalid confirmations must leave both records unchanged.
- **Next actions are visible.** The dashboard separates unarranged items, upcoming pickups and completed handovers.
- **Cancellation leaves a way forward.** Cancelling a booking reopens the item. Movers must give a reason; remaining applicants need a new decision, without automatic promotion.
- **Details are handled carefully.** Recipients receive the exact pickup address only after confirmation. Completed handovers remain in history.
- **Shared changes preserve personal input.** The target is updates within about a second without clearing drafts. An unavailable item should be explained beside the retained form, with submission disabled. The [multiplayer decision](docs/decisions/002-live-updates-preserve-input.md) compares alternatives and costs.

## Scope and trade-offs

MoveOut supports photos, pickup windows, requests, confirmation, cancellation and completion. Server-Sent Events trigger updates through the existing authorised page routes. Forms also work without JavaScript, with changes visible after navigation.

The dashboard's withdrawn-item count and names update live, including the first withdrawal, while preserving the list's expanded state. Input-method composition now protects the active input without pausing updates elsewhere. Synthetic-event tests cover this behaviour; real operating-system input methods still need a manual check.

Browser cookies identify people; clearing them or changing devices loses access to that identity. Account recovery is unsupported. The transport assumes one server process. Payments, delivery, bidding, chat, ratings and a public marketplace are outside this version.

## How the claims will be checked

Tests cover ownership, address visibility, competing confirmations, cancellation, deadlines and stale-confirmation rollback. Browser checks cover visible updates and draft preservation. Latest review: 15 automated tests and 34 browser checks passed. A separate review verified file, focus and selection retention; file retention is not yet covered by the repository script. IME coverage uses synthetic events, not a real input method.

A user trial must still assess whether recipients understand their status and movers identify their next pickup. No measured reduction in waste or coordination effort is claimed. [PROCESS.md](PROCESS.md) records evidence and remaining checks.

## Running it

```sh
pnpm install
pnpm dev
pnpm check
pnpm check:evidence
```

Start the server before checks. Port defaults to 8080. SQLite and photos live under `DATA_DIR`: `./data` locally, `/data` on Fly.
