# MoveOut

MoveOut is a public pool of free items students post before moving out. Browse finds what's on offer across every mover who's made their page public; anyone can search, filter by category, request an item and a time, and the mover confirms a recipient and records the handover. A mover can also keep a page unlisted, shared only by its own link, the way MoveOut worked before Crit 11.

## The problem and design references

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) describes usable possessions discarded at move-out. This grounds the problem, but doesn't prove scheduling causes the waste or that MoveOut reduces it — easier coordination and discovery are this project's hypothesis.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) originally supported one mover and a few recipients; Crit 11 widens that to a course's worth of movers, arguing a pool of small, specific exchanges is still different from an open marketplace with ratings, chat or recommendations layered on. Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/) still informs interest vs. confirmation vs. collection. These inform the design rationale, not a completed user evaluation.

## What good means here

Good means finding and completing a handover with clear expectations and little avoidable coordination.

- **Discovery is server-scoped, not client-filtered.** Browse's search, category and sort run as one database query restricted to public, still-open, undeadlined items — never a broader fetch filtered in the browser. [ADR 004](docs/decisions/004-public-browse-visibility.md) explains the Public/Unlisted choice this depends on.
- **Requests are unambiguous.** Applying means waiting for confirmation, not a booked pickup.
- **Commitments are reliable.** An item has at most one confirmed recipient, even when confirmations compete; an invalid confirmation leaves both records unchanged.
- **Cancellation leaves a way forward.** Cancelling a booking reopens the item, including back into the pool, with no automatic promotion of the next applicant.
- **Details are handled carefully.** Recipients get the exact pickup address only after confirmation; a public card shows only the item's name, category, area and deadline — never an address, nickname or note.
- **Shared changes preserve personal input.** Updates to Browse, a move-out page, or a pending request land within about a second without clearing a search box, a draft, or a confirmed selection.

## Scope and trade-offs

MoveOut supports photos, categories, pickup windows, requests, confirmation, cancellation, completion, and now visibility and public discovery. SSE triggers updates through the existing authorised routes; forms also work without JavaScript. Account recovery is unsupported — clearing cookies or changing devices loses that identity. The transport assumes one server process. Payments, delivery, bidding, chat, ratings, a presence list, and a recommendation feed stay out of scope — Browse finds things by typing and clicking a category, nothing more.

## Identity, permission and logging

A mover and recipients are told apart by a device cookie, not a typed nickname. Every creator-only and claimant-only action, including who may change a page's visibility, is checked against that device id on the server — a mismatched device gets 404. The server logs one line per real action to stdout (`mise exec -- flyctl logs -a comp4020-final-tavewang`): the event, a hashed actor id, and success/denied/conflict, never a cookie, address, nickname or note. [ADR 003](docs/decisions/003-business-logging.md) and [ADR 004](docs/decisions/004-public-browse-visibility.md) record these design choices.

## How the claims will be checked

Tests cover ownership, address/note privacy (including inside the pool query), competing confirmations, visibility permission and lifecycle, migration safety for pre-existing data, same-nickname isolation, and the business log. Browser scripts cover visible updates, draft preservation, and the Browse discovery path end to end. [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/PROCESS.md) records evidence and remaining checks.

## Running it

```sh
pnpm install
pnpm dev
pnpm check
pnpm check:evidence
```

Start the server before checks. Port defaults to 8080. SQLite and photos live under `DATA_DIR`: `./data` locally, `/data` on Fly.
