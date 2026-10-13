# Process overview

MoveOut coordinates free student move-out handovers. This account covers the project through Crit 9: selection, agent direction, implementation, corrections and current evidence. It was written with agent assistance. The instructions and choices described are mine; the verification below was executed by agents, not a documented personal or classroom trial.

## Choosing the problem and defining good

I used ChatGPT to explore ideas and prepare a brief for Claude. Shared-fridge coordination initially interested me, but I kept asking for something useful that solved a real problem. Student move-out handovers gave that preference a deadline and an observable outcome: whether someone actually collected an item. The useful distinction was between expressing interest and agreeing to collect, rather than simply listing unwanted possessions.

The brief limited MoveOut to free collection, pickup windows, one confirmed recipient per item, cancellation and completed handovers. Exact addresses would remain hidden from unconfirmed recipients. Payments, delivery and chat were excluded. Sharing through an existing group avoided making discovery another project. The pivot is recorded in [ab091d7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/ab091d7c22f21d30ab02b9fca04817a2d30bdc6a), followed by routes and views in [3929ad3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/3929ad341d07ca188ce4e020037e911150f693de).

ANU's [Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/) provides local context for usable items discarded at move-out time. It motivates investigating convenience, but does not prove scheduling is the cause or validate my solution. [Robin Sloan](https://www.robinsloan.com/notes/home-cooked-app/) and [Aurora Harley](https://www.nngroup.com/articles/visibility-system-status/) were added during documentation review after the initial implementation. Their arguments help explain small-group scope and clear status feedback; they were not the original trigger for the project.

README turns that rationale into promises about understandable requests, reliable commitments, next actions and careful handling of details. CLAUDE.md states implementation rules, while tests protect selected invariants. Whether these choices reduce confusion or messages remains a question for users.

## Stack and workflow choices

The Node, Hono and SQLite scaffold originated in [9cda16a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/9cda16a3293dbdca1ff3136df34d8ee65a4c18f0) and survived the pivot. Node 24 supplies SQLite without a separate database service. Hono serves HTML and forms; submissions remain usable without JavaScript. This keeps effort on handover rules and fits the course's single-machine deployment. SQLite and photos share the persistent `DATA_DIR` volume.

The costs are synchronous database work, limited identity through a browser cookie, and no account recovery across devices. Multiple server processes would require reconsidering the live-update transport. Keeping dependencies small also leaves timezone conversion and upload validation as application responsibilities; simplicity alone does not establish correctness.

My workflow separated implementation from review. I asked for prompts to give Claude, then asked Codex to inspect the resulting changes. I used the findings to request concrete fixes and another verification pass. This gave the second agent a different task: checking observable behaviour against the brief, rather than extending its own implementation. The resulting corrections still needed executable evidence.

## The multiplayer decision

For Crit 9, I asked for updates that preserve a person's unfinished form when someone else changes shared state. A recipient typing a request while another recipient is confirmed makes the conflict concrete: silently clearing the draft is disruptive, but continuing to show the item as available is misleading.

[ADR 002](docs/decisions/002-live-updates-preserve-input.md), committed in [066de83](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/066de83), compares refreshing everything, delaying updates during editing, and updating shared information while preserving input. The third option fits README's goals of clear commitments and recoverable cancellation. Its cost is more selective browser update logic.

The implementation in [a0f969a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/a0f969a) uses SSE to signal a change without broadcasting business data. Each viewer re-fetches their page through existing permission checks. The client updates keyed lists and protects active forms. Reusing authorised rendering reduces duplicated access rules, but fetching complete pages costs more than sending small updates. In-memory subscriptions suit one server process, not multiple machines.

## Corrections and evidence

The first review exposed four browser problems: unchanged cards were moved and lost focus; withdrawn items retained usable forms; protected confirmed requests lacked pickup addresses; and initially empty request sections did not appear after an update. Fixes avoid unnecessary node moves, disable obsolete actions while keeping drafts, update addresses and controls, and retain list containers with synchronised visibility. Local focus and collapse events also trigger deferred reconciliation.

A separate existing bug affected database consistency. Confirming a cancelled application could reserve the item before discovering that the application update changed nothing. Returning zero committed the first update. The correction checks both guarded updates and throws to roll back the transaction. The regression in [ceb556a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/ceb556a) verifies rejection and then confirms another valid applicant. CLAUDE.md records the same rule, connecting the correction to future work.

The browser script also required review: it used UTC values for Sydney fields, searched for a file input on a form without one, waited for network idleness despite SSE, and treated clicking a disabled button as a server test. [be44efe](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/be44efe) contains the revised script. It now uses appropriate times and state waits, but still lacks an actual file-selection assertion.

An earlier deployment correction, [491a012](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/491a0129fbbdb9388df6a8f60d851576731f3c97), gave MoveOut its own database filename after the persisted Fridge Rescue schema conflicted with the new model. That solved the pivot, not future schema migration.

## Current verification and remaining work

On 13 October, Codex independently reran Vitest, TypeScript checking and the evidence checker against the reviewed version. All 15 tests passed; type and evidence checks passed. After the composition and withdrawal-summary fixes below, the browser script passed 34 checks against a temporary database with separate Chrome identities. Its timing assertions require selected visible updates within 1.5 seconds; successful output does not print exact latency values.

Separate browser reproductions confirmed the five functional fixes and preservation of an uploaded file, focus and text selection. They also exposed a global pause during input-method composition: another withdrawn item remained visible until composition ended. I requested a focused correction. Two new browser assertions failed on the old implementation, then passed after protection was scoped to the composing element and its ancestors. Shared pickup times and an unrelated withdrawal now update before composition ends, while the original input, text, focus and selection survive. CLAUDE.md records that rule. A further regression exposed the missing live withdrawal summary. Keeping its container rendered and reconciling the count and keyed names now covers zero, one and multiple withdrawals without closing the list or clearing a draft. Real operating-system IME behaviour, classroom use, latest deployment and systematic record/photo persistence across redeployment remain unverified. No user trial or measured waste reduction is claimed.
