// `fetch` doesn't keep cookies between calls, and these tests need several
// independent "browsers" (one mover, several claimants) talking to the one
// running app. A Client is a tiny per-browser cookie jar around fetch.
export interface Client {
  get(path: string): Promise<Response>;
  post(path: string, data?: Record<string, string> | FormData): Promise<Response>;
}

function makeRawClient(baseUrl: string): Client {
  // A per-cookie-name map, not one joined string — a response can set
  // several cookies at once (e.g. src/routes/auth.ts's register/login set
  // BOTH `device` and `session` in the same response), and
  // `Headers#get("set-cookie")` comma-joins every Set-Cookie header into one
  // string that is NOT valid to replay as a single Cookie request header.
  // `Headers#getSetCookie()` (Node's fetch, since it implements the
  // multi-value Headers spec for this one header) returns them as a real
  // array instead.
  const cookies = new Map<string, string>();

  const request = async (method: string, path: string, data?: Record<string, string> | FormData): Promise<Response> => {
    const isForm = data instanceof FormData;
    const cookieHeader = Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
    const res = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        ...(data && !isForm ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: isForm ? data : data ? new URLSearchParams(data).toString() : undefined,
    });
    for (const setCookie of res.headers.getSetCookie()) {
      const [pair] = setCookie.split(";");
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return res;
  };

  return {
    get: (path) => request("GET", path),
    post: (path, data) => request("POST", path, data),
  };
}

let uniqueCounter = 0;
function uniqueTestEmail(label = "test"): string {
  uniqueCounter += 1;
  return `${label}-${Date.now()}-${process.pid}-${uniqueCounter}@example.test`;
}

// A brand-new device with no cookies at all, never signed in — for the
// specific tests that are actually about anonymous behaviour (pre-sign-in
// Browse, the login/register gate itself, claim-on-register). Every OTHER
// helper in this file assumes a signed-in `Client` by default, since this
// round's brief requires an account to create a page or send a request —
// matching what most of the test suite is actually testing (the business
// rules), not the login gate itself.
export function makeAnonymousClient(baseUrl: string): Client {
  return makeRawClient(baseUrl);
}

// The default test "browser": a fresh device, immediately registered with
// its own unique throwaway account. Nearly everything in this suite needs a
// signed-in actor to do anything at all (create a page, apply) — centralising
// that here, rather than every test file calling register() first, is what
// kept every pre-existing call site in this suite (`makeClient(baseUrl)`)
// working unchanged once sign-in became mandatory, instead of needing every
// single test rewritten to add its own registration boilerplate.
export async function makeClient(baseUrl: string, opts: { email?: string; password?: string } = {}): Promise<Client> {
  const client = makeRawClient(baseUrl);
  const email = opts.email ?? uniqueTestEmail();
  const password = opts.password ?? "a-test-password-123";
  const res = await client.post("/register", { email, password });
  if (res.status !== 200) throw new Error(`test setup: register failed for ${email}: ${res.status} ${await res.text()}`);
  return client;
}

// Redirects come back as opaque "manual" responses (status 302) rather than
// being followed, so tests that need the next page fetch it themselves via
// this helper.
export function locationOf(res: Response): string {
  const location = res.headers.get("location");
  if (!location) throw new Error(`expected a redirect, got ${res.status}`);
  return location;
}

export interface CreatedMoveout {
  moveoutId: string;
  manageUrl: string;
  publicUrl: string;
}

export async function createMoveout(
  client: Client,
  fields: {
    title: string;
    area?: string;
    pickupLocation?: string;
    deadline: string;
    timezone?: string;
    nickname: string;
    visibility?: "public" | "unlisted";
  },
): Promise<CreatedMoveout> {
  const res = await client.post("/moveouts", {
    title: fields.title,
    area: fields.area ?? "Test Hall",
    pickupLocation: fields.pickupLocation ?? "Side door",
    deadline: fields.deadline,
    timezone: fields.timezone ?? "Australia/Sydney",
    nickname: fields.nickname,
    visibility: fields.visibility ?? "public",
  });
  const manageUrl = locationOf(res); // /m/:id/manage
  const moveoutId = manageUrl.split("/")[2];
  return { moveoutId, manageUrl, publicUrl: `/m/${moveoutId}` };
}

export async function addTimeslot(client: Client, moveoutId: string, startsAt: string, endsAt: string): Promise<void> {
  const res = await client.post(`/m/${moveoutId}/timeslots`, { startsAt, endsAt });
  if (res.status !== 302) throw new Error(`addTimeslot failed: ${res.status} ${await res.text()}`);
}

export async function addItem(
  client: Client,
  moveoutId: string,
  fields: { name: string; category?: string; conditionNotes?: string; additionalNotes?: string },
): Promise<string> {
  await client.post(`/m/${moveoutId}/items`, {
    name: fields.name,
    category: fields.category ?? "Other",
    conditionNotes: fields.conditionNotes ?? "",
    additionalNotes: fields.additionalNotes ?? "",
  });
  const page = await (await client.get(`/m/${moveoutId}/manage`)).text();
  const block = findBlock(page, fields.name);
  const idMatch = block.match(/\/items\/([A-Za-z0-9_-]+)\/withdraw/);
  if (!idMatch) throw new Error(`no item id found for "${fields.name}" on the manage page`);
  return idMatch[1];
}

