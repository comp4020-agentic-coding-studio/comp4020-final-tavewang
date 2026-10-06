import type { Application, Item } from "../db.ts";

// Status is always rendered as text (never colour alone) — these are the
// canonical labels used everywhere an item or application appears.

export function itemStatusLabel(status: Item["status"]): string {
  switch (status) {
    case "open":
      return "Available";
    case "reserved":
      return "Reserved";
    case "handed_over":
      return "Handed over";
    case "withdrawn":
      return "Withdrawn";
  }
}

// The label a CLAIMANT sees for their own application — distinct from the
// item's public status, so "pending" never reads as "you're set."
export function applicationStatusLabel(app: Application): string {
  switch (app.status) {
    case "pending":
      return "Waiting for confirmation";
    case "confirmed":
      return "Confirmed — pickup details below";
    case "cancelled":
      return app.cancel_reason ? `Cancelled by the mover: ${app.cancel_reason}` : "You cancelled this request";
    case "completed":
      return "Picked up";
  }
}

export function toneFor(status: Item["status"] | Application["status"]): string {
  if (status === "open" || status === "pending") return "pending";
  if (status === "reserved" || status === "confirmed") return "active";
  if (status === "handed_over" || status === "completed") return "done";
  return "closed"; // withdrawn / cancelled
}
