# Fridge Rescue

A shared fridge has an inventory problem nobody wants to own: things go
unnoticed until they're rotten, and nobody's sure what's actually free to eat.
Fridge Rescue is a small, multi-user web app for a house of flatmates to track
what's in the fridge, which of it its owner is happy to share, who's claimed
what, and what's already been eaten — so two people don't reach for the same
half-bag of spinach, and nothing good goes to waste in silence.

## What this app is

- A **fridge** belongs to one household. Anyone with its invite link can join.
- A **member** is a person in that fridge, known by a nickname they pick when
  they join — no account, no email.
- An **item** belongs to the member who added it. Its owner decides whether
  it's just _kept_ (visible, but private) or _shareable_ (anyone else in the
  fridge can claim it). Once claimed, it's reserved for that person until they
  give it back or mark it used.

The scenario this is built around: I have half a bag of spinach I won't finish
before I leave for the weekend. I mark it shareable. A flatmate sees it, claims
it so nobody else takes it too, and later marks it used. The spinach's story —
who kept it, who claimed it, when it was used — stays in the fridge's history
even after it's gone.

## Core flow

1. Create a fridge (give it a name, give yourself a nickname) or join one via
   an invite link.
2. Add an item: a name, and optionally a quantity, a date you're hoping to use
   it by, and whether it's shareable.
3. The owner can edit it, or toggle sharing, any time nobody's claimed it.
4. Anyone else in the fridge can claim a shareable item — one claim at a time,
   enforced by the server, not just by hiding a button.
5. The claimant can give it back (unclaiming it) or mark it used. The owner can
   mark their own unclaimed item used directly.
6. Used items move to a **history** view and stay there — owner, claimant, and
   when, all kept, nothing deleted.

## This week's scope (crit 8)

Built: everything above, persisted to SQLite on the Fly volume, so it survives
a refresh, a restart, and a redeploy. Multiple people can use the same fridge
from their own browsers today — they just refresh to see each other's changes;
real-time updates are next week's spec (crit 9), and the data model here was
chosen so that doesn't require a rewrite.

Deliberately not built yet (see the final project brief's "not implemented"
list this maps to): AI recipes, barcode/photo recognition, shopping lists,
notifications, leaderboards, real accounts, partial-quantity claims, real-time
sync.

## Running it

```sh
pnpm install
pnpm dev            # http://localhost:8080, data in ./data/app.db
pnpm check          # typecheck + the spec, against a running instance
```

`DATA_DIR` controls where the SQLite file lives (`/data` in the deployed
container, via `fly.toml`'s volume mount; `./data` locally by default).

## What "good" means for this app — first draft

This is a first, rough pass, written before most of a week of real use — it's
expected to change as the pod and I actually live with it.

1. **Adding an item is simple.** One required field (name); everything else —
   quantity, a use-by date, sharing — is optional and changeable later. Nobody
   should have to fill in a form to avoid a fridge disaster.
2. **Nothing can be claimed without its owner's say-so.** Sharing is opt-in and
   off by default; an item is only ever claimable because its owner actively
   marked it so.
3. **Claim state is unambiguous and never double-booked.** One item, one
   claimant at a time, enforced by the database, not the UI — two people
   tapping "claim" within the same second still only lets one through.
4. **Unclaiming carries no penalty.** Changing your mind about a claimed item
   is a plain, visible action, not something that ranks or shames a flatmate
   for giving something back.
5. **What happened stays recorded.** Claims and uses aren't deleted; the
   history view is the house's shared memory of who had what.

**TODO (you):** this list is a starting argument, not a finished one. Before
the crit, decide: do you actually believe these five are the right ones, or
the right order? Is there a sixth thing you've noticed matters more once
people were actually using it (e.g. how use-by dates should or shouldn't imply
food safety, or how strangers vs. housemates should be treated differently)?
Say so in your own words — the marker reads this page first, and a rewritten
version in your own voice is worth more than five points you didn't choose.

**TODO (you):** add a sentence here naming anything you deliberately decided
*not* to build this week and why it was the right cut, if that isn't obvious
from "This week's scope" above.

## What I looked at while deciding this

Two pieces came up while thinking about what "good" means for an app sized for
one household rather than the general public (found via search, summarised
here — read them yourself before citing them as something that shaped your
thinking, rather than citing this summary):

- Robin Sloan, [**"The home-cooked app"**](https://www.robinsloan.com/notes/home-cooked-app/)
  (2020) and its five-years-later
  [follow-up](https://www.robinsloan.com/lab/five-years-of-home-cooked-apps/)
  (2025) — software built for a small, known group of people (his own family,
  in his case) that answers to them rather than to growth or a market, and
  that's allowed to just be finished rather than endlessly redesigned. Relevant
  here because a shared-fridge app for one house is about as "home-cooked" as
  this brief gets.
- Ben Hoyt, [**"The small web is beautiful"**](https://benhoyt.com/writings/the-small-web-is-beautiful/) —
  an argument for small, simple software as a positive design choice (fewer
  moving parts, easier to understand end-to-end, cheaper to run) rather than a
  compromise. Relevant to the "smallest schema that can carry the core
  interaction" choice in `PROCESS.md`.

**TODO (you):** if you actually read either of these (or something better),
replace this paragraph with what you think, specifically — where you agree,
where Fridge Rescue doesn't live up to the idea yet, or where a shared fridge
is different enough from a solo home-cooked app that the comparison breaks.

## What can and can't be checked automatically

Checkable, and covered in `spec/`: an item can't be claimed unless its owner
shared it; a non-member can't read or change another fridge's data; two
simultaneous claims on the same item resolve to exactly one winner; only a
claimant can unclaim their own claim; a used item still appears in history
with its owner, claimant, and status intact.

Only a person can judge: whether the interface actually reads as "a shared
kitchen" rather than a generic form; whether the wording around claiming and
using feels low-stakes rather than naggy; whether the five-point "good"
argument above holds up once someone other than me is relying on it at a crit.

## Known limits this week

- No real-time updates — see each other's changes by refreshing.
- One invite link per fridge; it isn't rotated if it leaks.
- No account recovery: lose the browser's cookie, lose that membership (you'd
  rejoin via the invite link under a new identity).
- Use-by date is exactly that — a reminder the owner set, not a food-safety
  claim the app is making.
