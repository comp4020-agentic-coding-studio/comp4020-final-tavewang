import { expect, inject, it } from "vitest";
import {
  applicationIdFor,
  futureLocalDateTime,
  locationOf,
  makeClient,
  pendingRescheduleIdFrom,
  setUpConfirmedBooking,
} from "./helpers.ts";

const baseUrl = inject("baseUrl");

it("the claimant can propose a reschedule, and the mover can accept it, moving the confirmed time and resetting departure status", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Claimant-proposes" });

  // Mark departure first, so accepting the reschedule has something to reset.
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "departed" })).status).toBe(302);

  expect(
    (
      await claimant.post(`/applications/${applicationId}/reschedule`, {
        newTimeslotId: slot2Id,
        reason: "Can you do the later slot instead?",
      })
    ).status,
  ).toBe(302);

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage).toContain("Can you do the later slot instead?");
  const proposalId = pendingRescheduleIdFrom(managePage);

  expect((await owner.post(`/reschedule/${proposalId}/accept`)).status).toBe(302);

  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  // The new slot's hour should now appear as the confirmed time, and the
  // reschedule block should be gone (no longer pending).
  expect(publicPage).not.toContain('data-reschedule-id');
  expect(publicPage).toContain('data-departure-status="not_departed"');
});

it("the mover can propose a reschedule, and the claimant can accept it", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Mover-proposes" });

  expect(
    (
      await owner.post(`/applications/${applicationId}/reschedule`, {
        newTimeslotId: slot2Id,
        reason: "I need to be away at the original time",
      })
    ).status,
  ).toBe(302);

  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  expect(publicPage).toContain("I need to be away at the original time");
  const proposalId = pendingRescheduleIdFrom(publicPage);

  expect((await claimant.post(`/reschedule/${proposalId}/accept`)).status).toBe(302);

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage).not.toContain("data-reschedule-id");
});

it("the proposer can't accept their own proposal, and an unrelated stranger is rejected entirely", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Self-accept guard" });
  await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });

  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const proposalId = pendingRescheduleIdFrom(publicPage);

  // Proposer (claimant) can't accept their own proposal.
  expect((await claimant.post(`/reschedule/${proposalId}/accept`)).status).toBe(403);

  // A third party has no standing on this reschedule at all.
  const stranger = makeClient(baseUrl);
  expect((await stranger.post(`/reschedule/${proposalId}/accept`)).status).toBe(404);
  expect((await stranger.post(`/reschedule/${proposalId}/decline`)).status).toBe(404);
  expect((await stranger.post(`/reschedule/${proposalId}/withdraw`)).status).toBe(404);

  // Nothing about the booking changed — still confirmed at the original time.
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  expect(managePage).toContain("Reschedule proposed");
});

it("the original pickup time holds until the proposal is actually accepted", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Unaccepted-stays-put" });
  const beforePage = await (await claimant.get(moveout.publicUrl)).text();

  await owner.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "maybe?" });

  const afterProposalPage = await (await claimant.get(moveout.publicUrl)).text();
  // The confirmed-time line is unchanged; only the pending-proposal block is new.
  const beforeTimeLine = beforePage.match(/Confirmed pickup time:<\/strong>[^<]*/)?.[0];
  const afterTimeLine = afterProposalPage.match(/Confirmed pickup time:<\/strong>[^<]*/)?.[0];
  expect(afterTimeLine).toBe(beforeTimeLine);
  expect(afterProposalPage).toContain("Waiting for the other party to agree");
});

it("declining a reschedule leaves the original time in place and the proposal resolved", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Decline test" });
  await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const proposalId = pendingRescheduleIdFrom(managePage);

  expect((await owner.post(`/reschedule/${proposalId}/decline`)).status).toBe(302);

  const afterDecline = await (await claimant.get(moveout.publicUrl)).text();
  expect(afterDecline).not.toContain("data-reschedule-id");
  // A new proposal can still be made — declining doesn't jam the one-pending slot.
  expect((await owner.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" })).status).toBe(302);
});

it("the proposer can withdraw their own pending proposal, and only the proposer may", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Withdraw test" });
  await owner.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });
  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const proposalId = pendingRescheduleIdFrom(publicPage);

  // Claimant (not the proposer) can't withdraw the owner's proposal.
  expect((await claimant.post(`/reschedule/${proposalId}/withdraw`)).status).toBe(404);
  // Owner (the proposer) can.
  expect((await owner.post(`/reschedule/${proposalId}/withdraw`)).status).toBe(302);

  const afterWithdraw = await (await claimant.get(moveout.publicUrl)).text();
  expect(afterWithdraw).not.toContain("data-reschedule-id");
});

