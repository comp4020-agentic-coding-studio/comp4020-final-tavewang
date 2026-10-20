# MoveOut

MoveOut helps students arrange free collection of unwanted possessions before a moving deadline. A mover lists items, offers pickup windows and shares one link. Recipients request an item and a time; the mover confirms a recipient and records the handover.

## The problem and design references

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) describes usable possessions discarded during student move-outs. This grounds the problem, but doesn't establish that scheduling causes the waste or that MoveOut reduces it — easier coordination is this project's hypothesis.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) supports designing for one mover and a few recipients. Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/) informs the distinction between interest, confirmation and collection. These informed the design rationale, not a completed user evaluation.

## What good means here

Good means completing a handover with clear expectations and little avoidable coordination.

- **Requests are unambiguous.** Applying means waiting for confirmation, not a booked pickup.
- **Commitments are reliable.** An item has at most one confirmed recipient, even when confirmations compete; an invalid confirmation leaves both records unchanged.
- **Next actions are visible.** The dashboard separates unarranged items, upcoming pickups and completed handovers.
- **Cancellation leaves a way forward.** Cancelling a booking reopens the item. Movers must give a reason; remaining applicants need a new decision, with no automatic promotion.
- **Details are handled carefully.** Recipients receive the exact pickup address only after confirmation; completed handovers stay in history.
- **Shared changes preserve personal input.** Updates land within about a second without clearing drafts; an unavailable item is explained beside the retained form, submission disabled. [ADR 002](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/docs/decisions/002-live-updates-preserve-input.md) compares the alternatives.

## Scope and trade-offs

MoveOut supports photos, pickup windows, requests, confirmation, cancellation and completion. SSE triggers updates through the existing authorised routes; forms also work without JavaScript. The withdrawn-item list updates live, preserving the viewer's expanded state and in-progress IME composition (synthetic-event tests cover this; a real input method still needs a manual check).

Account recovery is unsupported — clearing cookies or changing devices loses that identity. The transport assumes one server process. Payments, delivery, bidding, chat, ratings and a public marketplace stay out of scope.

## Identity, permission and logging (Crit 10)

MoveOut is multi-user: a mover and several recipients act on one shared page, told apart by a device cookie, not the nickname they type (two "Sam"s stay two people). There's no account system or management link — the one shared URL shows the dashboard or the public view purely by whether the visitor's device matches the page's creator. Every creator-only action and claimant-only action is checked against that device id on the server, never just hidden in the UI — a mismatched device gets 404. [ADR 003](docs/decisions/003-business-logging.md) records the logging design.

The server writes one JSON line per real action (create, add item, add timeslot, apply, confirm, cancel, complete, change timeslot, withdraw) to stdout, readable live with `mise exec -- flyctl logs -a comp4020-final-tavewang`. Each line names the event, a stable, irreversible per-device actor id (a hash of the device cookie, never the cookie itself), the affected resource, and success/denied/conflict — enough to say who did what without logging a cookie, address, nickname or note. This is whatever stdout retention Fly gives the app, not a promise of permanent storage.

## How the claims will be checked

Tests cover ownership, address visibility, competing confirmations, cancellation, deadlines, stale-confirmation rollback, same-nickname isolation and the business log. Browser checks cover visible updates, draft preservation, focus and selection retention. IME coverage uses synthetic events, not a real input method, and no user trial or measured waste reduction is claimed. [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/PROCESS.md) records evidence and remaining checks.

## Running it

```sh
pnpm install
pnpm dev
pnpm check
pnpm check:evidence
```

Start the server before checks. Port defaults to 8080. SQLite and photos live under `DATA_DIR`: `./data` locally, `/data` on Fly.
