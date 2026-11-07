# MoveOut development rules

Rules for working on MoveOut, derived from the design decisions in
`README.md`'s "What good means here" section and `PROCESS.md`'s decisions. If a
change would break one of these, it needs README's argument updated first,
not a quiet exception here.

## Identity, ownership, and the share link

- Resolve the current account from the server-side session row through
  `src/session.ts#deviceMiddleware`. The `device` cookie identifies a
  browser and recognises its unbound legacy records; it is not an
  alternative credential for an account-bound record.
- `src/ownership.ts#matchesOwner` defines ownership for creators, claimants
  and proposers through `isCreator`, `isClaimant` and `isProposer`:
  a non-null account id requires that exact signed-in account; a null
  account id uses the original device id. Never widen this to device OR
  account, and never trust a submitted owner id or nickname.
- Apply the same ownership rule in read queries and write guards.
  `ownerMatchSql` supports queries such as the public page's own-request
  list. An account's My MoveOut lists its associated records across
  devices. Retain access to an unbound conflict through the current
  browser's item-page link so the signed-in user can resolve it.
- A nickname is display text. Two devices signed into one account are the
  same account; two accounts sharing a device remain different owners.
- `/m/:id` is a share link, never management authorization. Do not introduce
  an admin query parameter or management token that bypasses ownership.
  Public/Unlisted controls discovery, not permission to manage a page.
- Only the authorised creator and confirmed claimant may see the exact
  pickup location. Public cards and search must not expose it.

## Login, sessions and legacy association

- Email/password accounts are required for every business write: creating
  pages, publishing items or photos, changing timeslots or visibility,
  applying, withdrawing, confirming, cancelling, completing, reporting
  departure, and all reschedule actions. Call `requireSignedIn` before
  ownership checks, database mutations or saving uploads. Recognising an
  unbound legacy record's device alone does not permit a write.
- Browse, search and public page viewing remain available without login.
  A login redirect uses `safeNextPath` and a destination within this app; never
  accept an external return URL or automatically replay a pending write.
- The `session` cookie holds an unguessable id for an `account_sessions`
  row. Resolve it on each request. Logout deletes that session row and
  clears the cookie; replaying it must fail. Other independently created
  sessions for the same account remain valid. An already-open SSE stream
  only signals changes; its page fetch must recheck current permissions.
- Passwords use salted scrypt hashes and `timingSafeEqual`, never plaintext
  or reversible encoding. Keep login rejection text the same for an unknown
  email and an incorrect password. Do not log passwords or session tokens.
- Account-aware HTML routes use `Cache-Control: private, no-store`.
  Cache policy does not replace the live permission-loss handling below.
- `hasUnclaimedAnonymousData` may indicate that this browser has older
  data. It grants no permission by itself. Registration/login attempts
  association through `claimAnonymousDataForAccount`, using the current
  server-resolved device and account, never arbitrary submitted identities.
- Association may touch only this device's unbound rows or rows already
  associated with the same account. Never reassign another account's data.
  Keep ids, history and relationships, including the device's reschedule
  proposals. Repeating association must preserve the same ownership;
  current counts can include rows already linked to this account.
- The association pass uses one outer transaction. Application and proposal
  updates use per-row savepoints: an expected uniqueness conflict leaves
  that row unchanged while other valid associations can commit. This
  deliberate partial result differs from an unexpected database failure,
  which must roll back the outer transaction and remain visible as an error.
- A duplicate-request association conflict must not block otherwise valid
  login. Report linked records and unresolved requests separately, name the
  conflicting item, and provide its real page link. Never silently delete,
  cancel or force-link a conflicted request. The user can choose which
  duplicate to cancel and sign in again to retry association.
- Resolving an unbound conflict still requires login plus ownership of the
  original device. Successfully associated records require their account
  thereafter, including after logout or switching to another account.
- Keep regression coverage for logout with the original device cookie,
  account switching, anonymous legacy writes, cross-device access, wrong
  passwords, association conflicts, repeat association and existing bookings.
  See `spec/accounts.test.ts`, `spec/permission-regression.test.ts`,
  `spec/claim-conflict.test.ts` and the corresponding browser scripts.

## Public browse pool (final iteration)

- `moveouts.visibility` (`public` / `unlisted`) is a separate concern from
  the creator/claimant ownership model above — it answers "can a stranger
  *find* this page," not "can they manage it." A page's own link always
  works at either setting; only Browse's pool and search are gated by it.
  See [ADR 004](docs/decisions/004-public-browse-visibility.md).
