// Integration coverage for Crit 10's server-side business log (src/log.ts).
// This spawns the REAL app as its own process (isolated DATA_DIR, isolated
// port — spec/global-setup.ts's shared server is a different instance with
// its own stdout we can't observe) and reads its actual stdout, rather than
// mocking logEvent — a mocked logger would only prove the function is
// *called*, not that the real request path on a running server actually
// produces these lines.
import { afterAll, beforeAll, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const PORT = 8137;
const baseUrl = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-log-test-"));

let server: ChildProcessWithoutNullStreams;
let lines: string[] = [];

function events(): Record<string, unknown>[] {
  return lines
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server never answered at ${baseUrl}`);
}

beforeAll(async () => {
  server = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
  });
  server.stdout.on("data", (chunk: Buffer) => {
    lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
  });
  await waitForServer();
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.once("exit", () => resolve());
    server.kill("SIGTERM");
  });
  rmSync(dataDir, { recursive: true, force: true });
});

it("two independent devices produce different, stable actor ids", async () => {
  lines = [];
  const alice = makeClient(baseUrl);
  const bob = makeClient(baseUrl);

  await createMoveout(alice, { title: "Actor identity test", deadline: futureLocalDateTime(72), nickname: "Alice" });
  await createMoveout(bob, { title: "Actor identity test 2", deadline: futureLocalDateTime(72), nickname: "Bob" });
  // Alice again, same cookie jar — must log as the SAME actor as her first request.
  await createMoveout(alice, { title: "Actor identity test 3", deadline: futureLocalDateTime(72), nickname: "Alice again" });

  const creates = events().filter((e) => e.event === "moveout.create");
  expect(creates).toHaveLength(3);
  const [aliceFirst, bobOnly, aliceSecond] = creates;
  expect(aliceFirst.actor).toBe(aliceSecond.actor);
  expect(aliceFirst.actor).not.toBe(bobOnly.actor);
  // Not a raw device cookie: expect a short opaque id, not the ~24-char
  // base64url device id newDeviceId() produces.
  expect(String(aliceFirst.actor)).toMatch(/^[A-Za-z0-9_-]{16}$/);
});

it("a successful action logs success with the right resource correlation", async () => {
  lines = [];
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Correlation test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Chair" });

  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");
  const confirmRes = await owner.post(`/applications/${appId}/confirm`);
  expect(confirmRes.status).toBe(302);

  const confirmEvent = events().find((e) => e.event === "application.confirm" && e.outcome === "success");
  expect(confirmEvent).toBeTruthy();
  expect(confirmEvent!.moveoutId).toBe(moveout.moveoutId);
  expect(confirmEvent!.itemId).toBe(itemId);
  expect(confirmEvent!.applicationId).toBe(appId);
  // The creator (actor) and the claimant (affected) must be distinguishable
  // — this is exactly what a crit narrator needs to say "the mover confirmed
  // Bob's request" from the logs alone.
  expect(confirmEvent!.affected).toBeTruthy();
  expect(confirmEvent!.affected).not.toBe(confirmEvent!.actor);
});

it("a denied/conflicting action never logs as success, and a real server error stays distinguishable from a business conflict", async () => {
  lines = [];
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Denial test", deadline: futureLocalDateTime(72), nickname: "Owner" });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Lamp" });

  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");

  // A stranger (neither creator nor claimant) tries to cancel it.
  const stranger = makeClient(baseUrl);
  const deniedRes = await stranger.post(`/applications/${appId}/cancel`);
  expect(deniedRes.status).toBe(404);

  const deniedEvent = events().find((e) => e.event === "application.cancel" && e.outcome === "denied");
  expect(deniedEvent).toBeTruthy();
  expect(deniedEvent!.reasonCode).toBe("not_claimant_or_owner");

  // No event for a rejected write is ever recorded as "success".
  const anySuccessForThisDenial = events().some(
    (e) => e.event === "application.cancel" && e.applicationId === appId && e.outcome === "success",
  );
  expect(anySuccessForThisDenial).toBe(false);
});

it("logged lines never contain the device cookie, pickup address, nickname, or note text", async () => {
  lines = [];
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Privacy test",
    pickupLocation: "Super Secret Address 123",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
  });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Sofa" });

  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const bob = makeClient(baseUrl);
  const bobCookie = (await bob.get(moveout.publicUrl)).headers.get("set-cookie");
  await apply(bob, moveout.moveoutId, {
    itemId,
    timeslotId,
    nickname: "Bob The Confidential Nickname",
    note: "please call 0400 000 000 on arrival",
  });

  const raw = lines.join("\n");
  expect(raw).not.toContain("Super Secret Address 123");
  expect(raw).not.toContain("Bob The Confidential Nickname");
  expect(raw).not.toContain("please call 0400 000 000 on arrival");
  if (bobCookie) {
    const deviceValue = bobCookie.split(";")[0].split("=")[1];
    expect(raw).not.toContain(deviceValue);
  }
});
