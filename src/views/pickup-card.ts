import { html } from "hono/html";
import { departureStatusLabel } from "./status.ts";
import { formatInZone } from "../tz.ts";
import type { Application, Moveout, Timeslot } from "../db.ts";
import type { PendingRescheduleView } from "../ownership.ts";

function slotRange(slot: Timeslot, timezone: string): string {
  return `${formatInZone(slot.starts_at, timezone)} – ${new Intl.DateTimeFormat("en-AU", {
    timeZone: timezone,
    timeStyle: "short",
  }).format(new Date(slot.ends_at))}`;
}

// The full pickup arrangement card (brief section B): item name, confirmed
// status, timeslot with an explicit timezone, pickup location, the
// claimant's departure status, and any pending reschedule proposal — shown
// in full to BOTH parties. `viewerRole` only changes which controls render
// (a claimant can set departure status and the creator can't; either party
// can propose/accept/decline/withdraw a reschedule, per the brief), never
// what information is shown — CLAUDE.md's "exact pickup location only to
// the confirmed claimant" still applies: the creator always knows their own
// pickup_location, and a claimant only ever sees this card once confirmed.
export function pickupArrangementCard(
  app: Application,
  moveout: Moveout,
  timeslot: Timeslot,
  validSlotsForReschedule: Timeslot[],
  pending: PendingRescheduleView | undefined,
  viewerRole: "creator" | "claimant",
) {
  const tz = moveout.timezone;
  const canSetDeparture = viewerRole === "claimant";
  // Timeslots already on this page, minus the one currently confirmed — the
  // only thing that can ever be proposed as a new time. Computed once, up
  // front, so the decision "is there anything to propose?" and the options
  // actually offered can never disagree (previously the form rendered
  // whenever `validSlotsForReschedule` was non-empty even if the only entry
  // *was* the current slot, producing a technically-visible but
  // zero-option `<select>`).
  const otherSlots = validSlotsForReschedule.filter((s) => s.id !== timeslot.id);
  return html`
    <div class="pickup-card" data-application-id="${app.id}" data-application-status="${app.status}" data-departure-status="${app.departure_status}">
      <div data-pickup-facts>
        <p class="item-meta"><strong>Confirmed pickup time:</strong> ${slotRange(timeslot, tz)}</p>
        <p class="item-meta" data-pickup-spot><strong>Pickup location:</strong> ${moveout.pickup_location}</p>
        <p class="item-meta" data-departure-status-text>
          <strong>${viewerRole === "creator" ? "Their" : "Your"} travel status:</strong>
          ${departureStatusLabel(app.departure_status)}
        </p>
        ${canSetDeparture
          ? html`
              <div class="departure-controls" role="group" aria-label="Your travel status">
                ${(["not_departed", "departed", "arrived"] as const).map(
                  (value) => html`
                    <form method="post" action="/applications/${app.id}/departure" class="inline-form" data-ajax>
                      <input type="hidden" name="status" value="${value}" />
                      <button type="submit" ${app.departure_status === value ? "disabled" : ""}>
                        ${departureStatusLabel(value)}
                      </button>
                    </form>
                  `,
                )}
              </div>
            `
          : ""}
      </div>

      <div data-reschedule-area>
        ${pending
          ? html`
              <div class="reschedule-pending" data-reschedule-id="${pending.proposal.id}">
                <p class="item-meta">
                  <strong>Reschedule proposed${pending.proposedByCreator === (viewerRole === "creator") ? " by you" : ""}:</strong>
                  from ${slotRange(timeslot, tz)} to ${slotRange(pending.newTimeslot, tz)}
                  ${pending.proposal.reason ? html` — "${pending.proposal.reason}"` : ""}
                </p>
                <p class="muted">Waiting for the other party to agree — the original pickup time is still in effect until then.</p>
                ${pending.proposedByCreator === (viewerRole === "creator")
                  ? html`
                      <form method="post" action="/reschedule/${pending.proposal.id}/withdraw" class="inline-form" data-ajax>
                        <button type="submit">Withdraw proposal</button>
                      </form>
                    `
                  : html`
                      <form method="post" action="/reschedule/${pending.proposal.id}/accept" class="inline-form" data-ajax>
                        <button type="submit" class="primary">Accept new time</button>
                      </form>
                      <form method="post" action="/reschedule/${pending.proposal.id}/decline" class="inline-form" data-ajax>
                        <button type="submit">Decline</button>
                      </form>
                    `}
              </div>
            `
          : otherSlots.length > 0
            ? html`
                <details class="edit-details">
                  <summary>Propose a different pickup time</summary>
                  <form method="post" action="/applications/${app.id}/reschedule" class="stacked-form" data-ajax>
                    <div class="field">
                      <label for="reschedule-slot-${app.id}">New time</label>
                      <select id="reschedule-slot-${app.id}" name="newTimeslotId" required>
                        ${otherSlots.map((slot) => html`<option value="${slot.id}">${slotRange(slot, tz)}</option>`)}
                      </select>
                    </div>
                    <div class="field">
                      <label for="reschedule-reason-${app.id}">Reason (optional)</label>
                      <input id="reschedule-reason-${app.id}" name="reason" maxlength="200" />
                    </div>
                    <button type="submit">Propose this time</button>
                  </form>
                </details>
              `
            : html`<p class="muted">${viewerRole === "creator" ? "No other pickup time is available to offer yet — add one above." : "No other pickup time is available to propose yet."}</p>`}
      </div>
    </div>
  `;
}
