import { expect, inject, it } from "vitest";
import { addItem, createFridge, joinFridge, makeClient, locationOf } from "./helpers.ts";

const baseUrl = inject("baseUrl");

it("an unshared item can't be claimed by someone other than its owner", async () => {
  const owner = makeClient(baseUrl);
  const other = makeClient(baseUrl);

  const fridge = await createFridge(owner, baseUrl, "Unshared test fridge", "Owner");
  await joinFridge(other, fridge.inviteToken, "Other");
  const itemId = await addItem(owner, fridge.fridgeId, { name: "Private Cheese" });

  const res = await other.post(`/items/${itemId}/claim`);
  expect(res.status).toBe(409);

  // still "kept", still visible with no claimant — the fridge page shouldn't
  // show it as claimed to anyone
  const page = await (await owner.get(fridge.fridgePath)).text();
  expect(page).toContain("Private Cheese");
  expect(page).not.toMatch(/Claimed by/);
});

it("a non-member can't read or change another fridge's data", async () => {
  const insider = makeClient(baseUrl);
  const outsider = makeClient(baseUrl);

  const fridge = await createFridge(insider, baseUrl, "Private fridge", "Insider");
  await createFridge(outsider, baseUrl, "Outsider's own fridge", "Outsider");
  const itemId = await addItem(insider, fridge.fridgeId, { name: "Oat Milk", shared: true });

  const readRes = await outsider.get(fridge.fridgePath);
  expect(readRes.status).toBe(403);

  const claimRes = await outsider.post(`/items/${itemId}/claim`);
  expect(claimRes.status).toBe(404);

  const addRes = await outsider.post(`/f/${fridge.fridgeId}/items`, { name: "Smuggled Item" });
  expect(addRes.status).toBe(403);
});

it("two simultaneous claims on the same item resolve to exactly one winner", async () => {
  const owner = makeClient(baseUrl);
  const alice = makeClient(baseUrl);
  const bob = makeClient(baseUrl);

  const fridge = await createFridge(owner, baseUrl, "Race fridge", "Owner");
  await joinFridge(alice, fridge.inviteToken, "Alice");
  await joinFridge(bob, fridge.inviteToken, "Bob");
  const itemId = await addItem(owner, fridge.fridgeId, { name: "Last Yoghurt", shared: true });

  const [resA, resB] = await Promise.all([alice.post(`/items/${itemId}/claim`), bob.post(`/items/${itemId}/claim`)]);
  const statuses = [resA.status, resB.status].sort();
  expect(statuses).toEqual([302, 409]);

  const page = await (await owner.get(fridge.fridgePath)).text();
  const claimedByAlice = page.includes("Claimed by Alice");
  const claimedByBob = page.includes("Claimed by Bob");
  expect(claimedByAlice !== claimedByBob).toBe(true); // exactly one, not both, not neither
});

it("only the claimant can unclaim their own claim", async () => {
  const owner = makeClient(baseUrl);
  const claimant = makeClient(baseUrl);
  const bystander = makeClient(baseUrl);

  const fridge = await createFridge(owner, baseUrl, "Unclaim fridge", "Owner");
  await joinFridge(claimant, fridge.inviteToken, "Claimant");
  await joinFridge(bystander, fridge.inviteToken, "Bystander");
  const itemId = await addItem(owner, fridge.fridgeId, { name: "Butter", shared: true });
  await claimant.post(`/items/${itemId}/claim`);

  const ownerAttempt = await owner.post(`/items/${itemId}/unclaim`);
  expect(ownerAttempt.status).toBe(403);
  const bystanderAttempt = await bystander.post(`/items/${itemId}/unclaim`);
  expect(bystanderAttempt.status).toBe(403);

  const stillClaimed = await (await owner.get(fridge.fridgePath)).text();
  expect(stillClaimed).toContain("Claimed by Claimant");

  const claimantAttempt = await claimant.post(`/items/${itemId}/unclaim`);
  expect(claimantAttempt.status).toBe(302);
});

it("a used item is removed from the current view but kept in history with its owner and claimant", async () => {
  const owner = makeClient(baseUrl);
  const claimant = makeClient(baseUrl);

  const fridge = await createFridge(owner, baseUrl, "History fridge", "Owner");
  await joinFridge(claimant, fridge.inviteToken, "Claimant");
  const itemId = await addItem(owner, fridge.fridgeId, { name: "Spinach", quantity: "half a bag", shared: true });

  await claimant.post(`/items/${itemId}/claim`);
  const useRes = await claimant.post(`/items/${itemId}/use`);
  expect(useRes.status).toBe(302);

  const current = await (await owner.get(fridge.fridgePath)).text();
  expect(current).not.toContain("Spinach");

  const history = await (await owner.get(`${fridge.fridgePath}/history`)).text();
  expect(history).toContain("Spinach");
  expect(history).toContain("Owner");
  expect(history).toContain("Claimant");
});

it("the owner can mark their own unclaimed item used directly", async () => {
  const owner = makeClient(baseUrl);
  const fridge = await createFridge(owner, baseUrl, "Owner-use fridge", "Owner");
  const itemId = await addItem(owner, fridge.fridgeId, { name: "Leftover Rice" });

  const res = await owner.post(`/items/${itemId}/use`);
  expect(res.status).toBe(302);

  const history = await (await owner.get(`${fridge.fridgePath}/history`)).text();
  expect(history).toContain("Leftover Rice");
});

it("the same nickname in two different browsers is still two different members", async () => {
  const owner = makeClient(baseUrl);
  const first = makeClient(baseUrl);
  const second = makeClient(baseUrl);

  const fridge = await createFridge(owner, baseUrl, "Same name fridge", "Owner");
  await joinFridge(first, fridge.inviteToken, "Sam");
  await joinFridge(second, fridge.inviteToken, "Sam");

  const itemId = await addItem(owner, fridge.fridgeId, { name: "Juice", shared: true });
  const claimRes = await first.post(`/items/${itemId}/claim`);
  expect(claimRes.status).toBe(302);

  // the SECOND "Sam" (a different browser/member) is not the claimant, so
  // can't unclaim what the first "Sam" claimed
  const unclaimAttempt = await second.post(`/items/${itemId}/unclaim`);
  expect(unclaimAttempt.status).toBe(403);
});

it("a browser keeps its identity across requests without re-joining", async () => {
  const member = makeClient(baseUrl);
  const fridge = await createFridge(member, baseUrl, "Identity fridge", "Returning Person");

  // visiting the invite link again, as someone already a member, goes
  // straight back into the fridge rather than asking them to join again
  const res = await member.get(`/invite/${fridge.inviteToken}`);
  expect(res.status).toBe(302);
  expect(locationOf(res)).toBe(fridge.fridgePath);
});
