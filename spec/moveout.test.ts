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
  myOwnApplicationId,
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
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Manage-guard test");
  const stranger = makeClient(baseUrl);
  await apply(stranger, moveout.moveoutId, { itemId, timeslotId, nickname: "Stranger" });

  expect((await stranger.get(moveout.manageUrl)).status).toBe(403);
  expect((await stranger.post(`/items/${itemId}/withdraw`)).status).toBe(404);

  // The guard this test is named for: a non-creator directly POSTing
  // confirm/complete on someone else's application (not just failing to
  // reach the manage page) must also be rejected.
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Stranger");
  expect((await stranger.post(`/applications/${appId}/confirm`)).status).toBe(404);
  expect((await stranger.post(`/applications/${appId}/complete`)).status).toBe(404);
});

it("non-creators are rejected on every creator-only write route (add item, add timeslot)", async () => {
  const { moveout } = await setUpOpenItem("Owner", "Creator-only routes test");
  const stranger = makeClient(baseUrl);

  const itemForm = new FormData();
  itemForm.set("name", "Should not be added");
  expect((await stranger.post(`/m/${moveout.moveoutId}/items`, itemForm)).status).toBe(404);

  expect(
    (await stranger.post(`/m/${moveout.moveoutId}/timeslots`, {
      startsAt: futureLocalDateTime(10),
      endsAt: futureLocalDateTime(11),
    })).status,
  ).toBe(404);
});

it("someone else can't change a claimant's own pending request's timeslot", async () => {
  const { moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Timeslot-guard test");
  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  const bobView = await (await bob.get(moveout.publicUrl)).text();
  const bobAppIdMatch = bobView.match(/\/applications\/([A-Za-z0-9_-]+)\/timeslot/);
  expect(bobAppIdMatch).not.toBeNull();
  const appId = bobAppIdMatch![1];

  expect((await carol.post(`/applications/${appId}/timeslot`, { timeslotId })).status).toBe(404);
});

it("two applicants who both actually use the nickname \"Sam\" on the SAME item stay two separate identities", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Same-nickname isolation test");
  const same1 = makeClient(baseUrl);
  const same2 = makeClient(baseUrl);
  // Both apply to the exact same item with the exact literal nickname "Sam"
  // — the unique constraint is (item_id, claimer_device_id), not nickname,
  // so this is allowed (same1 confirmable, same2 waitlisted), and it's the
  // real same-nickname scenario the brief asks for: two people, one name.
  expect((await apply(same1, moveout.moveoutId, { itemId, timeslotId, nickname: "Sam" })).status).toBe(302);
  expect((await apply(same2, moveout.moveoutId, { itemId, timeslotId, nickname: "Sam" })).status).toBe(302);

  // Each reads their OWN application id off their OWN "Your requests"
  // section (keyed by data-application-id, never by the shared nickname
  // text) — this is what makes it possible to address same1's and same2's
  // applications separately at all despite an identical display name.
  const same1View = await (await same1.get(moveout.publicUrl)).text();
  const same2View = await (await same2.get(moveout.publicUrl)).text();
  const same1AppId = myOwnApplicationId(same1View);
  const same2AppId = myOwnApplicationId(same2View);
  expect(same1AppId).not.toBe(same2AppId);

  // same2 cannot cancel or retime same1's application, and vice versa,
  // despite the server-rendered page showing "Sam" for both rows.
  expect((await same2.post(`/applications/${same1AppId}/cancel`)).status).toBe(404);
  expect((await same2.post(`/applications/${same1AppId}/timeslot`, { timeslotId })).status).toBe(404);
  expect((await same1.post(`/applications/${same2AppId}/cancel`)).status).toBe(404);

  // The owner, reading the manage page, sees two distinct applicant rows —
  // proving the server itself (not just this test's bookkeeping) treats
  // them as different people, even though applicationIdFor's name-based
  // lookup can only ever reliably find the first "Sam" row.
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const sameRowCount = managePage.split('<span>Sam ').length - 1;
  expect(sameRowCount).toBe(2);
});

it("address visibility before and after confirmation, and a rejected action leaves status unchanged", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Address-visibility test");
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  let bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).not.toContain("Side door");

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");

  // A stranger's rejected confirm attempt must not change the application's
  // status or reveal the address.
  const stranger = makeClient(baseUrl);
  expect((await stranger.post(`/applications/${appId}/confirm`)).status).toBe(404);
  bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).toContain("Waiting for confirmation");
  expect(bobView).not.toContain("Side door");

  // The real owner confirms — now the address appears for the claimant.
  expect((await owner.post(`/applications/${appId}/confirm`)).status).toBe(302);
  bobView = await (await bob.get(moveout.publicUrl)).text();
  expect(bobView).toContain("Side door");
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

// Regression for a bug found in crit-9 review: confirming an application
// that's already been cancelled (e.g. a stale "Confirm" button clicked
// after the applicant cancelled, or clicked twice) used to still flip the
// ITEM to 'reserved' even though the application UPDATE's WHERE clause
// correctly found no 'pending' row to match — because the two guarded
// updates weren't both checked before the transaction committed. The fix
// makes the item update's success conditional on the application update
// also succeeding, inside the same all-or-nothing transaction.
it("confirming an already-cancelled application fails without reserving the item, and a real pending request can still be confirmed", async () => {
  const { owner, moveout, itemId, timeslotId } = await setUpOpenItem("Owner", "Stale-confirm regression test");
  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });
  await apply(carol, moveout.moveoutId, { itemId, timeslotId, nickname: "Carol" });

  const managePage1 = await (await owner.get(moveout.manageUrl)).text();
  const bobApp = applicationIdFor(managePage1, "Bob");
  const carolApp = applicationIdFor(managePage1, "Carol");

  // Bob cancels his own still-pending request.
  expect((await bob.post(`/applications/${bobApp}/cancel`)).status).toBe(302);

  // The mover's page is stale (still shows Bob as confirmable) and they
  // click Confirm anyway — this must fail outright, not reserve the item.
  const staleConfirm = await owner.post(`/applications/${bobApp}/confirm`);
  expect(staleConfirm.status).toBe(409);

  // The item must still be 'open': a public visitor can still see and
  // request it, and crucially Carol's real pending request can still be
  // confirmed — if the bug were present the item would be wrongly
  // 'reserved' with no confirmed application, and this would 409 too.
  const publicPage = await (await makeClient(baseUrl).get(moveout.publicUrl)).text();
  expect(publicPage).toContain("Desk Lamp");

  const carolConfirm = await owner.post(`/applications/${carolApp}/confirm`);
  expect(carolConfirm.status).toBe(302);
});
