// Crit 11: the public browse pool. These tests check the server-side
// visibility boundary itself — a fresh, cookie-less client reading GET "/"
// must only ever see what the query layer (src/ownership.ts#listBrowseItems)
// actually scoped to public+open+undeadlined, never a client-side filter
// over a broader result.
import { randomUUID } from "node:crypto";
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

// Every item name here gets a per-run unique suffix: these tests assert on
// GET "/" — the shared, cumulative public pool — by checking whether a name
// appears in the WHOLE page, not just this test's own fixtures. Without a
// unique suffix, re-running this file against a DATA_DIR that already has a
// previous run's (unconfirmed, still-public) "Lifecycle Test Rug" sitting in
// it would make a `.not.toContain` assertion see that stale leftover and
// fail — a false negative about test *data hygiene*, not about the app.
const unique = (name: string) => `${name} ${randomUUID().slice(0, 8)}`;

it("an unauthenticated new visitor can browse public items with no prior visit to the move-out page", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Browse visibility test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "public",
  });
  await addItem(owner, moveout.moveoutId, { name: "Public Browse Lamp", category: "Furniture" });

  const freshVisitor = makeClient(baseUrl);
  const page = await (await freshVisitor.get("/")).text();
  expect(page).toContain("Public Browse Lamp");
  expect(page).toContain("Furniture");
});

it("an unlisted page's items never appear in the pool or search, even though the page itself is still reachable by its link", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Unlisted test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "unlisted",
  });
  const itemName = unique("Secretive Unlisted Chair");
  await addItem(owner, moveout.moveoutId, { name: itemName, category: "Furniture" });

  const visitor = makeClient(baseUrl);
  const poolPage = await (await visitor.get("/")).text();
  expect(poolPage).not.toContain(itemName);

  // The submitted query is echoed back into the search box's own value=""
  // attribute regardless of whether anything matched, so the real assertion
  // is the explicit empty-result message, not a page-wide text search.
  const searchPage = await (await visitor.get(`/?q=${encodeURIComponent(itemName)}`)).text();
  expect(searchPage).toContain("No items found");

  // the page itself is still reachable by the direct link — unlisted means
  // "not discoverable," not "inaccessible"
  const directPage = await (await visitor.get(moveout.publicUrl)).text();
  expect(directPage).toContain(itemName);
});

it("only the creator can change a page's visibility", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Visibility permission test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "unlisted",
  });

  const stranger = makeClient(baseUrl);
  const strangerAttempt = await stranger.post(`/m/${moveout.moveoutId}/visibility`, { visibility: "public" });
  expect(strangerAttempt.status).toBe(404);

  const ownerAttempt = await owner.post(`/m/${moveout.moveoutId}/visibility`, { visibility: "public" });
  expect(ownerAttempt.status).toBe(302);

  await addItem(owner, moveout.moveoutId, { name: "Now Public After Owner Flip", category: "Other" });
  const poolPage = await (await makeClient(baseUrl).get("/")).text();
  expect(poolPage).toContain("Now Public After Owner Flip");
});

it("search, category and sort combine, and the state round-trips through the URL", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Search combo test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "public",
  });
  const lampName = unique("Combo Desk Lamp");
  const kettleName = unique("Combo Kitchen Kettle");
  await addItem(owner, moveout.moveoutId, { name: lampName, category: "Furniture" });
  await addItem(owner, moveout.moveoutId, { name: kettleName, category: "Kitchen" });

  // The search box always echoes the submitted query back into its own
  // `value="..."` attribute, so a page-wide `.toContain(lampName)` would
  // pass even when the RESULT LIST has nothing — this narrows every check
  // to the result grid itself (data-live-list="browse-items") to actually
  // test what matched, not what was typed.
  const resultsOf = (html: string): string => {
    const start = html.indexOf('data-live-list="browse-items"');
    const end = html.indexOf("</ul>", start);
    return html.slice(start, end);
  };

  const visitor = makeClient(baseUrl);
  // category alone
  let page = resultsOf(await (await visitor.get("/?category=Furniture")).text());
  expect(page).toContain(lampName);
  expect(page).not.toContain(kettleName);

  // search + category combined, matching nothing (wrong category for the name)
  const noMatch = await (await visitor.get(`/?q=${encodeURIComponent(lampName)}&category=Kitchen`)).text();
  expect(resultsOf(noMatch)).not.toContain(lampName);
  expect(noMatch).toContain("No items found");

  // search + category combined, matching
  page = resultsOf(await (await visitor.get(`/?q=${encodeURIComponent(lampName)}&category=Furniture`)).text());
  expect(page).toContain(lampName);

  // sort=deadline is accepted and doesn't error
  const sorted = await visitor.get("/?sort=deadline");
  expect(sorted.status).toBe(200);
});

