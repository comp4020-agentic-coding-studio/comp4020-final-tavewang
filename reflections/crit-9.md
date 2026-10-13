# Crit 9 reflection

## The breakthrough

The breakthrough was realising that "receives an SSE message" and
"synchronises correctly" are different claims, and the first one is far
easier to satisfy than the second. My initial instruction to the agent was
clear about the behaviour I wanted — update shared state live, never destroy
someone's in-progress input — and the resulting implementation passed its
own tests and a first browser check. I asked for an adversarial review pass
before accepting that as done, rather than stopping at green. That pass
found five real defects a happy-path check had missed: reconciliation moving
unrelated DOM nodes and silently stealing someone else's focus, a withdrawn
item's form staying usable, a confirmed booking's address not actually
reaching a protected card, a first-ever request never appearing in an
already-open empty list, and — the one that mattered most — a stale confirm
that could leave an item locked with no application actually holding it.
That last one was a genuine data-integrity bug in the transaction logic, not
a UI polish issue, and it only surfaced because I asked the review to try to
break the thing rather than confirm it worked.

## The developer I want to become

[NEEDS MY INPUT: this section should be mine to write honestly, not
generated to sound reflective. What I can offer instead: the pattern worth
naming is that my most useful instruction this week wasn't "add real-time
updates," it was "now go find what's wrong with it" — a second, differently-
aimed pass caught what the first pass's own tests couldn't see by
construction. I don't yet know what that means for how I want to work as a
developer; that's a genuine question for me to sit with, not one I should
let be answered for me.]
