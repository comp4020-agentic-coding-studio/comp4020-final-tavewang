# MoveOut

MoveOut helps students give away usable possessions before moving out. Browse public items, request a pickup time, and wait for the mover's confirmation. Both people can then see the agreed arrangement and propose a different time if plans change.

## Start here

[Browse items](https://comp4020-final-tavewang.fly.dev/) or open [My MoveOut](https://comp4020-final-tavewang.fly.dev/mine) to create a page, add items and offer pickup times. Choose Public to appear in Browse, or Unlisted to share only your page's link. Unlisted pages remain accessible to anyone who has that link.

An account is optional. [Register](https://comp4020-final-tavewang.fly.dev/register) or [log in](https://comp4020-final-tavewang.fly.dev/login) to link this browser's pages and requests to an email and password, then reach them from any other device by signing in there too.

Recipients choose an item and time; a request is not yet a booking. After confirmation, the pickup card shows the time, timezone and exact location. Recipients can report being on their way or having arrived. Either person can propose a new time, but the original arrangement holds until the other accepts. The mover records the completed handover.

## Why this is worth building

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) documents usable goods discarded during move-outs and investigates convenience among the influences on donation. It grounds the problem, not a claim that scheduling causes the waste. MoveOut's hypothesis is that easier discovery and clearer arrangements can reduce coordination effort.

Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/) argues through a family app that software can succeed for a small group. MoveOut extends that idea to a pool of local exchanges, without pursuing engagement through ratings or feeds. Aurora Harley's [*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/) supports feedback that helps people understand what happened and what to do next. Here, that means distinguishing interest, confirmation, arrival and collection.

## What good means here

Good means finding and completing a handover with clear expectations and little avoidable coordination.

- **Reliable commitments:** one item has at most one confirmed recipient; accepting a reschedule requires the other person's agreement.
- **Recoverable changes of plan:** cancellation reopens the item without automatically committing a backup recipient. Arrival alone never marks an item collected.
- **Appropriate visibility:** Browse includes only public, open items before their deadline. Exact pickup locations remain restricted to the mover and confirmed recipient.
- **Understandable shared state:** the design target is updates within about a second while preserving personal drafts. The remaining editing-state limitation is recorded below.

## Evidence and limits

Automated tests cover permissions, visibility, competing confirmations, cancellation, migrations, rescheduling, and accounts (register/login/logout, claiming anonymous data, cross-device access, cross-account isolation, session revocation). Browser checks (`scripts/browser-verify*.mjs`, automated, not a human trial) address visible updates, input preservation, and a real second browser signing into the same account to reach pages it never created. These protect selected behaviours; whether the labels make sense and handovers become easier requires observing people, which hasn't been done. No user trial or measured waste reduction is claimed.

Three real bugs found by browser-level review, not code review alone, are fixed and covered by both an automated test and a saved script: a protected pickup card silently blocking an unrelated party's update, an empty reschedule dropdown when no alternative time existed, and a second device signed into an account being able to act on a request but not see it listed. [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/PROCESS.md) separates verified results, agent-executed checks and remaining work. Design records explain [live updates](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/docs/decisions/002-live-updates-preserve-input.md) and [public visibility](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/docs/decisions/004-public-browse-visibility.md).

Identity belongs to this browser unless you register or log in, which links the browser's pages and requests automatically. No password reset yet, so losing the password loses that recovery path. Notifications require an open page; email is deferred. Payments, delivery and chat are outside scope. SQLite and photos use Fly's persistent volume; the live-update transport assumes one server process.

## Run locally

Use the versions in `mise.toml`. Run `pnpm install`, then `pnpm dev`. With the server running, run `pnpm check` and `pnpm check:evidence`. Port defaults to 8080; `DATA_DIR` holds the database and photos (`./data` locally, `/data` on Fly).