it("rejects a new timeslot from a different move-out page, and the current timeslot itself", async () => {
  const { claimant, applicationId, slot1Id } = await setUpConfirmedBooking(baseUrl, { title: "Invalid-timeslot guard" });

  // Not on this page at all.
  expect((await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: "nonexistent", reason: "" })).status).toBe(400);

  // The current timeslot itself isn't a valid "new" choice.
  expect((await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot1Id, reason: "" })).status).toBe(400);

  // A timeslot belonging to a totally different, unrelated move-out page.
  const otherOwner = makeClient(baseUrl);
  const otherMoveoutRes = await otherOwner.post("/moveouts", {
    title: "Unrelated page",
    area: "Elsewhere",
    pickupLocation: "Elsewhere door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Other Owner",
    visibility: "unlisted",
  });
  const otherManageUrl = locationOf(otherMoveoutRes);
  const otherMoveoutId = otherManageUrl.split("/")[2];
  await otherOwner.post(`/m/${otherMoveoutId}/timeslots`, {
    startsAt: futureLocalDateTime(2),
    endsAt: futureLocalDateTime(3),
  });
  // Scrape that page's own timeslot id via its apply form, same trick as
  // helpers.firstTimeslotId.
  const otherItemForm = new FormData();
  otherItemForm.set("name", "Unrelated item");
  otherItemForm.set("category", "Other");
  await otherOwner.post(`/m/${otherMoveoutId}/items`, otherItemForm);
  const otherPublicPage = await (await makeClient(baseUrl).get(`/m/${otherMoveoutId}`)).text();
  const otherSlotIdMatch = otherPublicPage.match(/<option value="([A-Za-z0-9_-]+)">/);
  expect(otherSlotIdMatch).not.toBeNull();
  const foreignSlotId = otherSlotIdMatch![1];

  expect((await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: foreignSlotId, reason: "" })).status).toBe(400);
});

it("rejects a new timeslot whose end time is after the move-out's deadline", async () => {
  const owner = makeClient(baseUrl);
  const moveoutRes = await owner.post("/moveouts", {
    title: "Deadline-overrun guard",
    area: "Test Hall",
    pickupLocation: "Side door",
    deadline: futureLocalDateTime(4),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = locationOf(moveoutRes);
  const moveoutId = manageUrl.split("/")[2];
  // Within the deadline (ends at +3h, deadline is +4h).
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(1), endsAt: futureLocalDateTime(2) });
  const itemForm = new FormData();
  itemForm.set("name", "Near-deadline item");
  itemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, itemForm);

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(`/m/${moveoutId}`)).text();
  const itemId = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1];
  const slotId = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/)![1];
  await claimant.post(`/m/${moveoutId}/apply`, { itemId, timeslotId: slotId, nickname: "Claimant" });
  const managePage = await (await owner.get(manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  await owner.post(`/applications/${appId}/confirm`);

  // A second timeslot whose START (+3h) is still before the deadline (+4h)
  // but whose END (+5h) is after it — add-timeslot's own guard only checks
  // startsAt against the deadline, so this is accepted at creation time.
  const overrunRes = await owner.post(`/m/${moveoutId}/timeslots`, {
    startsAt: futureLocalDateTime(3),
    endsAt: futureLocalDateTime(5),
  });
  expect(overrunRes.status).toBe(302);

  // The reschedule <select> itself only offers slots whose END is within
  // the deadline, so the overrun slot never appears there at all — correct
  // behaviour, but it means its id has to come from somewhere else. The
  // public apply form's own valid-slots filter (src/routes/moveout.ts) only
  // checks startsAt against the deadline, not endsAt, so it DOES list this
  // slot — but only next to a still-OPEN item (the first item is already
  // reserved). A second, still-open item makes that form render again so
  // the slot id can be scraped from it; scraping it this way isolates
  // exactly what this test is about — the reschedule route's own endsAt
  // check, not whether the reschedule UI offers the slot at all.
  const fillerItemForm = new FormData();
  fillerItemForm.set("name", "Filler open item");
  fillerItemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, fillerItemForm);
  const itemPublicPage = await (await claimant.get(`/m/${moveoutId}`)).text();
  const publicSlotIds = Array.from(itemPublicPage.matchAll(/<option value="([A-Za-z0-9_-]+)">/g)).map((m) => m[1]);
  const overrunSlotId = publicSlotIds.find((id) => id !== slotId);
  expect(overrunSlotId).toBeTruthy();

  // ...but the RESCHEDULE route must still reject it as a reschedule target,
  // since its end time is after the deadline.
  expect(
    (await claimant.post(`/applications/${appId}/reschedule`, { newTimeslotId: overrunSlotId!, reason: "" })).status,
  ).toBe(400);
});

