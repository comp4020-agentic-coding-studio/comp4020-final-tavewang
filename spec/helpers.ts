// `fetch` doesn't keep cookies between calls, and these tests need several
// independent "browsers" (one per fridge member) talking to the one running
// app. A Client is a tiny per-browser cookie jar around fetch.
export interface Client {
  get(path: string): Promise<Response>;
  post(path: string, data?: Record<string, string>): Promise<Response>;
}

export function makeClient(baseUrl: string): Client {
  let cookie = "";

  const request = async (method: string, path: string, data?: Record<string, string>): Promise<Response> => {
    const res = await fetch(new URL(path, baseUrl), {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(data ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      },
      body: data ? new URLSearchParams(data).toString() : undefined,
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

export interface CreatedFridge {
  fridgePath: string;
  fridgeId: string;
  inviteToken: string;
}

export async function createFridge(client: Client, baseUrl: string, fridgeName: string, nickname: string): Promise<CreatedFridge> {
  const res = await client.post("/fridges", { fridgeName, nickname });
  const fridgePath = locationOf(res);
  const fridgeId = fridgePath.split("/").pop()!;
  const page = await (await client.get(fridgePath)).text();
  const match = page.match(/\/invite\/([A-Za-z0-9_-]+)"/);
  if (!match) throw new Error("invite link not found on fridge page");
  return { fridgePath, fridgeId, inviteToken: match[1] };
}

export async function joinFridge(client: Client, inviteToken: string, nickname: string): Promise<string> {
  const res = await client.post(`/invite/${inviteToken}/join`, { nickname });
  return locationOf(res);
}

export async function addItem(
  client: Client,
  fridgeId: string,
  fields: { name: string; quantity?: string; useBy?: string; shared?: boolean },
): Promise<string> {
  await client.post(`/f/${fridgeId}/items`, {
    name: fields.name,
    quantity: fields.quantity ?? "",
    useBy: fields.useBy ?? "",
    ...(fields.shared ? { shared: "1" } : {}),
  });
  const page = await (await client.get(`/f/${fridgeId}`)).text();
  const block = page
    .split('<li class="item-card')
    .find((b) => b.includes(`>${fields.name}<`) || b.includes(`${fields.name}</p>`));
  if (!block) throw new Error(`item "${fields.name}" not found on fridge page`);
  const idMatch = block.match(/\/items\/([A-Za-z0-9_-]+)\//);
  if (!idMatch) throw new Error(`no item id found for "${fields.name}"`);
  return idMatch[1];
}