- Every page predating public discovery migrated to `unlisted` (`src/db.ts`), never
  `public` — a page created before this flag existed must never become more
  exposed than its creator agreed to, migration or not. Never change that
  default without re-reading ADR 004 first.
- `POST /m/:id/visibility` is creator-only, exactly like every other
  management action, and server-validates the new value against the fixed
  `'public' | 'unlisted'` set — never trust the submitted string directly
  into a column with a `CHECK` constraint built for exactly two values.
- `src/ownership.ts#listBrowseItems` / `#countBrowseItems` are the **only**
  code path that may return items to an unauthenticated visitor by anything
  other than a single move-out's own id. Their `WHERE` clause —
  `visibility = 'public' AND status = 'open' AND deadline_at > now` — lives
  in the SQL itself, not as a post-fetch filter in application code or the
  browser. Any new "browse"-shaped feature (a different sort, a saved-search
  page, anything) must go through this same query surface, never read the
  `items`/`moveouts` tables directly and re-implement the visibility check.
- The pool query selects only what a public card needs (name, category,
  area, deadline, status, photo path) — never joins in `applications`,
  never selects `pickup_location`, `claimer_nickname`, or `note`. If a future
  card needs a new field, add it to the `SELECT` explicitly; don't widen it
  to `SELECT *` across the join.
