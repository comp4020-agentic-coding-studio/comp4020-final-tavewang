# MoveOut

MoveOut helps students give away usable possessions before moving out. Find an item, request a pickup time, and wait for the mover to confirm. Both people can then see the arrangement and agree on a different time if plans change.

## Start here

[Browse items](https://comp4020-final-tavewang.fly.dev/) without an account. To publish or request an item, [register](https://comp4020-final-tavewang.fly.dev/register) with an email and password or [log in](https://comp4020-final-tavewang.fly.dev/login). [My MoveOut](https://comp4020-final-tavewang.fly.dev/mine) lists your pages and requests, including when you sign in on another device.

Movers create a page, add items and offer pickup times. Choose Public for discovery in Browse or Unlisted for sharing by link; anyone with an Unlisted page's link can still view it. Recipients select an item and time. A request is not a booking until confirmed.

After confirmation, both parties see the pickup time, timezone and exact location. Recipients can report departure or arrival. Either party can propose another time; the original holds until the other accepts. The mover records the completed handover.

## Why this is worth building

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) documents usable goods discarded during move-outs and investigates convenience among influences on donation. It grounds the problem; MoveOut's hypothesis is that easier discovery and clearer arrangements reduce coordination effort.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) shows how software can succeed for a small group. MoveOut focuses on local handovers rather than engagement through feeds or ratings. Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/) supports feedback that helps people understand what happened and what to do next. Here, that means distinguishing interest, confirmation, arrival and collection.

## What good means here

Good means completing a handover with clear expectations and little avoidable coordination.

- **Reliable commitments:** one confirmed recipient per item, one active request per account per item, and mutual agreement before a reschedule takes effect.
- **Recoverable changes:** cancellation reopens a reserved item without automatically committing a backup recipient. Arrival alone never marks an item collected.
- **Appropriate visibility:** Browse shows public, open items before their deadline. Exact pickup locations are for the mover and confirmed recipient.
- **Understandable shared state:** updates should appear within about a second while preserving unfinished input. Lost permission takes priority over preserving a private page.

## Evidence and limits

Automated tests cover ownership, competing actions, migrations, restarts and association conflicts. Browser scripts exercise shared updates and account flows at desktop and mobile sizes. [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/PROCESS.md) links decisions and corrections to commits and distinguishes verification from remaining work. No human trial or measured waste reduction is claimed.

Signing in attempts to associate this browser's older anonymous data with your account. Conflicting requests remain unchanged, with a link to resolve them and retry. Successfully associated data requires account access thereafter.

There is no password reset. Notifications require an open page; email is deferred. Payments, delivery and chat are outside scope. SQLite and photos use Fly's persistent volume; live notifications assume one server process.

## Run locally

Use the versions in `mise.toml`. Run `pnpm install`, then `pnpm dev`. With the server running, use `pnpm check` and `pnpm check:evidence`. Port defaults to 8080; `DATA_DIR` holds records and photos (`./data` locally, `/data` on Fly).
