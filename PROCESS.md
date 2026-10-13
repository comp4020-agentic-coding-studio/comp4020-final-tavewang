# Process overview

This Crit 8 account draws on the project-selection conversation, Git history
and agent-reported checks. The reflection was prepared with agent assistance.

## Choosing a problem and directing the agent

I used ChatGPT to explore project ideas and prepare a brief for Claude. I
considered shared-fridge coordination, then continued questioning whether the
suggestions addressed a useful problem. My decisive instruction was that the
project should solve a real-world problem. I chose student move-out handovers
and asked for an implementation prompt. MoveOut gave that aim a concrete
deadline and an observable outcome: whether an item was actually collected.
The distinction between expressing interest and agreeing to a pickup also
gave the application a specific coordination problem to address. The detailed
brief was developed with ChatGPT.

The resulting brief specified free collection, a moving deadline, pickup
windows and separate request and item states. It required one confirmed
recipient per item, cancellation that reopens availability, and location
details withheld until confirmation. It excluded payments, delivery and chat.
These boundaries gave Claude a concrete workflow and observable constraints.
The target was a useful handover between a mover and recipients reached through
an existing group, without first building a large public marketplace.

The earlier Fridge Rescue implementation remains in history. The data model
changed in [ab091d7](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/ab091d7c22f21d30ab02b9fca04817a2d30bdc6a),
followed by the MoveOut routes and views in
[3929ad3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/3929ad341d07ca188ce4e020037e911150f693de).
These commits record the implementation; the selection conversation explains
the change of direction.

## Sources and the definition of good

The [ANU Give It Forward project](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/)
provided a local basis for the problem: usable possessions are discarded at
move-out time. Its discussion of convenience helps motivate investigating
handover effort. It does not identify scheduling as the principal cause of
waste or validate this app. That remains a design hypothesis.

