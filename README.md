# MoveOut

MoveOut helps students give away usable possessions before moving out. Browse public items, request a pickup time, and wait for the mover's confirmation. Both people can then see the agreed arrangement and propose a different time if plans change.

## Start here

[Browse items](https://comp4020-final-tavewang.fly.dev/) freely without an account — search, filter and open any page you have a link to. Creating a page, adding items, and sending a request all require signing in first; clicking either action while signed out takes you to [log in](https://comp4020-final-tavewang.fly.dev/login) or [register](https://comp4020-final-tavewang.fly.dev/register), then back to the page you were on, so you only ever complete the action by actively choosing to, never automatically.

Registering or logging in also links this specific browser's own pages or requests from before you had an account, if there are any — you'll see a notice about that before you sign in, and a confirmation of exactly what got linked afterwards. That link happens once; from then on, the account is the only thing that can manage that data, including from this same browser — signing out, or signing into a different account, no longer leaves the old device able to act on it.

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

Automated tests cover permissions, visibility, competing confirmations, cancellation, migrations, rescheduling, and accounts (register/login/logout, linking pre-account data, cross-device access, cross-account isolation, session revocation, the login requirement for publishing and applying). Browser checks (`scripts/browser-verify*.mjs`, automated, not a human trial) address visible updates, input preservation, and a real second browser signing into the same account to reach pages it never created, at both desktop and mobile viewport sizes. These protect selected behaviours; whether the labels make sense and handovers become easier requires observing people, which hasn't been done. No user trial or measured waste reduction is claimed.

Six real vulnerabilities found by independent review and browser-level testing, not code review alone, are fixed and covered by regression suites and saved scripts: four fix who's authorized to act on data once an account exists (`spec/permission-regression.test.ts`, `spec/duplicate-application-migration.test.ts`); two more fix real crashes in that same account machinery, found afterwards — a server that wouldn't restart once two different accounts both held their own valid request for the same item (`spec/restart-after-account-scoped-applications.test.ts`, a startup index was being recreated unconditionally after a later migration had already replaced it), and a correct-password login that 500'd when this device's own old, unclaimed request collided with the signing-in account's existing one (`spec/claim-conflict.test.ts`, now isolated per-row so one conflict can't abort the whole sign-in — the conflicting request is named directly with a working link to resolve it, never silently dropped). [PROCESS.md](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/PROCESS.md) separates verified results, agent-executed checks and remaining work. Design records explain [live updates](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/docs/decisions/002-live-updates-preserve-input.md) and [public visibility](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/blob/main/docs/decisions/004-public-browse-visibility.md).

An account is required to publish a page or send a request; browsing and viewing a page you have a link to stay open to anyone. No password reset yet, so losing the password loses that recovery path. Notifications require an open page; email is deferred. Payments, delivery and chat are outside scope. SQLite and photos use Fly's persistent volume; the live-update transport assumes one server process.

## Run locally

Use the versions in `mise.toml`. Run `pnpm install`, then `pnpm dev`. With the server running, run `pnpm check` and `pnpm check:evidence`. Port defaults to 8080; `DATA_DIR` holds the database and photos (`./data` locally, `/data` on Fly).