- `category` is a fixed, closed set (`src/db.ts#ITEM_CATEGORIES`), validated
  server-side (`isItemCategory`) wherever it's read from a form or a query
  string — never trusted from a raw string, since it's also a `CHECK`
  constraint on the column. An unrecognised category value falls back to
  "Other" (new items) or "no category filter" (Browse's `?category=`),
  never a 500 or a raw string reaching SQL.
- Search matches only `items.name` and the item's own public
  `condition_notes`/`additional_notes` — never `applications.note`, never
  `claimer_nickname`, never `pickup_location`. If search ever needs to cover
  a new field, check first whether that field is meant to be public at all.
- Any write that changes whether an item should appear in the pool (added,
  withdrawn, confirmed, a cancelled confirmation reopening it) or that
  changes a page's visibility must call `notifyPublicPool()`
  (`src/live.ts`) — guarded by `if (moveout.visibility === "public")` where
  that's known, since there's no reason to wake every Browse tab for a
  write on an unlisted page. Forgetting this call doesn't break anything
  immediately (the next full reload still shows the truth) — it just means
  an already-open Browse tab goes stale, which is what crit 9's whole
  real-time apparatus (see below) exists to prevent.

## One active request per account or unbound device

- `applications_one_active_per_identity` is the database invariant: at most
  one pending/confirmed application per item and
  `COALESCE(claimer_account_id, claimer_device_id)`. A bound account cannot
  submit a second active request from another device. Different accounts
  on one device may each apply. Cancelled/completed history does not prevent
  a new application when the item's state permits it.
- Enforce uniqueness in the database, not only with an earlier SELECT.
  Tests must reject a same-account duplicate and permit different-account
  requests on one device. A cancelled request never becomes active again;
  reapplying creates a new record.
- The existing `dedupeDuplicateAccountApplications` migration resolves
  pre-index account duplicates once: retain a confirmed request if present,
  otherwise the oldest pending request, and cancel other active duplicates
  with a recorded reason. It preserves rows and history. This specific
  migration is not permission to silently cancel future association
  conflicts; those remain unchanged for the user to resolve as above.
- Never recreate `applications_one_active_per_device` during startup.
  Its unconditional creation was removed in `c7fe3ce`; startup drops any
  surviving old index and ensures the current identity index exists.
  Fresh, legacy and already-migrated databases must all reach the current
  schema without imposing the superseded device-only constraint first.
- Preserve tests that generate valid different-account requests on one
  device through HTTP, stop the server, restart with the same DATA_DIR,
  repeat the restart, and check records and permissions. Also test old
  duplicate fixtures and repeat migrations. See
  `spec/restart-after-account-scoped-applications.test.ts` and
  `spec/duplicate-application-migration.test.ts`.

## Two status columns, not one

`items.status` (`open` / `reserved` / `handed_over` / `withdrawn`) and
`applications.status` (`pending` / `confirmed` / `cancelled` / `completed`)
are separate columns on separate tables, by design — don't collapse them into
one field. An item can have several pending applications from different
people, but at most one confirmed recipient. Each account or unbound device
has at most one active application per item. The item's status outlives any
single application's row.

Transitions, and who may cause them:

- `pending → confirmed`: creator only, and only if the item is still `open`
  **and** the application's chosen timeslot hasn't already passed — if it has,
  the fix is for the claimant to change their own timeslot
  (`POST /applications/:id/timeslot`), never a creator override.
- `pending|confirmed → cancelled`: the claimant, on their own application, any
  time. The creator, only on a `confirmed` one, and only with a non-empty
  reason that gets stored and shown back to the claimant — never a silent
  revocation of a confirmed booking.
- `confirmed → completed`: creator only.
- `open → withdrawn`: creator only, and only while the item is still `open`
  — an item with a confirmed reservation must be unclaimed (cancelled) first,
  never withdrawn out from under a confirmed claimant. Withdrawing cascades
  to auto-cancel that item's still-pending applications (reason: "Item
  withdrawn by the mover") rather than leaving them stranded and unreachable.
- `reserved → open`: automatic, inside the same transaction as cancelling the
  confirmed application that held it — never a separate manual step.

`cancelled` and `completed` are terminal. Nothing ever moves an application
out of either state.

## Guard state transitions and confirmation races

Guard every state transition with a single `UPDATE ... WHERE id = ? AND
status = '<required current state>'` — never read-then-check-then-write. This
is what makes two simultaneous confirmations on different pending
applications for the *same item* resolve to exactly one winner: both
requests run the identical guarded `items.status = 'open' → 'reserved'`
update, and only one can still find `status = 'open'` once the other's write
has landed (Node's single-threaded loop plus `node:sqlite`'s synchronous
calls mean the two can't interleave mid-statement). If a double-confirmation
bug ever shows up, the fix is a missing or wrong `WHERE` clause, not a lock,
a queue, or an application-level mutex.

`/applications/:id/confirm` guards **two** rows this way inside one
transaction — `items.status: 'open' → 'reserved'` and
`applications.status: 'pending' → 'confirmed'` — and **both** guards'
results must be checked, not just the first. A real bug fixed in crit-9
review: confirming an application that had just been cancelled (stale page,
double-click) found the item still `open` (so that `UPDATE` succeeded,
`changes === 1`) but the application no longer `pending` (so its `UPDATE`
correctly matched zero rows) — and the route returned the *application*
update's `changes` as the overall result without ever checking whether the
*item* update should be undone. The item ended up `reserved` with no
confirmed application pointing at it: effectively stuck, since nothing else
transitions `reserved → open` except cancelling a confirmed booking that
didn't exist. The fix: throw inside the transaction the moment **either**
guarded update reports zero rows changed, so `withTransaction`'s `ROLLBACK`
undoes the item's write too — a transaction's atomicity only protects you if
every step's own success is actually checked before you decide the whole
thing succeeded. See the regression test in `spec/moveout.test.ts`
("confirming an already-cancelled application...").

`src/db.ts`'s `withTransaction` wraps the item+application pair of updates
for atomicity (all-or-nothing if something throws); the concurrency guarantee
itself comes from the guarded `WHERE`, not from the transaction boundary.

## The deadline gate

Applying and confirming both check `now <= moveouts.deadline_at` and refuse
once it's passed. Cancelling and completing are **never** blocked by the
deadline — an existing confirmed booking must stay actionable (so it can
still be marked picked up, or cancelled with a reason) after the deadline
passes. Nothing auto-completes, auto-withdraws, or auto-cancels anything
because a deadline passed — every transition is an explicit action by a
person, never a background sweep.

## Timezones

A move-out page declares one IANA timezone (`moveouts.timezone`, default
`Australia/Sydney`). Every deadline and timeslot is stored as a real UTC
instant (`src/tz.ts#zonedDateTimeToUtc`), converted from the wall-clock value
entered in that timezone — never stored as a naive local string, and never
compared against `now` without first being a real instant. Display always
names the timezone (`formatInZone`) rather than leaving it implicit.

## Persistence

All durable state — accounts, sessions, move-out pages, timeslots, items,
applications, reschedule proposals and uploaded photos — lives under `DATA_DIR` (the SQLite file plus
`DATA_DIR/uploads/`). Nothing load-bearing goes in a module-level variable,
browser storage, or a container path outside `DATA_DIR`.

The one deliberate exception: `src/live.ts`'s in-memory subscriber lists for
the SSE streams. That's transport state, not a business record — losing it
on a restart just means every open tab's `EventSource` reconnects (it does
this on its own; see below) and re-syncs, not that anything was lost. Don't
promote it to a table, and don't add anything *else* to it beyond "who's
currently listening."

## Real-time updates (crit 9)

- The SSE stream (`GET /m/:id/events`, `GET /events`) carries no data — just
  "something changed" (`src/live.ts`). The client's only response to it is to
  re-fetch the exact page it already had permission to see, through the
  exact same route and ownership checks as a manual reload. **Never** put
  application data on that stream directly; the moment it needs to, it needs
  its own permission check, which defeats the reason it doesn't have one now.
- `src/live.ts` has four signal buses: `moveoutBus`, `deviceBus`,
  `accountBus` and the public `poolBus`. Writes notify the relevant page,
  affected devices and affected accounts. Use account ids from verified
  sessions or stored records whose permissions have been checked; a mover
  confirming a request must notify the claimant's account, not only the
  mover's. Never accept a client-selected subscription identity.
- `/events` subscribes to the viewer's device and, when signed in, account.
  `/m/:id/events` also subscribes to the page. Unsubscribe all listeners
  when the stream closes. Preserve tests that another device on the same
  account sees its My MoveOut list update without a reload.
- **A permission failure and a network failure need different client-side
  treatment, and conflating them was a real vulnerability.** Before this
  round, `src/public/live.js#resync`'s `catch` block handled EVERY failed
  re-fetch — a dropped connection, a 500, AND a 401/403 from a since-revoked
  session — identically: show "Could not sync — retrying" and schedule
  another attempt on an exponential backoff, forever, while the DOM still
  shows whatever private content that tab fetched before access was lost.
  Logging out in one tab (or switching accounts) never cleared a *different*
  already-open tab's confirmed pickup address, "My MoveOut" entries, or
  management controls — it just kept silently re-fetching a URL it could
  never read again. `resync` now checks the response status BEFORE falling
  into the retry branch: a 401/403 stops the SSE connection and any pending
  reconnect/retry timer, then hard-navigates (`window.location.replace`) to
  the same URL, so the SERVER's own rendered response (its real not-found/
  forbidden/login view, built the same way a signed-out visitor's manual
  reload would be) replaces the stale DOM. This doesn't add a new
  client-side permission check — the server remains the sole authority
  throughout, exactly as the next two bullets require — it only stops a
  tab that's already been told "no" from pretending otherwise.
