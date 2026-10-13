# Crit 9 reflection

## The breakthrough

The breakthrough was understanding that receiving a live-update message does not mean the interface has synchronised correctly. I asked Claude to implement Crit 9, then asked Codex to review the changes. That review found concrete failures: updates could steal focus, a withdrawn item's form still looked usable, and a confirmed request could show its new status without revealing the pickup address. A stale confirmation could also reserve an item without a valid recipient.

I used those findings to ask for specific fixes and another review. The later checks confirmed those problems were repaired. Seeing the difference between a transport test and a browser scenario gave me a clearer way to judge progress: check what another person actually sees and can do, including when their page is out of date.

## The developer I want to become

I want to develop useful tools whose behaviour I can explain and verify. Choosing MoveOut came from repeatedly asking whether an idea solved a real problem. This week extended that question to implementation: a feature only helps if people can rely on it while using the app together.

My responsibility is to define those expectations, challenge an agent's result and turn failures into rules or tests. I also need to distinguish passing checks from complete evidence. A later review found that input-method composition delayed unrelated updates, so I requested a focused fix and regression test. I want this review-and-correction cycle to become part of my normal workflow, while keeping the limits of synthetic tests visible.