Two references were added during this documentation review, after implementation:
Robin Sloan's [*An app can be a home-cooked meal*](https://www.robinsloan.com/notes/home-cooked-app/)
helps explain the value of serving a small group, and Aurora Harley's
[*Visibility of System Status*](https://www.nngroup.com/articles/visibility-system-status/)
provides a rationale for distinguishing interest from a confirmed arrangement.
Their application to MoveOut is an interpretation, not evidence of measured
benefits.

The revised README connects these ideas to specific promises: understandable
states, exclusive reservations, clear next actions and retained outcomes.
`CLAUDE.md` carries implementation rules; `spec/` checks selected invariants.
Whether people understand the labels or need fewer messages requires a user
trial, which has not been documented.

## Stack choice and its costs

The Node, Hono and SQLite scaffold originated in
[9cda16a](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/9cda16a3293dbdca1ff3136df34d8ee65a4c18f0)
and was retained through the pivot. The repository pins Node 24 and uses its
built-in `node:sqlite`, avoiding a separate database service and native addon
build. Hono handles routing and HTML responses. Server-rendered forms keep the
first version small and usable without client-side JavaScript.

For the first version, retaining this stack keeps the main effort on the
handover rules. It fits the course's single-machine deployment and keeps
SQLite and uploaded photos together under `DATA_DIR`, with no separate
database service to operate. The trade-off is synchronous database work in
the server process and a design that needs reconsideration for multiple
machines. The simple forms are adequate for this week's workflow, but shared
updates still require refreshing and need further work for crit 9.

The agent implemented timezone conversion using `Intl` and multipart photo
handling using the runtime's request APIs. This avoids extra dependencies but
leaves conversion edge cases and upload validation as responsibilities of the
application. Keeping dependencies small does not establish those paths are
correct. Browser-cookie identity also reduces setup while leaving account
recovery and cross-device access unsupported.

## State rules and corrections

Items and applications have separate lifecycles. Several people can express
interest while an item remains open. Confirming first performs a guarded
update from `open` to `reserved`; the paired application update is wrapped
in a transaction. The guard selects a winner, while the transaction keeps the
two records consistent if the operation fails. The partial unique index serves
a different purpose: preventing duplicate active applications from one
device. It is not the rule enforcing one confirmed recipient overall.

The tests added in
[d575467](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/d575467753181710d2202ada0a7fd0e9b7565b30)
include competing confirmations and cancellation followed by confirming a
backup. These connect the definition of a reliable arrangement to checks.

A consequential correction appears in
[491a012](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/491a0129fbbdb9388df6a8f60d851576731f3c97).
Its recorded deployment failure involved the old Fridge Rescue database
surviving on the volume with an incompatible `items` table. The fix gave
MoveOut a separate `moveout.db`, preserving the old file. This handles the
project pivot; it is not a migration strategy for future MoveOut schema
changes. Persistence preserves earlier assumptions as well as useful records.

[c819237](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/c819237d703794290178657e5a5ed8b3e0f48f29)
records a live phone-viewport inspection and fixes for overflowing README
code blocks and pickup selects. The diff corroborates the CSS changes; the
inspection itself is described in the commit message. These fixes have not
yet become dedicated layout regression checks. The later visual revision is
recorded in [631cd4b](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/631cd4b71c7d47531d607304bdeafe9defedf002).

## Verification and remaining evidence

There are nine MoveOut tests plus two course invariants, eleven in total.
They exercise selected permission guards, unconfirmed location visibility,
competing confirmations, cancellation, expired applications, repeated reads
of completion records, duplicate applications and withdrawal.

Earlier agent-written notes report local typechecking, scripted walkthroughs,
photo checks and restart persistence. The test commit reports an execution
against a running app, and the mobile-fix commit records a live inspection.
Those reports should not be collapsed into a fresh, comprehensive verification
claim. In particular, a record surviving another HTTP read does not demonstrate
survival across a restart or redeployment. A reproducible before/after check
for both records and photos is still needed in this written evidence.

My documentation-review requests were to expand the reflection and design
references, then remove draft markers. The revised account records the actual
project-selection conversation and identifies sources added after
implementation. The review also corrected unsupported blanket claims about
live persistence. These are writing and evidence corrections, not a new
application test run.

On 7 October 2026, read-only HTTP checks of the Fly homepage and `/readme/`
both returned 200 and displayed MoveOut. The deployed README still contained
the earlier sections, so publishing these local documentation changes remains
necessary. This establishes page availability, not successful booking,
photo persistence or survival across redeployment.

Running `node scripts/check-evidence.ts` passed: the reflection filename was
recognised and all seven cited commits resolved. `git diff --check` also
passed. The `pnpm check:evidence` wrapper could not fetch missing dependencies;
its underlying script was run directly. Application tests were not rerun in
this review. A current end-to-end run and recorded restart/redeployment
checks remain to be completed. User feedback must be recorded after an
actual trial, and future corrections should strengthen the relevant rules
or tests.

## Crit 9: making it real-time, directing the agent, and a review pass

The crit 9 brief asked for one thing beyond "make it real-time": pick one
behaviour for several people using the app at once, write it down, and
accept the crit pod arguing for a different option. My instruction to the
agent was that shared state (who's confirmed, what's still available) had to
update live, but it must never destroy input someone else was still typing —
the scenario I gave it was literally "person A is filling in a request when
person B gets confirmed for the same item; what does A's screen do." That
instruction became
[docs/decisions/002-live-updates-preserve-input.md](docs/decisions/002-live-updates-preserve-input.md),
and drove the whole implementation shape: Server-Sent Events carrying no
data (`src/live.ts`), a client (`src/public/live.js`) that re-fetches the
page it already had permission to see and reconciles the DOM by stable
item/application ids, protecting anything the viewer is actively editing.

### What the first implementation got wrong

I asked for a second, adversarial pass — not "does it work," but "find the
cases where it doesn't" — before calling crit 9 done, and ran the resulting
browser script myself rather than taking a first green run at face value.
That pass found five real defects in the first implementation, all now
fixed and covered by a test:

1. **Reconciliation moved every DOM node on every sync, even ones that
   hadn't changed position.** An *unrelated* change anywhere in a list (the
   mover adding a timeslot) silently dropped a different person's focus
   from a field they were still typing in, because moving a node's DOM
   position always clears its focus. Fixed by only repositioning a node
   when it's actually out of place relative to the freshly-fetched order.
2. **A withdrawn item's still-open request form kept looking usable.** If
   the person had unsaved input in it (so it was "protected" and not
   removed outright), the card just sat there with a live Submit button and
   no indication the item was gone. Fixed with an explicit `markGone` state
   — every control disabled, a stated reason — plus a catch-up reconcile
   that finally removes the card once the person actually stops editing it
   (closes the form, clears the field), rather than only on the next
   unrelated SSE push, which could in practice mean never.