- `POST /logout` deletes only the current session and signals the device
  and account buses. Other devices may receive the signal and re-fetch,
  but their independent sessions must remain valid. A notification is not
  revocation. Verify the actual DOM of another open tab after logout,
  rather than treating a rejected HTTP request as proof it was cleared.
- A write that depends on current state (confirm, cancel, apply, change
  timeslot) is validated against the live database row by its guarded
  `UPDATE ... WHERE status = '<state>'`, same as always — the real-time path
  adds no second way to call these routes and no reason to trust what a
  client's on-screen state claims is true. `src/public/live.js` only ever
  re-fetches and re-POSTs through the existing routes.
- During authorised live updates, `src/public/live.js` preserves a DOM node the person is actively using
  — an open `<details>`, a changed input/select, a chosen file (the mover's
  add-item photo — the claimant's apply form has no file input), current
  keyboard focus, an in-progress IME composition (`isProtected`). It still
  patches the safe, read-only parts of a protected node in place (status badge, tone, an
  item's availability note, a now-visible pickup address, whether an open
  sub-form's controls still make sense) — see `patchSafeBits` and
  `syncApplicationStatus`. Structural changes held back by a draft must
  show a visible stale-state notice. Permission loss takes priority over
  draft preservation and must remove private content.
- IME composition protects only the active input and its ancestors. Other
  entities and safe shared-state updates must continue during composition;
  never return early from page-wide resync because an input is composing.
  Do not move its ancestor nodes until composition ends, then reconcile the
  latest fetched state through `scheduleCatchUp`.
- During an authorised update, a node that's **gone entirely** from the server's
  current page (withdrawn, or moved from "upcoming" to "completed") and is
  still protected is never silently left looking valid: `markGone` disables
  every control on it and adds an explicit notice, without touching the
  person's typed input. The actual removal happens once they stop editing it
  (`scheduleCatchUp`, fired on `focusout`/`<details>` closing) — never on a
  separate, unrelated SSE push that may not arrive for a while. This does
  not override the permission-loss rule above.
- **Reconciliation never moves a DOM node that's already in the right
  place.** A card's position is only changed when it's genuinely out of
  order relative to the newly-fetched list — not on every sync regardless of
  whether anything reordered. Moving a node that contains the focused
  element drops focus to `<body>` (the DOM doesn't preserve it across a
  reposition), so this was a real bug: an *unrelated* list change anywhere
  on the page could silently kick someone out of a field they were still
  typing in, elsewhere in the same list.
- A `<section hidden>` wrapping a list (e.g. home's "Your requests", empty
  until the first application exists) is itself shared read-only state —
  `reconcile`'s `syncSectionVisibility` toggles its `hidden` attribute every
  sync, independent of whatever's protected inside. Reconciling only a
  list's *children* and never the section wrapping it is the bug this
  guards against: the first row ever added to an open tab updated the
  list but left the whole section invisible around it.
- The withdrawn-items summary and keyed list must sync even when initially
  empty. Keep the container mounted, update its count and visibility, and
  preserve the viewer's expanded/collapsed choice and unrelated form drafts.
- Never auto-replay a write whose outcome is unknown (a failed `fetch`,
  a dropped connection mid-request). Show the error, leave the person's input
  alone, and make *them* decide whether to resubmit — don't guess for them.
- Connection status (`#connection-status`) reflects what the SSE connection
  and the last resync fetch actually did, never `navigator.onLine` — a
  machine can report "online" while this app's own connection is down.
- Browse (`GET /`) follows the exact same pattern as any other page here: the
  public pool bus (`notifyPublicPool`/`onPublicPoolChange`, `src/live.ts`)
  signals "something changed," and the one subscriber (`src/public/live.js`,
  via `data-live="/browse/events"`) re-fetches `location.href` — meaning
  whatever `?q=`/`?category=`/`?sort=` the visitor currently has, not a
  fixed unfiltered URL. Reconciliation (`isProtected`, `patchSafeBits`) is
  unchanged by this: an in-progress search draft, an open `<details>`, or a
  chosen `<select>` on the Browse grid is protected exactly like a draft
  application form is anywhere else in the app. Don't special-case Browse's
  reconciliation; if something about it needs different behaviour, that's a
  sign the generic reconcile logic needs to learn a new case, not that
  Browse needs its own separate client-side path.

## The confirmed pickup arrangement (final project)

- `src/views/pickup-card.ts#pickupArrangementCard` is the **one** place the
  confirmed timeslot, pickup location, travel status, and any pending
  reschedule render — used by both the claimant's own request card
  (`moveout-public.ts`) and the creator's upcoming-handoff card
  (`moveout-manage.ts`). Don't duplicate this markup elsewhere; a new surface
  that needs to show the arrangement calls this function.
- The exact pickup location rule from above still applies here unchanged:
  this card only ever renders for the confirmed claimant or the creator,
  never anyone else, because it's reached only from routes that already
  enforce that.
- The card's markup is split into two wrappers on purpose —
  `[data-pickup-facts]` (confirmed time, location, travel status: always
  read-only, never a draft) and `[data-reschedule-area]` (either the pending
  proposal's accept/decline/withdraw controls, the propose-a-new-time form,
  or a "nothing to propose" message) — because `src/public/live.js`'s
  `syncPickupCard` reconciles them independently. **Bug, fixed**: the first
  version checked `isProtected()` on the whole card and skipped the entire
  sync whenever a draft existed ANYWHERE inside it, so a claimant with an
  open "propose a different time" draft never found out about the other
  party's own reschedule proposal arriving, or even that their own confirmed
  time/pickup location had changed — not because any of that was itself a
  draft, but because something else in the same card was. If you add a new
  field to this card, decide which wrapper it belongs in; don't add a third
  wrapper without also teaching `syncPickupCard` about it, or it'll silently
  inherit whichever neighbour's protection status it happens to sit next to.
- When `[data-reschedule-area]` genuinely can't sync because its own open
  propose-form holds a draft, it leaves a `[data-live-note]` explaining that
  the arrangement changed, the same "kept but visibly stale" treatment
  `markGone` gives any other protected entity that's fallen behind — never
  silently drop the incoming update or clear an authorised draft. Loss of
  permission still requires removing private content.

## Departure (travel) status

- `applications.departure_status` (`not_departed` / `departed` / `arrived`)
  is a separate lifecycle from `applications.status` and `items.status` —
  don't fold it into either. It only has meaning while the application is
  `confirmed`; `POST /applications/:id/departure` is guarded by `WHERE
  status = 'confirmed'`, same discipline as every other transition here.
- Claimant-only, and free movement between all three values — never a
  one-way ratchet. A claimant correcting a misclick (accidentally tapped
  "Arrived") is a normal case, not an error.
- "Arrived" is not "handed over." The creator's existing `complete` action
  is still the only thing that ends the booking.
- Rendered as three plain buttons, not a `<select>` — `src/public/live.js`'s
  `isProtected()` treats any `<select>` moved off its first option as an
  unfinished draft, which would permanently stop this card's live sync the
  moment a claimant picked a non-default value. Don't change this control
  back to a `<select>` without re-solving that.
- Cancelling or completing blocks any further departure-status change — no
  special-case check for this; it falls out of the same `WHERE status =
  'confirmed'` guard.
- When a cancel/complete transition lands while a viewer's propose-reschedule
  draft is protecting `[data-reschedule-area]` from the structural resync
  above, `syncApplicationStatus` is what disables the now-stale departure
  and reschedule (propose/accept/decline/withdraw) buttons on the spot — it
  can't wait for `syncPickupCard`'s own area-level sync, which is correctly
  skipped while that draft is open. **Bug, fixed**: this disabling pass
  predates departure status and reschedule entirely and only knew about
  `/cancel` and `/timeslot` forms, so a claimant with an open reschedule
  draft whose booking got cancelled kept fully-enabled buttons that would
  409 if clicked. If a future action needs the same "disable once terminal"
  treatment, add its form selector here, not just to the read-only text.

## Mutual reschedule

- `reschedule_proposals` records a proposal to move a **confirmed**
  application to a different timeslot already on the same move-out page —
  never a second, parallel timeslot system. A page's existing "add a pickup
  time" form is the only way a new candidate time comes into being; the
  reschedule routes only ever pick among what's already there.
- Either the creator or the claimant may propose; the **other** party must
  accept — `src/routes/reschedule.ts`'s `accept`/`decline` routes reject the
  proposer outright (403 for self-accept-attempt, since declining one's own
  proposal makes no sense either — withdraw instead). A third party (anyone
  who isn't the creator or this specific claimant) gets 404, same as every
  other ownership check in this app.
- At most one `pending` proposal per application at a time, enforced by
  `reschedule_one_pending_per_application`, a partial unique index — the
  same pattern as `applications_one_active_per_identity`. Put new "only one
  active X" rules in the schema, not application code, so two concurrent
  requests can't both win.
- The original confirmed time stays in effect, unchanged, until a proposal
  is actually `accepted` — never on propose, never on an unresolved "pending"
  state. The UI must keep saying so explicitly ("the original pickup time is
  still in effect") so nobody reads a pending proposal as already settled.
- Accepting re-validates, inside one transaction: the proposal is still
  `pending`, the application is still `confirmed`, and the target timeslot's
  start hasn't already passed — any one of those failing rolls back the
  whole thing and reports a specific conflict, never a partial update. A
  proposal whose own target time has since passed is then marked `invalidated`
  outside the rolled-back transaction (not left sitting as `pending` forever) so it
  can't jam the one-pending-per-application slot for a legitimate new
  proposal.
- Accepting moves `applications.timeslot_id` and resets
  `departure_status` to `'not_departed'` in the same transaction — a new
  time means "on the way" from before no longer means anything.
- Cancelling or completing an application invalidates any `pending`
  proposal on it outright (`invalidatePendingReschedule` in
  `src/routes/applications.ts`) — a reschedule has nothing left to apply to
  once the booking it's attached to is gone. Never leave a `pending` row
  dangling off a cancelled/completed application for a stale page to try to
  accept later.
- A new candidate timeslot must belong to the **same** move-out page, must
  not be the application's current timeslot, must not have already started,
  and must **end** by the page's deadline — `endsAt`, not just `startsAt`;
  the existing add-timeslot route only checks `startsAt` against the
  deadline, so a timeslot can exist whose end overruns it, and the
  reschedule route is what has to catch that for its own purposes.
- The item stays `reserved` throughout a pending reschedule — never
  reopened, never auto-promoted to a waitlisted applicant. A reschedule is a
  negotiation between the two parties already matched; it never touches the
  waitlist.
- `pickupArrangementCard` decides whether to show the propose-a-new-time
  form by computing the actually-offerable slots (every valid slot **minus**
  the application's own current one) first, then checking THAT list's
  length — never the other way around. **Bug, fixed**: the first version
  checked `validSlotsForReschedule.length > 0` before excluding the current
  timeslot, so a page with exactly one timeslot (the one already confirmed)
  rendered a `<details>` with a `<select required>` and zero `<option>`s —
  open-able but never submittable. When there's nothing to propose, show the
  plain-language explanation (`"No other pickup time is available..."`),
  worded for the viewer's own role, instead of an empty control.

## Business-action logging (crit 10)

`src/log.ts#logEvent` is the one place that writes the server's business log
(one JSON line to stdout per real action — create, add item, add timeslot,
apply, confirm, cancel, complete, change timeslot, withdraw). See [ADR
003](docs/decisions/003-business-logging.md) for why it's shaped this way.
Rules a route handler must follow when calling it:

- **Actor is always the server-resolved `deviceId`** (`c.get("deviceId")`),
  never a client-supplied field. This log identifies a browser actor; it is
  not the account ownership rule and does not unify devices into one actor.
  `logEvent` hashes it before writing — never
  call `console.log`/write the raw `deviceId` (or anything derived from the
  `device` cookie) anywhere else in a route.
- **`outcome: "success"` only after the database write actually committed.**
  For a guarded `UPDATE ... WHERE status = '<state>'` inside a transaction,
  that means after confirming `changes > 0` (or, for the two-row confirm
  transaction, after both guards passed) — never before the write, never
  inside a `try` block that might still roll back.
- **A rejected write is never `success`.** Use `denied` for an ownership/
  permission check failing (wrong account or legacy device), `invalid` for a validation or
  state-precondition failure (deadline passed, nickname missing), `conflict`
  for losing a race or acting on an already-settled row (409s), and `error`
  only for a genuine unexpected exception — don't collapse all four into one
  bucket, and don't let an unexpected server error get miscategorised as a
  business `conflict` (that's what `error` is for).
- **Use `affectedDevice` whenever the actor is acting on someone else's
  row** (a creator confirming, cancelling, or completing a claimant's
  application) — `logEvent` only emits it when it actually differs from the
  actor, so the common case (a claimant acting on their own request) stays
  one-identity. This is what lets a crit narrator say "the mover confirmed
  Bob's request," not just "something happened."
- **Never log a nickname, a note, a pickup address, a cancellation reason,
  or any other free-text field.** Pass only ids (`moveoutId`, `itemId`,
  `timeslotId`, `applicationId`) and a short fixed `reasonCode` string you
  chose yourself in the route — never interpolate user input into
  `reasonCode`.
- **Don't let this log get buried by anything high-frequency.** Static
  asset requests, the SSE heartbeat/ping, and route lookups that 404 on a
  not-found resource (as opposed to a real permission denial) don't call
  `logEvent` — it exists for the handful of state-changing writes per
  minute a real crit produces, not a general access log.

## Accessibility and legibility

- Status is always shown as text ("Waiting for confirmation", "Confirmed —
  pickup details below"), never colour alone.
- Every interactive control is a real `<form>`/`<button>`/`<input>`/`<select>`
  with an associated `<label>` — keyboard-operable by default.
- Validation errors explain what was wrong and preserve ordinary form input.
  Never echo passwords; lost permission takes priority over retaining a draft.

## Current scope — don't quietly expand it

The authorised product is a public discovery pool with search, category
filtering, two sorts (newest and soonest deadline), and Public/Unlisted
pages. Pickup coordination includes the confirmed arrangement card,
claimant-controlled travel status and mutual rescheduling. Email/password
accounts, cross-device access, legacy-data association, login gates and
their permission/migration fixes are also in scope.

Payments, bidding, delivery, in-app chat, comments, likes/follows, ratings,
AI recommendations, campus identity login, email/SMS notifications,
automatic backup-promotion, calendar integration, partial-quantity requests,
presence lists, pickup-capacity limits and social profiles remain outside
scope. There is currently no password-reset flow. A proposed expansion must
first explain its purpose in README's definition of good and identify the
rules and checks it requires.