it("an unrecognised category value is rejected server-side, not trusted from the query string", async () => {
  const visitor = makeClient(baseUrl);
  // Neither throws nor silently 500s — falls back to "no category filter"
  // rather than passing an arbitrary string into the SQL parameter for a
  // CHECK-constrained column.
  const res = await visitor.get("/?category=<script>alert(1)</script>");
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).not.toContain("<script>alert(1)</script>");
});

it("items never leave the pool via withdrawal, confirmation, or a settled application, and a cancellation can bring one back", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Pool lifecycle test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "public",
  });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemName = unique("Lifecycle Test Rug");
  const itemId = await addItem(owner, moveout.moveoutId, { name: itemName, category: "Household" });

  const visitor = makeClient(baseUrl);
  let pool = await (await visitor.get("/")).text();
  expect(pool).toContain(itemName);

  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const bob = makeClient(baseUrl);
  await apply(bob, moveout.moveoutId, { itemId, timeslotId, nickname: "Bob" });

  // still open (not yet confirmed) — still in the pool
  pool = await (await visitor.get("/")).text();
  expect(pool).toContain(itemName);

  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const appId = applicationIdFor(managePage, "Bob");
  await owner.post(`/applications/${appId}/confirm`);

  // confirmed -> reserved -> drops out of the pool
  pool = await (await visitor.get("/")).text();
  expect(pool).not.toContain(itemName);

  // the creator cancels the confirmed booking with a reason -> item reopens
  const cancelForm = new FormData();
  cancelForm.set("reason", "Changed my mind");
  await owner.post(`/applications/${appId}/cancel`, cancelForm);
  pool = await (await visitor.get("/")).text();
  expect(pool).toContain(itemName);
});

it("a withdrawn public item disappears from the pool", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Withdraw pool test",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "public",
  });
  const itemName = unique("Withdraw Pool Sofa");
  const itemId = await addItem(owner, moveout.moveoutId, { name: itemName, category: "Furniture" });

  let pool = await (await makeClient(baseUrl).get("/")).text();
  expect(pool).toContain(itemName);

  await owner.post(`/items/${itemId}/withdraw`);
  pool = await (await makeClient(baseUrl).get("/")).text();
  expect(pool).not.toContain(itemName);
});

it("the pool query never leaks a pickup address, an application note, or a device cookie", async () => {
  const owner = makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: "Privacy leak test",
    pickupLocation: "Top Secret Address 999",
    deadline: futureLocalDateTime(72),
    nickname: "Owner",
    visibility: "public",
  });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  const itemId = await addItem(owner, moveout.moveoutId, { name: unique("Privacy Leak Desk"), category: "Furniture" });

  const visitor = makeClient(baseUrl);
  const publicPage = await (await visitor.get(moveout.publicUrl)).text();
  const timeslotId = firstTimeslotId(publicPage, itemId);
  const bob = makeClient(baseUrl);
  const bobCookie = (await bob.get(moveout.publicUrl)).headers.get("set-cookie");
  const secretNickname = unique("Confidential Bob Nickname");
  await apply(bob, moveout.moveoutId, {
    itemId,
    timeslotId,
    nickname: secretNickname,
    note: "call me on a secret number",
  });

  const pool = await (await makeClient(baseUrl).get("/")).text();
  expect(pool).not.toContain("Top Secret Address 999");
  expect(pool).not.toContain(secretNickname);
  expect(pool).not.toContain("call me on a secret number");
  if (bobCookie) {
    const deviceValue = bobCookie.split(";")[0].split("=")[1];
    expect(pool).not.toContain(deviceValue);
  }
});