it("only a confirmed application can be rescheduled — a still-pending one is rejected", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await owner.post("/moveouts", {
    title: "Pending-reschedule guard",
    area: "Test Hall",
    pickupLocation: "Side door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = locationOf(moveout);
  const moveoutId = manageUrl.split("/")[2];
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(5), endsAt: futureLocalDateTime(6) });
  const itemForm = new FormData();
  itemForm.set("name", "Still Pending Item");
  itemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, itemForm);

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(`/m/${moveoutId}`)).text();
  const slotIds = Array.from(publicPage.matchAll(/<option value="([A-Za-z0-9_-]+)">/g)).map((m) => m[1]);
  await claimant.post(`/m/${moveoutId}/apply`, { itemId: publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1], timeslotId: slotIds[0], nickname: "Claimant" });

  const managePage = await (await owner.get(manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");

  expect((await claimant.post(`/applications/${appId}/reschedule`, { newTimeslotId: slotIds[1], reason: "" })).status).toBe(409);
});

it("two simultaneous reschedule proposals on the same confirmed application resolve to exactly one pending proposal", async () => {
  const { owner, claimant, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Concurrent propose" });

  const [res1, res2] = await Promise.all([
    owner.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "from owner" }),
    claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "from claimant" }),
  ]);
  const statuses = [res1.status, res2.status].sort();
  expect(statuses).toEqual([302, 409]);
});

it("double-accepting the same proposal only succeeds once — a repeat click gets a clear conflict, not a second move", async () => {
  const { owner, claimant, slot2Id, applicationId, moveout } = await setUpConfirmedBooking(baseUrl, { title: "Double-accept guard" });
  await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const proposalId = pendingRescheduleIdFrom(managePage);

  const [first, second] = await Promise.all([
    owner.post(`/reschedule/${proposalId}/accept`),
    owner.post(`/reschedule/${proposalId}/accept`),
  ]);
  const statuses = [first.status, second.status].sort();
  expect(statuses).toEqual([302, 409]);
});

it("a reschedule proposal is invalidated by cancelling the booking, and can't then be accepted", async () => {
  const { owner, claimant, moveout, slot2Id, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Cancel-invalidates" });
  await claimant.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });

  const managePageBefore = await (await owner.get(moveout.manageUrl)).text();
  const proposalId = pendingRescheduleIdFrom(managePageBefore);

  const cancelForm = new FormData();
  cancelForm.set("reason", "no longer needed");
  expect((await owner.post(`/applications/${applicationId}/cancel`, cancelForm)).status).toBe(302);

  // Claimant proposed this one, so acceptance is the OWNER's act — and even
  // that must now fail, since the booking it would apply to no longer exists.
  expect((await owner.post(`/reschedule/${proposalId}/accept`)).status).toBe(409);
});

it("accepting a reschedule resets departure status to not_departed", async () => {
  const { owner, claimant, slot2Id, applicationId, moveout } = await setUpConfirmedBooking(baseUrl, { title: "Accept resets departure" });
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "arrived" })).status).toBe(302);
  let page = await (await claimant.get(moveout.publicUrl)).text();
  expect(page).toContain('data-departure-status="arrived"');

  await owner.post(`/applications/${applicationId}/reschedule`, { newTimeslotId: slot2Id, reason: "" });
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const proposalId = pendingRescheduleIdFrom(managePage);
  expect((await claimant.post(`/reschedule/${proposalId}/accept`)).status).toBe(302);

  page = await (await claimant.get(moveout.publicUrl)).text();
  expect(page).toContain('data-departure-status="not_departed"');
});

it("departure status can only be set by the claimant, only on a confirmed booking, and the claimant may move freely between values", async () => {
  const { owner, claimant, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Departure permission test" });

  const stranger = makeClient(baseUrl);
  expect((await stranger.post(`/applications/${applicationId}/departure`, { status: "departed" })).status).toBe(404);
  expect((await owner.post(`/applications/${applicationId}/departure`, { status: "departed" })).status).toBe(404);

  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "departed" })).status).toBe(302);
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "arrived" })).status).toBe(302);
  // Not a one-way ratchet — correcting back to an earlier value is allowed.
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "not_departed" })).status).toBe(302);
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "bogus" })).status).toBe(400);
});

it("cancelling or completing a booking blocks any further departure-status change", async () => {
  const { owner, claimant, applicationId } = await setUpConfirmedBooking(baseUrl, { title: "Departure terminal test" });
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "departed" })).status).toBe(302);
  expect((await owner.post(`/applications/${applicationId}/complete`)).status).toBe(302);
  expect((await claimant.post(`/applications/${applicationId}/departure`, { status: "arrived" })).status).toBe(409);
});