function findBlock(page: string, needle: string): string {
  const parts = page.split('<li class="item-card');
  const block = parts.find((b) => b.includes(`>${needle}<`));
  if (!block) throw new Error(`"${needle}" not found on page`);
  return block;
}

// Scrapes the first valid pickup-time <option> for a given item's apply form
// on the public page — i.e. the timeslot id a real visitor would pick.
export function firstTimeslotId(publicPage: string, itemId: string): string {
  const after = publicPage.split(`name="itemId" value="${itemId}"`)[1];
  if (!after) throw new Error(`apply form for item ${itemId} not found`);
  const match = after.match(/<option value="([A-Za-z0-9_-]+)">/);
  if (!match) throw new Error(`no timeslot option found for item ${itemId}`);
  return match[1];
}

export async function apply(
  client: Client,
  moveoutId: string,
  fields: { itemId: string; timeslotId: string; nickname: string; note?: string },
): Promise<Response> {
  return client.post(`/m/${moveoutId}/apply`, {
    itemId: fields.itemId,
    timeslotId: fields.timeslotId,
    nickname: fields.nickname,
    note: fields.note ?? "",
  });
}

// Sets up a move-out page with one item, two valid timeslots, and one
// claimant's application confirmed against the first slot — the common
// starting point for reschedule/departure-status tests, which all need a
// CONFIRMED booking before anything in this round's brief applies.
export async function setUpConfirmedBooking(
  baseUrl: string,
  opts: { ownerNickname?: string; claimantNickname?: string; title: string } = { title: "Confirmed booking test" },
): Promise<{
  owner: Client;
  claimant: Client;
  moveout: CreatedMoveout;
  itemId: string;
  slot1Id: string;
  slot2Id: string;
  applicationId: string;
}> {
  const owner = await makeClient(baseUrl);
  const claimant = await makeClient(baseUrl);
  const moveout = await createMoveout(owner, {
    title: opts.title,
    deadline: futureLocalDateTime(72),
    nickname: opts.ownerNickname ?? "Owner",
  });
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(2), futureLocalDateTime(3));
  await addTimeslot(owner, moveout.moveoutId, futureLocalDateTime(5), futureLocalDateTime(6));
  const itemId = await addItem(owner, moveout.moveoutId, { name: "Confirmable Item" });

  const publicPage = await (await claimant.get(moveout.publicUrl)).text();
  const timeslotOptions = Array.from(
    publicPage.matchAll(/<option value="([A-Za-z0-9_-]+)">/g),
  ).map((m) => m[1]);
  const slot1Id = timeslotOptions[0];
  const slot2Id = timeslotOptions[1];

  await apply(claimant, moveout.moveoutId, {
    itemId,
    timeslotId: slot1Id,
    nickname: opts.claimantNickname ?? "Claimant",
  });
  const managePage = await (await owner.get(moveout.manageUrl)).text();
  const applicationId = applicationIdFor(managePage, opts.claimantNickname ?? "Claimant");
  const confirmRes = await owner.post(`/applications/${applicationId}/confirm`);
  if (confirmRes.status !== 302) throw new Error(`confirm failed: ${confirmRes.status} ${await confirmRes.text()}`);

  return { owner, claimant, moveout, itemId, slot1Id, slot2Id, applicationId };
}

// Scrapes a reschedule proposal's id from a page containing its pending
// block (src/views/pickup-card.ts's data-reschedule-id).
export function pendingRescheduleIdFrom(page: string): string {
  const match = page.match(/data-reschedule-id="([A-Za-z0-9_-]+)"/);
  if (!match) throw new Error("no pending reschedule proposal found on page");
  return match[1];
}

// A claimant's OWN application id, read from their own "Your requests"
// section of the public page (keyed by data-application-id, never by
// nickname) — unlike applicationIdFor (which scrapes the manage page by
// nickname text and so can't tell two same-named applicants apart), this
// lets a test find each of two "Sam"s' own application even though they
// share a display name.
export function myOwnApplicationId(publicPageForThatClient: string): string {
  const match = publicPageForThatClient.match(/data-application-id="([A-Za-z0-9_-]+)"/);
  if (!match) throw new Error("no application id found on this client's own public page");
  return match[1];
}

// Finds the application id for a given applicant's row on the manage page.
// Every applicant-row carries its id as a `data-application-id` attribute
// (regardless of whether a confirm button is also rendered — a waitlisted
// row has no such button), so this looks for that attribute immediately
// preceding the nickname, rather than scanning for a confirm link that may
// not exist.
export function applicationIdFor(managePage: string, nickname: string): string {
  const pattern = new RegExp(
    `data-application-id="([A-Za-z0-9_-]+)"[^>]*>\\s*<span>${nickname}\\s`,
  );
  const match = managePage.match(pattern);
  if (!match) throw new Error(`no applicant row found for "${nickname}"`);
  return match[1];
}

// Builds a `datetime-local`-shaped string for "hoursFromNow" in the future,
// expressed as the wall-clock time that instant actually is in `timeZone` —
// not the test runner's own system timezone, which may be anywhere. Using
// Intl for this (rather than the machine's local getHours()/getDate()) is
// what makes a value here round-trip correctly through
// src/tz.ts#zonedDateTimeToUtc regardless of where the tests run.
export function futureLocalDateTime(hoursFromNow: number, timeZone = "Australia/Sydney"): string {
  const date = new Date(Date.now() + hoursFromNow * 3600_000);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
