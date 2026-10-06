import { html } from "hono/html";
import { layout } from "./layout.ts";
import { formatInZone } from "../tz.ts";
import type { Application, Item, Moveout, Timeslot } from "../db.ts";

function slotLabel(slot: Timeslot, timezone: string): string {
  return formatInZone(slot.starts_at, timezone);
}

export interface PendingEntry {
  app: Application;
  timeslot: Timeslot;
  timeslotHasPassed: boolean;
}

export interface OpenItemEntry {
  item: Item;
  pending: PendingEntry[];
}

export interface UpcomingEntry {
  app: Application;
  item: Item;
  timeslot: Timeslot;
  waitlist: PendingEntry[];
}

export interface CompletedEntry {
  app: Application;
  item: Item;
  timeslot: Timeslot;
}

function pendingRow(entry: PendingEntry, timezone: string, withConfirm: boolean) {
  return html`
    <li class="applicant-row" data-application-id="${entry.app.id}">
      <span>${entry.app.claimer_nickname} — ${slotLabel(entry.timeslot, timezone)}</span>
      ${entry.app.note ? html`<span class="muted"> · "${entry.app.note}"</span>` : ""}
      ${withConfirm
        ? entry.timeslotHasPassed
          ? html`<span class="error-inline">Their timeslot has passed — ask them to pick a new one.</span>`
          : html`
              <form method="post" action="/applications/${entry.app.id}/confirm" class="inline-form">
                <button type="submit" class="primary">Confirm</button>
              </form>
            `
        : ""}
    </li>
  `;
}

function openItemCard(entry: OpenItemEntry, timezone: string) {
  return html`
    <li class="item-card tone-pending">
      <div class="item-main">
        ${entry.item.photo_path ? html`<img class="item-photo" src="/${entry.item.photo_path}" alt="" />` : ""}
        <p class="item-name">${entry.item.name}</p>
        ${entry.item.condition_notes ? html`<p class="item-meta">${entry.item.condition_notes}</p>` : ""}
        ${entry.pending.length === 0
          ? html`<p class="muted">No requests yet.</p>`
          : html`<ul class="applicant-list">${entry.pending.map((p) => pendingRow(p, timezone, true))}</ul>`}
      </div>
      <div class="item-actions">
        <form method="post" action="/items/${entry.item.id}/withdraw" class="inline-form">
          <button type="submit">Withdraw</button>
        </form>
      </div>
    </li>
  `;
}

function upcomingCard(entry: UpcomingEntry, timezone: string) {
  return html`
    <li class="item-card tone-active">
      <div class="item-main">
        <p class="item-name">${entry.item.name}</p>
        <p class="item-meta">${entry.app.claimer_nickname} · ${slotLabel(entry.timeslot, timezone)}</p>
        ${entry.app.note ? html`<p class="item-meta">Note: ${entry.app.note}</p>` : ""}
        ${entry.waitlist.length > 0
          ? html`<p class="muted">${entry.waitlist.length} more waiting if this falls through:</p>
              <ul class="applicant-list">${entry.waitlist.map((p) => pendingRow(p, timezone, false))}</ul>`
          : ""}
      </div>
      <div class="item-actions">
        <form method="post" action="/applications/${entry.app.id}/complete" class="inline-form">
          <button type="submit" class="primary">Mark picked up</button>
        </form>
        <details class="edit-details">
          <summary>Cancel</summary>
          <form method="post" action="/applications/${entry.app.id}/cancel" class="stacked-form">
            <div class="field">
              <label for="reason-${entry.app.id}">Reason (shown to ${entry.app.claimer_nickname})</label>
              <input id="reason-${entry.app.id}" name="reason" required maxlength="200" />
            </div>
            <button type="submit">Cancel this booking</button>
          </form>
        </details>
      </div>
    </li>
  `;
}

function completedRow(entry: CompletedEntry, timezone: string) {
  return html`
    <tr>
      <td>${entry.item.name}</td>
      <td>${entry.app.claimer_nickname}</td>
      <td>${slotLabel(entry.timeslot, timezone)}</td>
      <td>${entry.app.completed_at ?? ""}</td>
    </tr>
  `;
}

