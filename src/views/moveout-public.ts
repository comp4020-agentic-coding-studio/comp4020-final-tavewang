import { html } from "hono/html";
import { layout } from "./layout.ts";
import { applicationStatusLabel, itemStatusLabel } from "./status.ts";
import { formatInZone } from "../tz.ts";
import type { Application, Item, Moveout, Timeslot } from "../db.ts";

function timeslotLabel(slot: Timeslot, timezone: string): string {
  return `${formatInZone(slot.starts_at, timezone)} – ${new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    timeStyle: "short",
  }).format(new Date(slot.ends_at))}`;
}

function myRequestCard(app: Application, item: Item, moveout: Moveout, validSlots: Timeslot[]) {
  const label = applicationStatusLabel(app);
  return html`
    <li class="item-card tone-${app.status === "confirmed" ? "active" : app.status === "pending" ? "pending" : "closed"}">
      <div class="item-main">
        <p class="item-name">${item.name}</p>
        <p class="item-badge">${label}</p>
        ${app.note ? html`<p class="item-meta">Your note: ${app.note}</p>` : ""}
        ${app.status === "confirmed"
          ? html`<p class="item-meta"><strong>Pickup spot:</strong> ${moveout.pickup_location}</p>`
          : ""}
      </div>
      <div class="item-actions">
        ${app.status === "pending" && validSlots.length > 0
          ? html`
              <details class="edit-details">
                <summary>Change pickup time</summary>
                <form method="post" action="/applications/${app.id}/timeslot" class="stacked-form">
                  <div class="field">
                    <label for="slot-${app.id}">New time</label>
                    <select id="slot-${app.id}" name="timeslotId" required>
                      ${validSlots.map(
                        (slot) => html`<option value="${slot.id}">${timeslotLabel(slot, moveout.timezone)}</option>`,
                      )}
                    </select>
                  </div>
                  <button type="submit">Update time</button>
                </form>
              </details>
            `
          : ""}
        ${app.status === "pending" || app.status === "confirmed"
          ? html`
              <form method="post" action="/applications/${app.id}/cancel" class="inline-form">
                <button type="submit">Cancel</button>
              </form>
            `
          : ""}
      </div>
    </li>
  `;
}

function applyForm(item: Item, moveoutId: string, validSlots: Timeslot[], timezone: string) {
  if (validSlots.length === 0) {
    return html`<p class="muted">No pickup times are available yet — check back later.</p>`;
  }
  return html`
    <details class="edit-details">
      <summary>Request this</summary>
      <form method="post" action="/m/${moveoutId}/apply" class="stacked-form">
        <input type="hidden" name="itemId" value="${item.id}" />
        <div class="field">
          <label for="nickname-${item.id}">Your name</label>
          <input id="nickname-${item.id}" name="nickname" required maxlength="40" />
        </div>
        <div class="field">
          <label for="timeslot-${item.id}">Pickup time</label>
          <select id="timeslot-${item.id}" name="timeslotId" required>
            ${validSlots.map((slot) => html`<option value="${slot.id}">${timeslotLabel(slot, timezone)}</option>`)}
          </select>
        </div>
        <div class="field">
          <label for="note-${item.id}">Note (optional)</label>
          <input id="note-${item.id}" name="note" maxlength="200" placeholder="e.g. I can come earlier if needed" />
        </div>
        <button type="submit">Send request</button>
      </form>
    </details>
  `;
}

function itemCard(item: Item, moveoutId: string, validSlots: Timeslot[], timezone: string, alreadyRequested: boolean) {
  const tone = item.status === "open" ? "pending" : item.status === "reserved" ? "active" : "done";
  return html`
    <li class="item-card tone-${tone}">
      <div class="item-main">
        ${item.photo_path ? html`<img class="item-photo" src="/${item.photo_path}" alt="" />` : ""}
        <p class="item-name">${item.name}</p>
        ${item.condition_notes ? html`<p class="item-meta">${item.condition_notes}</p>` : ""}
        ${item.additional_notes ? html`<p class="item-meta">${item.additional_notes}</p>` : ""}
        <p class="item-badge">${itemStatusLabel(item.status)}</p>
      </div>
      <div class="item-actions">
        ${item.status === "open"
          ? alreadyRequested
            ? html`<p class="muted">You've already requested this — see "Your requests" above.</p>`
            : applyForm(item, moveoutId, validSlots, timezone)
          : ""}
      </div>
    </li>
  `;
}

export async function moveoutPublicView(
  moveout: Moveout,
  items: Item[],
  validSlots: Timeslot[],
  myApplications: { app: Application; item: Item }[],
  requestedItemIds: Set<string>,
): Promise<string> {
  const body = html`
    <h1>${moveout.title}</h1>
    <p class="lede">
      ${moveout.area} · Everything must be collected by
      <strong>${formatInZone(moveout.deadline_at, moveout.timezone)}</strong>
    </p>

    ${myApplications.length > 0
      ? html`
          <section>
            <h2>Your requests</h2>
            <ul class="item-list">
              ${myApplications.map(({ app, item }) => myRequestCard(app, item, moveout, validSlots))}
            </ul>
          </section>
        `
      : ""}

    <section>
      <h2>What's available</h2>
      ${items.length === 0
        ? html`<p class="empty">Nothing posted yet — check back later.</p>`
        : html`<ul class="item-list">
            ${items.map((item) => itemCard(item, moveout.id, validSlots, moveout.timezone, requestedItemIds.has(item.id)))}
          </ul>`}
    </section>
  `;
  return layout(moveout.title, body);
}

export async function moveoutNotFoundView(): Promise<string> {
  const body = html`
    <h1>This link isn't valid</h1>
    <p>The move-out page you're looking for doesn't exist, or the link is broken.</p>
    <p><a href="/">Go home</a></p>
  `;
  return layout("Not found", body);
}
