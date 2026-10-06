import type { Item, Member } from "../db.ts";

export interface ItemStatusInfo {
  label: string;
  tone: "kept" | "shareable" | "claimed" | "used";
}

// Status is always shown as text, never colour alone (phone screens, colour
// vision, printouts of the crit room's projector all have reasons not to
// trust colour). `tone` only selects a badge style on top of that text.
export function describeItemStatus(item: Item, viewerMemberId: string, members: Map<string, Member>): ItemStatusInfo {
  const nickOf = (id: string | null): string => (id ? (members.get(id)?.nickname ?? "a former member") : "nobody");

  if (item.status === "used") {
    return { label: "Used", tone: "used" };
  }
  if (item.status === "claimed") {
    const isViewer = item.claimed_by_member_id === viewerMemberId;
    return { label: isViewer ? "Claimed by you" : `Claimed by ${nickOf(item.claimed_by_member_id)}`, tone: "claimed" };
  }
  const isOwner = item.owner_member_id === viewerMemberId;
  if (item.shared) {
    return { label: isOwner ? "Yours · shareable" : "Shareable", tone: "shareable" };
  }
  return { label: isOwner ? "Yours" : `Kept by ${nickOf(item.owner_member_id)}`, tone: "kept" };
}
