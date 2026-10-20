# 003: Business-action logging identifies people by a hashed device id, never a cookie or nickname

## Status

Accepted — crit 10.

## The problem

Crit 10 requires the mover to narrate "who did what" from server logs alone,
without touching the UI, while two classmates use the deployed app from
separate Chrome profiles. That means the log has to:

- tell two different devices apart, reliably, across many requests from the
  same device;
- never leak the thing that actually lets someone act as that device (the
  `device` cookie itself — see `src/session.ts` and `CLAUDE.md`);
- never substitute the free-text nickname for identity, since two visitors
  can type the same one;
- stay cheap to add to a small Hono app with no existing logging dependency.

## Options considered

1. **Log the raw device id.** Trivially correlatable, but the device cookie
   is a long-lived credential — anyone who can read the logs (Fly's log
   pipeline, anyone with `flyctl logs` access) would then be able to replay
   it as that visitor. Rejected outright.
2. **Log the nickname.** Human-readable, but nicknames are explicitly not
   identity (`CLAUDE.md`) — two "Sam"s would be indistinguishable, which
   defeats the entire point of this crit.
3. **A random per-request id with no link back to the device.** Satisfies
   "never leak the cookie" but fails "tell two people apart": nothing ties
   two log lines from the same visitor together.
4. **A deterministic one-way hash of the device id (chosen).** `sha256(device
   id)`, truncated to 96 bits of base64url. Same device always hashes to the
   same actor id (satisfies correlation); a 256-bit SQL-grade hash is not
   practically invertible back to the original cookie from the log alone
   (satisfies confidentiality); needs nothing beyond `node:crypto`, already a
   Node built-in.

## Decision

Option 4. `src/log.ts#logEvent` resolves every actor from the server-side
`deviceId` the route already trusts (never a client-supplied field), hashes
it, and writes one JSON line per real business action to stdout. Writes are
a side effect of the route handler, placed immediately after the triggering
database write actually commits (or, for a rejected write, at the point the
rejection is decided) — never inside a retry loop, never deferred until an
SSE connection closes.

## Consequences

- The log distinguishes actor from affected party (`affected`), so a
  creator-initiated action on someone else's request (confirm, cancel,
  complete) can be narrated as "X did this to Y's request," not just "X did
  something."
- A log line alone can't be reversed back to a device cookie, so it can't
  double as a way to impersonate that device even if the logs leak —
  consistent with treating the cookie itself as the only credential.
- This is an authentication-adjacent log, not a general-purpose APM tool: it
  does not capture request bodies, headers, or timing, and makes no claim
  about retention beyond whatever Fly keeps on stdout for the app.