export async function moveoutManageView(
  moveout: Moveout,
  shareUrl: string,
  data: {
    openItems: OpenItemEntry[];
    upcoming: UpcomingEntry[];
    completed: CompletedEntry[];
    withdrawnItems: Item[];
    timeslots: Timeslot[];
  },
): Promise<string> {
  const tz = moveout.timezone;
  const body = html`
    <h1>${moveout.title}</h1>
    <p class="lede">
      ${moveout.area} · Pickup at <strong>${moveout.pickup_location}</strong> · Deadline
      <strong>${formatInZone(moveout.deadline_at, tz)}</strong>
    </p>

    <section class="invite-box">
      <h2>Share this page</h2>
      <p>Anyone with this link can browse and request items — they can't manage this page.</p>
      <div class="invite-row">
        <input id="shareLink" type="text" readonly value="${shareUrl}" onclick="this.select()" />
        <button type="button" data-copy="#shareLink">Copy</button>
      </div>
    </section>

    <section>
      <h2>Add an item</h2>
      <form method="post" action="/m/${moveout.id}/items" enctype="multipart/form-data" class="stacked-form">
        <div class="field">
          <label for="itemName">Name</label>
          <input id="itemName" name="name" required maxlength="80" placeholder="e.g. Desk lamp" />
        </div>
        <div class="field">
          <label for="itemPhoto">Photo (optional, JPEG/PNG/WebP, up to 5 MB)</label>
          <input id="itemPhoto" name="photo" type="file" accept="image/jpeg,image/png,image/webp" />
        </div>
        <div class="field">
          <label for="itemCondition">Condition / known issues</label>
          <input id="itemCondition" name="conditionNotes" maxlength="200" placeholder="e.g. works fine, one scratch on the base" />
        </div>
        <div class="field">
          <label for="itemAdditional">Anything else to add (optional)</label>
          <input id="itemAdditional" name="additionalNotes" maxlength="200" />
        </div>
        <button type="submit">Add item</button>
      </form>
    </section>

    <section>
      <h2>Add a pickup time</h2>
      <form method="post" action="/m/${moveout.id}/timeslots" class="stacked-form">
        <div class="field">
          <label for="slotStart">Starts</label>
          <input id="slotStart" name="startsAt" type="datetime-local" required />
        </div>
        <div class="field">
          <label for="slotEnd">Ends</label>
          <input id="slotEnd" name="endsAt" type="datetime-local" required />
        </div>
        <button type="submit">Add time</button>
      </form>
      ${data.timeslots.length > 0
        ? html`<p class="muted">
            Current times: ${data.timeslots.map((s) => slotLabel(s, tz)).join(", ")}
          </p>`
        : html`<p class="muted">No pickup times yet — add at least one before people can request anything.</p>`}
    </section>

    <section>
      <h2>Not yet arranged</h2>
      ${data.openItems.length === 0
        ? html`<p class="empty">Nothing open right now.</p>`
        : html`<ul class="item-list">${data.openItems.map((e) => openItemCard(e, tz))}</ul>`}
    </section>

    <section>
      <h2>Upcoming hand-offs</h2>
      ${data.upcoming.length === 0
        ? html`<p class="empty">Nothing confirmed yet.</p>`
        : html`<ul class="item-list">${data.upcoming.map((e) => upcomingCard(e, tz))}</ul>`}
    </section>

    <section>
      <h2>Completed</h2>
      ${data.completed.length === 0
        ? html`<p class="empty">Nothing handed over yet.</p>`
        : html`<table class="history-table">
            <thead>
              <tr><th scope="col">Item</th><th scope="col">Picked up by</th><th scope="col">Timeslot</th><th scope="col">When</th></tr>
            </thead>
            <tbody>${data.completed.map((e) => completedRow(e, tz))}</tbody>
          </table>`}
    </section>

    ${data.withdrawnItems.length > 0
      ? html`
          <details>
            <summary>Withdrawn items (${data.withdrawnItems.length})</summary>
            <ul class="plain-list">${data.withdrawnItems.map((i) => html`<li>${i.name}</li>`)}</ul>
          </details>
        `
      : ""}

    <script>
      document.querySelectorAll("[data-copy]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var input = document.querySelector(btn.getAttribute("data-copy"));
          if (!input) return;
          input.select();
          if (navigator.clipboard) {
            navigator.clipboard.writeText(input.value).then(function () {
              btn.textContent = "Copied!";
              setTimeout(function () {
                btn.textContent = "Copy";
              }, 1500);
            });
          } else {
            document.execCommand("copy");
          }
        });
      });
    </script>
  `;
  return layout(`${moveout.title} · manage`, body);
}
