# MoveOut

Moving out of a dorm room on a deadline produces a predictable mess: a pile of
things that still work, a group chat full of "is this gone yet?", and no clear
record of who's actually coming to collect what. MoveOut is a small web app
for exactly that moment — a mover lists what they're giving away, sets a
deadline and a few pickup time windows, and shares one link. Whoever wants
something requests a time; the mover confirms one request per item; everyone
else can see it's spoken for without a round of messages asking.

## The real problem this responds to

ANU's own Give It Forward project documents the underlying issue directly:
residential halls generate a large volume of move-out waste every year, with
much of it "usable items simply discarded" rather than donated, and the open
challenges are less about convincing people to give things away and more about
the quality of what gets donated and reducing dumping at donation points
([McCusker Institute, *Give It Forward: circular giving in residential
halls*](https://mccuskerinstitute.anu.edu.au/project/give-it-forward-circular-giving-in-residential-halls/)).
That source establishes the waste problem is real — it says nothing about
whether a scheduling tool like this one actually helps, which is a separate
claim this app has not earned yet.

## What this app is

- A **move-out page** belongs to one mover: a title, a deadline, a rough area
  (shown publicly), an exact pickup spot (shown only once a request is
  confirmed), a declared timezone, and a handful of pickup time windows.
- An **item** is one thing (or a set that must go together) the mover is
  giving away: a name, condition notes, an optional photo, optional extra
  notes.
- A **request** is one person asking for one item at one time window. A
  mover confirms at most one request per item; everyone else who asked stays
  on record as a backup in case the confirmed one falls through.

The scenario this is built around: I'm moving out Friday with a lamp, a chair,
and a rice cooker to give away. I make a page, add a couple of pickup windows,
and post the link to my old floor's group chat. Someone requests the lamp for
Friday afternoon; I confirm it; they see exactly where to come. If they
cancel, the lamp reopens and I can confirm the next person who asked.

## Core flow

1. Create a page (title, deadline + timezone, area, exact pickup spot,
   your name).
2. Add items and a few pickup time windows.
3. Share the one link — it lets anyone browse and request, never manage.
4. A visitor requests an item: a name, a time window, an optional note. They
   see "waiting for confirmation," not "booked."
5. You confirm one request per item. The requester now sees the exact pickup
   spot. Everyone else who asked stays queued as a backup.
6. Either side can cancel. A requester cancels freely; if you cancel a
   *confirmed* booking, you have to say why, and they see it.
7. You mark it picked up once it's actually gone. That record — and anyone
   who asked and didn't get it — stays visible in history, not deleted.

## This week's scope (crit 8)

Built: everything above, persisted to SQLite on the Fly volume (items,
requests, and uploaded photos all survive a refresh, a restart, and a
redeploy — all three checked directly this week, not assumed). Multiple
people can use the same page from their own browsers today; they refresh to
see each other's changes. Real-time updates are next week's spec (crit 9); the
two separate status columns (an item's and a request's) and the
guarded-update pattern behind every state change were chosen so that doesn't
require a rewrite.

Deliberately not built yet: payments, bidding, delivery, in-app chat, ratings,
AI recommendations, campus identity login, a campus-wide marketplace,
email/SMS notifications, automatic backup-promotion when a confirmed booking
falls through, calendar integration.

Known, named limits rather than silent gaps:

- Identity is a browser cookie, not an account. Clear your cookies (or switch
  devices) and the app has no way to connect you back to your past requests
  or pages — there is no password reset or account recovery, because there is
  no account.
- The share link and the page's own URL are the same thing; what you can do
  with it depends entirely on whether your browser is recognised as the
  creator, never on who else has seen the link.
- "Hoping to collect by" dates and "condition notes" are exactly what the
  mover typed — the app makes no food-safety-style claim about an item's
  condition or usability.
- Photo upload is capped at 5 MB, JPEG/PNG/WebP only, one per item.

## Running it

```sh
pnpm install
pnpm dev            # http://localhost:8080, data in ./data/app.db
pnpm check          # typecheck + the spec, against a running instance
```

`DATA_DIR` controls where SQLite and uploaded photos live (`/data` in the
deployed container, via `fly.toml`'s volume mount; `./data` locally).

## What "good" means for this app — first draft

This is a first pass, written before a week of real use by an actual pod —
expected to change once people other than me have tried to give something
away or collect it through this.

1. **A requester can tell the difference between "I asked" and "it's mine."**
   Every request starts "waiting for confirmation" in plain text; nothing
   implies a booking until the mover has actually confirmed it.
2. **One item never has two live confirmed takers.** The database — not the
   interface — refuses a second confirmation while one is still active, even
   under two requests landing at once.
3. **The mover can see, at a glance, what still needs a decision and what's
   already arranged.** The manage page is organised as a checklist being
   cleared, not a flat list of everything ever posted.
4. **A cancellation has a clear next state, not a dead end.** A cancelled
   confirmed booking reopens the item immediately, with the reason visible to
   the person it affected; a backup requester can be confirmed right away.
5. **What was given, to whom, and when stays on the record.** Completed
   hand-offs aren't deleted — they're the only proof anything here actually
   happened.
6. **Finishing one hand-off costs as few messages as possible.** The target
   is: request, one confirmation, one pickup — not a back-and-forth to work
   out whether someone is still coming.

**TODO (you):** this is a starting argument, not a finished one. Before the
crit: do you still agree with these six, or has a week of actually using it
surfaced a seventh thing that matters more (e.g. how a *set* of items that
must go together should read differently from a single item, or what should
happen to a page once its deadline passes and things are still unclaimed)?
Rewrite this in your own words — the marker reads this page first, and reads
it against your app, your `CLAUDE.md`, and your `spec/`.

**TODO (you):** say here, explicitly, what you decided not to build this week
and why that was the right cut, if it isn't already obvious from "This week's
scope" above.

## What I looked at while deciding this

Found by search, summarised here — read either one yourself before citing it
as something that actually shaped your thinking, rather than citing this
summary:

- [**Buy Nothing Project**](https://en.wikipedia.org/wiki/Buy_Nothing_Project) —
  a large, long-running network of hyperlocal gift-economy groups: give
  things away for free to neighbours, no money, no bartering, norms enforced
  socially rather than by a platform (first-come-first-served or a random
  draw when several people want the same thing). Relevant because it's the
  closest real-world precedent for "several people might want one free thing,
  and the group has to agree on who gets it without anyone feeling cheated" —
  a social problem this app tries to solve mechanically instead, which is
  itself a design choice worth being honest about rather than assuming is an
  improvement.
- The ANU Give It Forward page above, read again for its framing of the
  *problem* rather than any solution — it specifically does not claim a
  scheduling tool is the fix, which is the distinction this README keeps
  separate throughout.

**TODO (you):** if you read something else that actually shaped a decision —
the brief's own pointers to the small web, or something you found yourself —
replace or add to this list with your own account of what it changed about
the design, not just a summary.

## What can and can't be checked automatically

Checkable, and covered in `spec/moveout.test.ts`: a non-creator can't manage a
page or confirm its requests; a requester can't cancel someone else's
request; an unconfirmed requester never receives the pickup location; two
simultaneous confirmations on one item resolve to exactly one; cancelling a
confirmed booking reopens the item for a backup request; requesting after the
deadline is rejected; a completed hand-off record persists; a mover can't
request their own item or accept two active requests from one browser;
withdrawing an item cancels its pending requests.

Only a person can judge: whether the manage page actually reads as "a list
being cleared" rather than a database dump; whether the wording around
requesting and cancelling feels low-stakes rather than like a rejection;
whether a stranger unfamiliar with the project can complete a request in
under a minute without being told how; whether the six-point "good" argument
above survives contact with an actual pod at the crit.
