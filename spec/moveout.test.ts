import { expect, inject, it } from "vitest";
import {
  addItem,
  addTimeslot,
  apply,
  applicationIdFor,
  createMoveout,
  firstTimeslotId,
  futureLocalDateTime,
  locationOf,
  makeClient,
} from "./helpers.ts";

const baseUrl = inject("baseUrl");

async function setUpOpenItem(ownerNickname: string, title: string) {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title, deadline: futureLocalDateTime(72), nickname: ownerNickname });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Desk Lamp" });
  // the owner's GET on their own page redirects to /manage (no apply form
  // there), so a separate visitor client reads the actual public page
  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  return { owner, moveout, itemId, timeslotId };
}

it("a non-creator can't manage a move-out page or confirm its applications", async () => {
  const { moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Manage-guard test");
  const stranger = makeClient(baseUrl);
  await apply(stranger, moveout.moveoutId, { itemId, timeslotId, nickname: "Stranger" });

  expect((await stranger.get(moveout.manageUrl)).status).toBe(403);
  expect((await stranger.post(`/items/${itemId}/withdraw`)).status).toBe(404);
});

it("a claimant can't cancel someone else's application", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Cancel-guard test");
  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");

  const carolAttempt = await carol.post(`/applications/${appId}/cancel`);
  expect(carolAttempt.status).toBe(404);

  const ownerAttemptNoReason = await owner.post(`/applications/${appId}/cancel`);
  // owner can only cancel a CONFIRMED booking, and this one is still pending
  expect(ownerAttemptNoReason.status).toBe(409);
});

it("an unconfirmed applicant never receives the pickup location", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Location-privacy test");
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  const bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).toContain("Waiting for confirmation");
  expect(bobView).not.toContain("Side door"); // the default test pickup location text
});

it("an item can't have two active confirmations — two concurrent confirms resolve to exactly one", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Concurrency test");
  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });
  await apply(carol, moveout.moveoutId, { itemId, timeslotId, nickname: "Carol" });

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const bobApp = applicationIdFor(managePage, "Bob");
  const carolApp = applicationIdFor(managePage, "Carol");

  const [resBob, resCarol] = await Promise.all([
    owner.post(`/applications/${bobApp}/confirm`),
    owner.post(`/applications/${carolApp}/confirm`),
  ]);
  const statuses = [resBob.status, resCarol.status].sort();
  expect(statuses).toEqual([302, 409]);
});

it("cancelling a confirmed booking reopens the item so a waitlisted request can be confirmed", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Reopen test");
  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });
  await apply(carol, moveout.moveoutId, { itemId, timeslotId, nickname: "Carol" });

  let managePage = await (await owner.get(moveout.manageUrl)).text();
  const bobApp = applicationIdFor(managePage, "Bob");
  await owner.post(`/applications/${bobApp}/confirm`);

  managePage = await (await owner.get(moveout.manageUrl)).text();
  const carolApp = applicationIdFor(managePage, "Carol");
  // can't confirm Carol's while Bob's is active
  expect((await owner.post(`/applications/${carolApp}/confirm`)).status).toBe(409);

  // owner cancels Bob's confirmed booking, with a reason
  const cancelForm = new FormData();
  cancelForm.set("reason", "Changed my mind about this one");
  expect((await owner.post(`/applications/${bobApp}/cancel`, cancelForm)).status).toBe(302);

  // Bob sees why
  const bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).toContain("Changed my mind about this one");

  // now Carol's waitlisted request CAN be confirmed
  expect((await owner.post(`/applications/${carolApp}/confirm`)).status).toBe(302);
});

it("applying after the deadline is rejected", async () => {
  // `datetime-local` only carries minute precision, so waiting for a near
  // deadline to actually pass would make this test slow and flaky. Instead,
  // create the page with its deadline already in the past directly — the
  // route's `now > deadline` guard doesn't care how it got that way.
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, { title: "Past-deadline test", deadline: futureLocalDateTime(-1), nickname: "Owner" });
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Too Late" });

  const bob = makeClient(baseUrl);
  // no valid timeslot can even exist on an already-expired page, but the
  // deadline check happens first regardless — pass a made-up id to prove
  // that's what's rejecting it, not a missing-timeslot 400.
  const res = await apply(bob, moveout.moveoutId, { itemId, timeslotId: "nonexistent", nickname: "Bob" });
  expect(res.status).toBe(403);
});

it("a completed hand-off record is kept, and survives being looked at again", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Completion test");
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });
  const managePage1 = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage1, "Bob");
  await owner.post(`/applications/${appId}/confirm`);
  expect((await owner.post(`/applications/${appId}/complete`)).status).toBe(302);

  const managePage2 = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage2).toContain("Desk Lamp");
  const completedSection = managePage2.split("Completed</h2>")[1];
  expect(completedSection).toContain("Bob");

  // refetching again later still shows it — nothing about reading the page
  // mutates or expires the record
  const managePage3 = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage3.split("Completed</h2>")[1]).toContain("Bob");
});

it("the mover can't request their own item, and the same device can't double-apply to one item", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Self-request guard test");
  expect((await apply(owner, moveout.moveoutId, { itemId, timeslotId, nickname: "Owner" })).status).toBe(400);

  const bob = makeClient(baseUrl);
  expect((await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" })).status).toBe(302);
  expect((await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob again" })).status).toBe(409);
});

it("withdrawing an open item cancels its pending requests and removes it from the public list", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Withdraw test");
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  expect((await owner.post(`/items/${itemId}/withdraw`)).status).toBe(302);

  const bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).toContain("Item withdrawn by the mover");

  const publicPage = await (await makeClient(baseUrl).get(moveout.publicUrl)).text();
  expect(publicPage).not.toContain("Desk Lamp");
});
