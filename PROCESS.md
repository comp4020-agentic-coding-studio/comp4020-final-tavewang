# Process overview

MoveOut helps students discover free items and arrange collection before a moving deadline. This account covers the pickup upgrade in [beb41e7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/beb41e7ee8f8f433c60edf323f05bb6d204df367), the following round's bug fixes, and this round's accounts feature, all on 5 November 2026. Prepared with AI assistance from my instructions, project history and recorded checks. Automated and agent-executed verification is distinguished from personal or classroom use; no user trial is claimed.

## Choosing a problem and defining good

I explored project ideas with ChatGPT, including shared-fridge coordination, but kept asking whether they solved a real problem. Student move-outs supplied a deadline and an observable outcome: an item actually collected. The pivot from Fridge Rescue is in [ab091d7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/ab091d7c22f21d30ab02b9fca04817a2d30bdc6a). The brief separated interest from confirmation, required one confirmed recipient, and excluded payments, delivery and chat — boundaries that gave Claude specific behaviours to implement.

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) established a local waste problem, not evidence that scheduling causes it. [Sloan's small-group software argument](https://www.robinsloan.com/notes/home-cooked-app/) and [Harley's status-visibility guidance](https://www.nngroup.com/articles/visibility-system-status/) were added during documentation review, after the initial implementation — articulating the rationale, not retrospectively proving the design worked. README defines good as clear, reliable handovers; CLAUDE.md translates that into rules, and the specs check selected promises. Usefulness still needs human evaluation.

## Stack and agent workflow

The Node, Hono and SQLite scaffold in [9cda16a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/9cda16a3293dbdca1ff3136df34d8ee65a4c18f0) survived the pivot. Node's built-in SQLite avoided another database service; server-rendered forms kept basic actions usable without JavaScript. This fits the course's one-machine deployment, with records and photos under DATA_DIR — at the cost of synchronous database work, owning migrations, and a live-update design that would need reconsideration across multiple servers. Browser-cookie identity reduces setup but has no account recovery.

My workflow became implementation followed by review: Claude built changes, Codex examined them against the brief, and I returned concrete findings for correction. The review criteria needed to describe what a person should see and do, including rejection and cancellation, rather than merely whether a route returned success. For pickup coordination and accounts, the brief specified two separate browsers and genuinely independent devices as acceptance criteria — already a repository pattern from [be44efe](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/be44efe). This costs review time and can still share a wrong assumption across agents; its value depends on producing inspectable behaviour and regression checks, not reassuring completion messages.

## Corrections that changed the harness

Persistence first exposed an assumption during the pivot: the surviving Fridge Rescue database had an incompatible items table. [491a012](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/491a0129fbbdb9388df6a8f60d851576731f3c97) moved MoveOut to a separate database filename without deleting the old file. Later changes use additive migrations and tests against an older schema — the pattern this round's accounts migration also follows.

Crit 9 added SSE updates in [a0f969a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/a0f969a); [ADR 002](docs/decisions/002-live-updates-preserve-input.md) chooses prompt shared-state updates with protected drafts over full-page reloads. Review found that confirming an already-cancelled application could reserve the item without a valid recipient; guarded updates with rollback became an explicit rule.

Crit 10 added business-action logging; [ADR 003](docs/decisions/003-business-logging.md) explains hashed actor identifiers: nicknames cannot distinguish people reliably, raw cookies would expose credentials.

## Final iterations: discovery and pickup coordination

The public Browse pool widened the original link-only scope. [ADR 004](docs/decisions/004-public-browse-visibility.md) records an explicit Public/Unlisted choice, enforced in the database query; pre-existing pages migrate to unlisted, protecting earlier expectations instead of silently publishing them.

I next asked for practical improvements to collection. The pickup upgrade supplies the missing confirmed time, claimant-controlled travel status, and a reschedule requiring the other party's agreement; before acceptance, the original appointment remains binding. Email was considered and deferred because no external service was configured.

The [pickup implementation](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/beb41e7ee8f8f433c60edf323f05bb6d204df367) includes migration, permission and concurrency tests, and harness rules. A two-browser check caught a draft erased by live updates; the fix protected the whole pickup card while any part was being edited — too coarse, since it also froze shared facts and any incoming reschedule proposal unrelated to the open draft. Static review also flagged an empty reschedule selector when only the current timeslot exists.

## Fixing the two pickup-card bugs

Both were reproduced against a locally running server with two Playwright contexts before being fixed, not patched from the code alone. The reschedule-draft bug traced to `syncPickupCard` checking `isProtected()` on the whole `.pickup-card`. Fixed by splitting the card into `[data-pickup-facts]` (always refreshed) and `[data-reschedule-area]` (skipped only when its own form holds a draft, then marked with a visible "this changed while editing" note rather than silently dropping the update). A related gap: cancelling while a draft was open left departure-status and reschedule buttons enabled, since the staleness pass predated those forms. The empty-selector bug was an ordering mistake — the valid-slot count was checked before excluding the current slot. Both are covered by a new automated test and a saved browser script (`scripts/browser-verify-pickup-card.mjs`, 16 checks).

## Adding accounts without breaking anonymous identity

The brief asked for register/login/logout, linking a browser's existing anonymous pages and requests to an account, reaching that data from a different device, and cross-account isolation — layered on the device-cookie identity, not replacing it. `accounts` (email, scrypt-hashed password) and `account_sessions` (a server-revocable row; the cookie carries only its id) are new tables; `moveouts.creator_account_id` / `applications.claimer_account_id` are nullable, additive columns set only by a claim pass on register/login, matching the signing-in device's own existing rows and never a row another account already claimed. Every ownership check (`isCreator`, `isClaimant`) now matches on device id **or** signed-in account id.

Browser-level testing (`scripts/browser-verify-accounts.mjs`) found a real gap code review missed: the write-side checks were correctly widened, so a second device signed into the right account could already POST a departure-status change, but `GET /m/:id`'s "Your requests" query was separate hand-written SQL that only matched `claimer_device_id` — so that device could act on a request it could never see listed through the UI. Fixed by widening that read query the same way, covered by both an HTTP test and the browser script that caught it.

A second, unrelated bug surfaced while writing the accounts test: `spec/helpers.ts`'s cookie jar read `Set-Cookie` with `Headers#get`, which comma-joins multiple same-named headers into one invalid string — invisible while every route only ever set one cookie, but register/login set two (`device` and `session`) in the same response. Fixed with `Headers#getSetCookie()`, Node's array-returning form.

## Verification and remaining evidence

`pnpm typecheck`, `pnpm test` (65 tests, up from 54), and `pnpm check:evidence` pass against a locally started server. `scripts/browser-verify-pickup-card.mjs` (16 checks) and `scripts/browser-verify-accounts.mjs` (14 checks: claim-on-register, cross-device management, cross-account isolation, logout revoking a replayed session) both report 100%, alongside the pre-existing `scripts/browser-verify.mjs` (34 checks) and `scripts/browse-verify.mjs` (10 checks) run again to confirm no regression.

Local persistence was verified end to end in an isolated `DATA_DIR`: created a page, uploaded a real photo, applied, confirmed, set departure status, proposed a reschedule, registered an account (claiming the page), then killed and restarted the server process against the same data directory. Every record, the account, its server-side session row, and the photo's byte-identical content survived a real process restart; the original session cookie still worked, and a brand-new device could log into the account and see the claimed page.

On the live Fly instance, this round's own unlisted test data (a page, an account, a claimant request) was created, the deploy pushed, and after redeploy the same data was re-read over HTTP with the original cookies reused to confirm write permission survived — not just that the homepage returns 200. A fresh two-browser walkthrough at 1920×1080 and 390×844 against the live, redeployed site — two independent contexts logging into the same account, each managing the same page and application — is reported below with actual observed results.
