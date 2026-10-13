import { expect, inject, it } from "vitest";
import {
  addItem,
  addTimeslot,
  apply,
  applicationIdFor,
  createMoveout,
  firstTimeslotId,
  futureLocalDateTime,
  makeClient,
} from "./helpers.ts";

const baseUrl = inject("baseUrl");

// Reads Server-Sent Events off a raw (unconsumed) fetch Response until one
// whose `event:` line matches `name` arrives, or `timeoutMs` passes. Returns
// how long that took — the thing crit 9's spec actually asks for ("about a
// second"), not just "no error". The two-request round trip this measures
// (the writer's POST, then this reader noticing the push) is the same path
// a real browser's EventSource is on, just without a DOM in the way.
async function waitForSSE(res: Response, name: string, timeoutMs: number): Promise<number> {
  const started = performance.now();
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`no "${name}" event within ${timeoutMs}ms (saw: ${JSON.stringify(buffer)})`)), timeoutMs),
  );
  const read = (async (): Promise<number> => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`stream ended before a "${name}" event arrived`);
      buffer += decoder.decode(value, { stream: true });
      for (const block of buffer.split("\n\n")) {
        if (block.includes(`event: ${name}`)) return performance.now() - started;
      }
    }
  })();
  try {
    return await Promise.race([read, timeout]);
  } finally {
    reader.cancel().catch(() => {});
  }
}

it("the events stream answers for an existing moveout, and 404s for one that doesn't exist", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "SSE smoke test", deadline: futureLocalDateTime(72), nickname: "Owner" });

  const res = await fetch(new URL(`/m/${moveout.moveoutId}/events`, baseUrl));
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  await res.body?.cancel();

  expect((await fetch(new URL(`/m/nonexistent/events`, baseUrl))).status).toBe(404);
});

it("a new request pushes a sync event to anyone watching the moveout, within about a second", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Live apply test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Kettle" });
  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);

  // Subscribe before the change happens — by the time this fetch's headers
  // resolve, src/live.ts's subscription is already registered (it happens
  // synchronously inside streamSSE's callback, before any network round
  // trip), so there's no window for the write to race ahead of the listener.
  const sse = await fetch(new URL(`/m/${moveout.moveoutId}/events`, baseUrl));
  const waiting = waitForSSE(sse, "sync", 1500);

  const bob = makeClient(baseUrl);
  const applyRes = await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });
  expect(applyRes.status).toBe(302);

  const latencyMs = await waiting;
  console.log(`[live] apply -> sync event: ${latencyMs.toFixed(0)}ms`);
  expect(latencyMs).toBeLessThan(1500);
});

it("confirming notifies the claimant's own device-scoped stream (home page), not just the moveout page", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Live confirm test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Rug" });
  const visitorPage = await (await makeClient(baseUrl).get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(visitorPage, itemId);

  // `makeClient`'s Client interface doesn't expose its cookie jar (by
  // design — spec/helpers.ts keeps it private), and a raw SSE fetch needs
  // the Cookie header directly, so Bob is driven by hand here instead.
  const bobApply = await fetch(new URL(`/m/${moveout.moveoutId}/apply`, baseUrl), {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ itemId, timeslotId, nickname: "Bob" }).toString(),
  });
  expect(bobApply.status).toBe(302);
  const bobCookie = (bobApply.headers.get("set-cookie") ?? "").split(";")[0];

  // Bob's own home page (GET /events, device-scoped — not /m/:id/events)
  // should hear about his application being confirmed, with no awareness
  // of this specific moveout's id baked into the subscription.
  const sse = await fetch(new URL("/events", baseUrl), { headers: { Cookie: bobCookie } });
  const waiting = waitForSSE(sse, "sync", 1500);

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");
  expect((await owner.post(`/applications/${appId}/confirm`)).status).toBe(302);

  const latencyMs = await waiting;
  console.log(`[live] confirm -> claimant's home sync event: ${latencyMs.toFixed(0)}ms`);
  expect(latencyMs).toBeLessThan(1500);
});