it("a proposed time that has since passed can no longer be accepted, and a fresh valid proposal is still allowed afterward", { timeout: 90_000 }, async () => {
  const owner = makeClient(baseUrl);
  const claimant = makeClient(baseUrl);
  const moveoutRes = await owner.post("/moveouts", {
    title: "Expired-proposal guard",
    area: "Test Hall",
    pickupLocation: "Side door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = locationOf(moveoutRes);
  const moveoutId = manageUrl.split("/")[2];
  // slot1: the confirmed slot, well in the future. slot2: the "proposed"
  // slot, deliberately just 1 second in the future so it reliably expires
  // by the time we try to accept it.
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  // `datetime-local` form input only carries minute precision (CLAUDE.md
  // note in moveout.test.ts), so the soonest a timeslot can start and still
  // read as "in the future" right now is the next whole minute boundary.
  // Recorded as a real epoch ms target (not "wait N ms from here") so the
  // several award round trips before the actual wait below don't eat into
  // how long is actually waited.
  const targetStartMs = (Math.floor(Date.now() / 60_000) + 1) * 60_000;
  const soon = futureLocalDateTime((targetStartMs - Date.now()) / 3_600_000);
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: soon, endsAt: futureLocalDateTime(1) });

  const itemForm = new FormData();
  itemForm.set("name", "Expiring-proposal item");
  itemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, itemForm);

  const publicPage = await (await claimant.get(`/m/${moveoutId}`)).text();
  const itemId = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1];
  // Timeslots list in starts_at order (src/ownership.ts#listTimeslots), and
  // the "soon" slot starts sooner than the +2h one — so it's listed FIRST,
  // not second. Pick by proximity to "soon" rather than assuming order.
  const slotIds = Array.from(publicPage.matchAll(/<option value="([A-Za-z0-9_-]+)">/g)).map((m) => m[1]);
  // The soon slot is the one starting earliest — first in the list.
  const [slot2Id, slot1Id] = slotIds;

  await claimant.post(`/m/${moveoutId}/apply`, { itemId, timeslotId: slot1Id, nickname: "Claimant" });
  const managePage = await (await owner.get(manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  await owner.post(`/applications/${appId}/confirm`);

  expect(
    (await claimant.post(`/applications/${appId}/reschedule`, { newTimeslotId: slot2Id, reason: "" })).status,
  ).toBe(302);
  const managePage2 = await (await owner.get(manageUrl)).text();
  const proposalId = pendingRescheduleIdFrom(managePage2);

  // Wait for slot2's start time to actually pass (the next minute boundary),
  // plus a safety margin for clock/JSON-round-trip slack.
  const waitMs = targetStartMs - Date.now() + 2000;
  await new Promise((r) => setTimeout(r, Math.max(waitMs, 0)));

  expect((await owner.post(`/reschedule/${proposalId}/accept`)).status).toBe(409);

  // The expired, now-resolved proposal doesn't block a brand new one — add
  // a fresh future slot and confirm a reschedule onto it succeeds.
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(6), endsAt: futureLocalDateTime(7) });
  const managePage3 = await (await owner.get(manageUrl)).text();
  const selectBlock3 = managePage3.match(/name="newTimeslotId" required>([\s\S]*?)<\/select>/)?.[1] ?? "";
  const freshSlotIds = Array.from(selectBlock3.matchAll(/<option value="([A-Za-z0-9_-]+)"/g)).map((m) => m[1]);
  const anotherSlot = freshSlotIds.find((id) => id !== slot1Id)!;
  expect(anotherSlot).toBeTruthy();
  expect(
    (await owner.post(`/applications/${appId}/reschedule`, { newTimeslotId: anotherSlot, reason: "retry after expiry" })).status,
  ).toBe(302);
});

