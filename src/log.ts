import { createHash } from "node:crypto";

// Server-side business-action log for Crit 10 ("fly by instruments"): one
// JSON line per real action, to stdout, readable live with
// `mise exec -- flyctl logs -a comp4020-final-tavewang`. This is not an
// audit trail that promises indefinite retention — it's whatever stdout
// retention Fly's log pipeline gives us (see README's logging section); the
// requirement this satisfies is that the mechanism keeps running after the
// crit, not that every line is kept forever.
export type LogOutcome = "success" | "denied" | "invalid" | "conflict" | "error";

interface LogEventInput {
  event: string;
  // Raw device id of whoever made the request. Hashed before it's written —
  // never log the cookie value itself, it's a long-lived credential
  // (src/session.ts).
  actor: string;
  outcome: LogOutcome;
  moveoutId?: string;
  itemId?: string;
  timeslotId?: string;
  applicationId?: string;
  // Raw device id of the OTHER party affected by this action (e.g. the
  // claimant when the creator confirms/cancels/completes their request).
  // Only set when it differs from actor — lets a crit narrator say "actor X
  // did this to Y's request" from the logs alone.
  affectedDevice?: string;
  status?: number;
  reasonCode?: string;
}

// Stable per device, distinct across devices, not practically reversible to
// the cookie value — sha256 truncated to 16 base64url chars (96 bits) is
// far more than enough entropy to never collide between two real devices in
// one crit, while giving up nothing an attacker could invert.
function actorId(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("base64url").slice(0, 16);
}

export function logEvent(input: LogEventInput): void {
  const line: Record<string, unknown> = {
    timestamp: new Date().toISOString(),
    event: input.event,
    actor: actorId(input.actor),
    outcome: input.outcome,
  };
  if (input.moveoutId) line.moveoutId = input.moveoutId;
  if (input.itemId) line.itemId = input.itemId;
  if (input.timeslotId) line.timeslotId = input.timeslotId;
  if (input.applicationId) line.applicationId = input.applicationId;
  if (input.affectedDevice && input.affectedDevice !== input.actor) line.affected = actorId(input.affectedDevice);
  if (input.status !== undefined) line.status = input.status;
  if (input.reasonCode) line.reasonCode = input.reasonCode;
  // One line, flushed immediately — never buffered behind an open SSE
  // connection or a static-asset request, neither of which calls this.
  console.log(JSON.stringify(line));
}