3. **A confirmed application's card showed the new status text but not the
   pickup address**, and its now-pointless "change pickup time" control
   stayed enabled. Status-badge text was the only thing the old code
   treated as safe to patch on a protected card; the address and control
   validity are equally read-only and equally safe, and weren't being
   synced.
4. **The very first item appearing in an already-open, previously-empty
   list never showed up.** `home.ts`'s "Your requests" section is wrapped
   in `<section hidden>` when empty, and the client only ever reconciled a
   list's *children* — never the `hidden` attribute on the section around
   it. A request arriving while that tab sat open updated the (invisible)
   `<ul>` and nothing else.
5. **Confirming an application that had just been cancelled corrupted
   state.** The confirm route's transaction checked whether the *item*
   update changed a row, but returned the *application* update's row count
   as the overall result without checking it — so a stale confirm (page not
   yet refreshed, or a double click) could flip the item to `reserved` with
   no confirmed application pointing at it, a state nothing else recovers
   from. This is the one correctness bug of the five, not a UI one; see
   `CLAUDE.md`'s "Confirming is the one place two requests can race" for the
   fix and the regression test added to `spec/moveout.test.ts`.

My first version of `scripts/browser-verify.mjs` also had its own bugs that
I'd have caught sooner with closer review: it built a `datetime-local`
value from the UTC wall clock while the page interprets that field in
Australia/Sydney (silently writing timeslots already in the past), asserted
a file stayed attached to a form that has no file input, waited on
`networkidle` against a page whose whole point is a long-lived SSE
connection (so it always timed out rather than usefully waiting), and
force-clicked a *disabled* button as if that proved the server rejects the
same action — which it doesn't; the server has to be asked directly. All
four are fixed in the current script, and are explained inline there.

### Environment: a surprise unrelated to the code

A large amount of this session's wall-clock time went to diagnosing the
test runner hanging or timing out with no application-level cause: `jsdom`
imports and `node_modules` reads were sporadically taking minutes, well
past any reasonable I/O time. The cause was environmental, not a bug in
this app: the repository lives under `~/Desktop/...`, which macOS syncs to
iCloud ("Desktop & Documents"), and with the machine's disk nearly full,
macOS was evicting local copies of `node_modules`'s thousands of small
files and re-fetching them from iCloud on each cold read. Moving
`node_modules` to `~/.cache/` and symlinking it back into the repo (already
`.gitignore`d, now ignored as a plain pattern rather than a directory-only
one so the symlink itself still matches) fixed it outright — `pnpm check`
dropped from sometimes-never-finishing to under 3 seconds. This isn't
project-specific knowledge worth a CLAUDE.md rule; it's recorded here only
because the lost time is a real part of this week's account, and because
the `.gitignore` edit it caused is a genuine, if small, tracked change.

### Verification actually run this week

- `pnpm check` (typecheck + `vitest run`): 15/15 tests pass, including the
  pre-existing course invariants and the new confirm-atomicity regression
  test, in under 3 seconds once the environment issue above was fixed.
- `pnpm check:evidence`: passes.
- `scripts/browser-verify.mjs`, run end-to-end against a throwaway
  `DATA_DIR` with real Chrome via Playwright and several independent
  browser contexts (never against production data): 24 checks, 0 failed, on
  the run after the fixes above landed. It measures, not assumes, the delay
  from a write to the resulting DOM update on another open page — every
  timing in this account is a number that script printed, not a guess.
  Measured latencies from that run: applying to confirmed-visible-on-
  manage-page landed within the test's 1.5s budget; confirm to
  pickup-address-visible likewise; new-request to "Your requests" appearing
  on an already-open home page likewise. (`spec/live.test.ts`'s HTTP-level
  timings are far smaller still — single-digit milliseconds from write to
  SSE push — but that number is the server's own push time, not what a
  person watching a real screen experiences; the browser script's numbers
  are the ones that answer the brief's "about a second" for a human.)
- IME composition is verified only with **synthetic** composition events
  dispatched by the script (`CompositionEvent`/`InputEvent` built by hand) —
  Playwright's Chrome has no real operating-system input method attached.
  This proves `live.js`'s own composition guard does the right thing for
  events shaped like a real IME's. It is **not** evidence that a genuine
  Pinyin/Zhuyin/etc. typing session behaves identically; that still needs a
  person testing with a real IME enabled, which I have not done and am not
  claiming.
- Not verified at all this week: an actual crit-room demonstration with two
  physical devices, and a deploy to the course's Fly app (ship, not
  started — see reflections/crit-9.md for what's left).