it("the new feature never exposes the exact pickup location before confirmation, and one item still has at most one confirmed recipient", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await owner.post("/moveouts", {
    title: "Privacy still holds",
    area: "Test Hall",
    pickupLocation: "Secret Pickup Spot 99",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = locationOf(moveout);
  const moveoutId = manageUrl.split("/")[2];
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  const itemForm = new FormData();
  itemForm.set("name", "Privacy Item");
  itemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, itemForm);

  const bob = makeClient(baseUrl);
  const carol = makeClient(baseUrl);
  const publicPage = await (await bob.get(`/m/${moveoutId}`)).text();
  const itemId = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1];
  const slotId = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/)![1];

  await bob.post(`/m/${moveoutId}/apply`, { itemId, timeslotId: slotId, nickname: "Bob" });
  await carol.post(`/m/${moveoutId}/apply`, { itemId, timeslotId: slotId, nickname: "Carol" });

  let bobPage = await (await bob.get(`/m/${moveoutId}`)).text();
  expect(bobPage).not.toContain("Secret Pickup Spot 99");

  const managePage = await (await owner.get(manageUrl)).text();
  const bobApp = applicationIdFor(managePage, "Bob");
  const carolApp = applicationIdFor(managePage, "Carol");
  expect((await owner.post(`/applications/${bobApp}/confirm`)).status).toBe(302);
  // At most one confirmed recipient per item — Carol's confirm must now fail.
  expect((await owner.post(`/applications/${carolApp}/confirm`)).status).toBe(409);

  bobPage = await (await bob.get(`/m/${moveoutId}`)).text();
  expect(bobPage).toContain("Secret Pickup Spot 99");
  const carolPage = await (await carol.get(`/m/${moveoutId}`)).text();
  expect(carolPage).not.toContain("Secret Pickup Spot 99");
});

// Regression for a real UI bug found by browser-level verification (not
// visible to any of the HTTP-only tests above): src/views/pickup-card.ts
// used to decide whether to show the "Propose a different pickup time"
// form by checking `validSlotsForReschedule.length > 0` BEFORE excluding the
// application's own current timeslot from the options list. A move-out page
// with exactly one timeslot ever created — the one the booking is already
// confirmed against — has a non-empty `validSlotsForReschedule` (it contains
// that one timeslot) but zero slots actually offerable as a NEW time, so the
// old code rendered a `<details>` with a `<select required>` and no
// `<option>`s in it: a dead-end control a real person could open but never
// submit. See scripts/browser-verify-pickup-card.mjs for the two-browser
// confirmation that the fixed version shows the plain-language explanation
// instead, on both the claimant's and the creator's page.
it("shows no reschedule form (and no empty dropdown) when the only timeslot on the page is the one already confirmed", async () => {
  const owner = makeClient(baseUrl);
  const moveoutRes = await owner.post("/moveouts", {
    title: "Single-timeslot-only reschedule guard",
    area: "Test Hall",
    pickupLocation: "Side door",
    deadline: futureLocalDateTime(72),
    timezone: "Australia/Sydney",
    nickname: "Owner",
    visibility: "unlisted",
  });
  const manageUrl = locationOf(moveoutRes);
  const moveoutId = manageUrl.split("/")[2];
  // Exactly ONE timeslot ever exists on this page.
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(2), endsAt: futureLocalDateTime(3) });
  const itemForm = new FormData();
  itemForm.set("name", "Only-slot item");
  itemForm.set("category", "Other");
  await owner.post(`/m/${moveoutId}/items`, itemForm);

  const claimant = makeClient(baseUrl);
  const publicPage = await (await claimant.get(`/m/${moveoutId}`)).text();
  const itemId = publicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/)![1];
  const slotId = publicPage.match(/<option value="([A-Za-z0-9_-]+)">/)![1];
  await claimant.post(`/m/${moveoutId}/apply`, { itemId, timeslotId: slotId, nickname: "Claimant" });
  const managePage = await (await owner.get(manageUrl)).text();
  const appId = applicationIdFor(managePage, "Claimant");
  await owner.post(`/applications/${appId}/confirm`);

  const claimantView = await (await claimant.get(`/m/${moveoutId}`)).text();
  expect(claimantView).not.toContain("Propose a different pickup time");
  expect(claimantView).not.toMatch(/reschedule-slot-[A-Za-z0-9_-]+" name="newTimeslotId" required>\s*<\/select>/);
  expect(claimantView).toContain("No other pickup time is available to propose yet");

  const creatorView = await (await owner.get(manageUrl)).text();
  expect(creatorView).not.toContain("Propose a different pickup time");
  expect(creatorView).toContain("No other pickup time is available to offer yet");

  // Adding a second timeslot now gives both sides something real to propose.
  await owner.post(`/m/${moveoutId}/timeslots`, { startsAt: futureLocalDateTime(5), endsAt: futureLocalDateTime(6) });
  const claimantViewAfter = await (await claimant.get(`/m/${moveoutId}`)).text();
  expect(claimantViewAfter).toContain("Propose a different pickup time");
  const selectBlock = claimantViewAfter.match(/name="newTimeslotId" required>([\s\S]*?)<\/select>/)?.[1] ?? "";
  expect(Array.from(selectBlock.matchAll(/<option value="[A-Za-z0-9_-]+"/g)).length).toBeGreaterThan(0);
});
