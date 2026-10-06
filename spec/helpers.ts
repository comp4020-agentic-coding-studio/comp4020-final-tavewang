// `fetch` doesn't keep cookies between calls, and these tests need several
// independent "browsers" (one mover, several claimants) talking to the one
// running app. A Client is a tiny per-browser cookie jar around fetch.
export interface Client {
  get(path: string): Promise<Response>;
  post(path: string, data?: Record<string, string> | FormData): Promise<Response>;
}

export function makeClient(baseUrl: string): Client {
  let cookie = "";

  const request = async (method: string, path: string, data?: Record<string, string> | FormData): Promise<Response> => {
    const isForm = data instanceof FormData;
    const res = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data && !isForm ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: isForm ? data : data ? new URLSearchParams(data).toString() : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };

  return {
    get: (path) => request("GET", path),
    post: (path, data) => request("POST", path, data),
  };
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
  fields: { title: string; area?: string; pickupLocation?: string; deadline: string; timezone?: string; nickname: string },
): Promise<CreatedMoveout> {
  const res = await client.post("/moveouts", {
    title: fields.title,
    area: fields.area ?? "Test Hall",
    pickupLocation: fields.pickupLocation ?? "Side door",
    deadline: fields.deadline,
    timezone: fields.timezone ?? "Australia/Sydney",
    nickname: fields.nickname,
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
  fields: { name: string; conditionNotes?: string; additionalNotes?: string },
): Promise<string> {
  await client.post(`/m/${moveoutId}/items`, {
    name: fields.name,
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
