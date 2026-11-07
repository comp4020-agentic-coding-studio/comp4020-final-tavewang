// A generic "something changed" signal bus for real-time updates — never a
// copy of the data itself. Every subscriber reacts by re-fetching the page
// it already had permission to see (the same route, the same ownership.ts
// checks), so this bus never has to know or enforce who's allowed to see
// what. The connection list below is transport state, not a business
// record — it's fine for it to live in memory and vanish on restart
// (CLAUDE.md's persistence rule is about the moveout/item/application data,
// which only ever lives in SQLite).
import { EventEmitter } from "node:events";
import type { SSEStreamingApi } from "hono/streaming";

const moveoutBus = new EventEmitter().setMaxListeners(0);
const deviceBus = new EventEmitter().setMaxListeners(0);
// A real bug, found this round: "My MoveOut"'s SSE subscription
// (homeRoutes's GET /events) and every write that calls notifyDevice() were
// still keyed purely by device id, even for a signed-in account — so device
// A creating a page while device B (signed into the SAME account) had "My
// MoveOut" open never woke B's tab up; B only saw it after a manual reload.
// This bus is the account-scoped equivalent of deviceBus: a write that
// changes what an ACCOUNT's own "My MoveOut" list shows notifies this bus
// by account id (resolved server-side from the live session, never from
// anything a client sends), and an anonymous device keeps using deviceBus
// exactly as before — accounts don't replace that path, they add this one
// alongside it for signed-in visitors.
const accountBus = new EventEmitter().setMaxListeners(0);
// Crit 11: one more bus, for the public browse pool. Carries exactly the
// same "something changed, go re-fetch" signal as the other two — never
// item/application data — so a subscriber who has an unlisted page's link
// open (and is on moveoutBus for it) is unaffected, and a browse-pool
// subscriber learns nothing about anything that isn't already public.
const poolBus = new EventEmitter().setMaxListeners(0);
const POOL_EVENT = "pool";

export function notifyMoveout(moveoutId: string): void {
  moveoutBus.emit(moveoutId);
}

export function notifyDevice(deviceId: string): void {
  deviceBus.emit(deviceId);
}

// Call this (in addition to notifyDevice, never instead of it) whenever an
// entity bound to an account changes in a way that affects what that
// account's own "My MoveOut" list shows — a new page, a new application, or
// a status change (confirm/cancel/complete) on an existing one.
export function notifyAccount(accountId: string): void {
  accountBus.emit(accountId);
}

// Call whenever a write could change what the public pool shows: a public
// item's availability (added, withdrawn, confirmed, completed), or a
// move-out's visibility flipping either direction.
export function notifyPublicPool(): void {
  poolBus.emit(POOL_EVENT);
}

export function onMoveoutChange(moveoutId: string, listener: () => void): () => void {
  moveoutBus.on(moveoutId, listener);
  return () => moveoutBus.off(moveoutId, listener);
}

export function onDeviceChange(deviceId: string, listener: () => void): () => void {
  deviceBus.on(deviceId, listener);
  return () => deviceBus.off(deviceId, listener);
}

export function onAccountChange(accountId: string, listener: () => void): () => void {
  accountBus.on(accountId, listener);
  return () => accountBus.off(accountId, listener);
}

export function onPublicPoolChange(listener: () => void): () => void {
  poolBus.on(POOL_EVENT, listener);
  return () => poolBus.off(POOL_EVENT, listener);
}

// Drives one SSE connection: pushes a content-free "sync" event the instant
// `subscribe` fires, or a "ping" heartbeat every 15s otherwise (so a dead
// connection — proxy timeout, Fly machine restart — is visible to the client
// well before any human would notice, and the browser's socket doesn't look
// idle to anything in between). `subscribe` returns its own unsubscribe
// function, which runs when the stream aborts, so a disconnected client's
// listener doesn't linger in the bus (no leaked subscriptions, no leaked
// timers — the `while` loop's only timer is `stream.sleep`, dropped the
// moment the loop exits).
export async function pumpSSE(stream: SSEStreamingApi, subscribe: (notify: () => void) => () => void): Promise<void> {
  let dirty = false;
  let wake: (() => void) | null = null;
  const unsubscribe = subscribe(() => {
    dirty = true;
    wake?.();
  });
  stream.onAbort(unsubscribe);
  try {
    while (!stream.aborted && !stream.closed) {
      if (!dirty) {
        await Promise.race([new Promise<void>((resolve) => (wake = resolve)), stream.sleep(15000)]);
        wake = null;
      }
      if (stream.aborted || stream.closed) break;
      await stream.writeSSE({ event: dirty ? "sync" : "ping", data: "" });
      dirty = false;
    }
  } finally {
    unsubscribe();
  }
}
