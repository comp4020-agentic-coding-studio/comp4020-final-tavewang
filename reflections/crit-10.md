# Crit 10 reflection — Fly by instruments

## The breakthrough

The breakthrough was separating permission enforcement from evidence of what happened. I had Codex review the existing identity and permission model before adding logging. The recorded review directed attention to a gap: the application could distinguish people and reject actions, but those decisions were not visible in a business-action log.

The implementation in [d9661d3](https://github.com/comp4020-agentic-coding-studio/comp4020-final-tavewang/commit/d9661d3) made that distinction concrete. Each event records a hashed actor identifier, an action and an outcome. A nickname is insufficient because two people can use the same one; a raw device cookie would expose a credential. Success should be logged only after the relevant write succeeds. These rules made logging part of the harness rather than a debugging afterthought.

The record does not establish that I successfully narrated a classmate's actions during the crit. Automated log checks and a classroom demonstration are different evidence, and I should keep that distinction visible.

## The developer I want to become

I want to be able to explain a system's behaviour when something is rejected, cancelled or contested, as well as when it works. This round pushed me to ask what evidence would remain after an action, instead of treating a convincing interface as enough.

It also changed how I think about directing an agent. Asking for logging is less useful than specifying which events matter, what information must stay private, and when a success claim is justified. I want those expectations to become repeatable rules and checks. This is my interpretation of the work; it is not a claim of tutor feedback or a completed user evaluation.
