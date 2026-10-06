import { html } from "hono/html";
import { layout } from "./layout.ts";
import { describeItemStatus } from "./item-status.ts";
import type { Fridge, Item, Member } from "../db.ts";

function formatUseBy(useBy: string | null): string {
  return useBy ? `Best used by ${useBy}` : "No use-by date set";
}

function itemActions(item: Item, member: Member) {
  const isOwner = item.owner_member_id === member.id;
  const isClaimant = item.claimed_by_member_id === member.id;

  if (item.status === "claimed" && isClaimant) {
    return html`
      <form method="post" action="/items/${item.id}/unclaim" class="inline-form">
        <button type="submit">Give it back</button>
      </form>
      <form method="post" action="/items/${item.id}/use" class="inline-form">
        <button type="submit" class="primary">Mark used</button>
      </form>
    `;
  }

  if (item.status === "claimed") {
    return html``; // someone else's claim — nothing for this viewer to do
  }

  // status === "kept" from here on
  if (isOwner) {
    return html`
      <details class="edit-details">
        <summary>Edit</summary>
        <form method="post" action="/items/${item.id}/edit" class="stacked-form">
          <div class="field">
            <label for="name-${item.id}">Name</label>
            <input id="name-${item.id}" name="name" required maxlength="80" value="${item.name}" />
          </div>
          <div class="field">
            <label for="quantity-${item.id}">Quantity</label>
            <input id="quantity-${item.id}" name="quantity" maxlength="40" value="${item.quantity ?? ""}" placeholder="e.g. half a bag" />
          </div>
          <div class="field">
            <label for="useBy-${item.id}">Hoping to use by</label>
            <input id="useBy-${item.id}" name="useBy" type="date" value="${item.use_by ?? ""}" />
          </div>
          <button type="submit">Save changes</button>
        </form>
      </details>
      <form method="post" action="/items/${item.id}/share" class="inline-form">
        <input type="hidden" name="shared" value="${item.shared ? "0" : "1"}" />
        <button type="submit">${item.shared ? "Stop sharing" : "Share this"}</button>
      </form>
      <form method="post" action="/items/${item.id}/use" class="inline-form">
        <button type="submit">Mark used</button>
      </form>
    `;
  }

  if (item.shared) {
    return html`
      <form method="post" action="/items/${item.id}/claim" class="inline-form">
        <button type="submit" class="primary">Claim it</button>
      </form>
    `;
  }

  return html``; // someone else's item, not shared — nothing to do
}

function itemRow(item: Item, member: Member, members: Map<string, Member>) {
  const status = describeItemStatus(item, member.id, members);
  return html`
    <li class="item-card tone-${status.tone}">
      <div class="item-main">
        <p class="item-name">${item.name}</p>
        <p class="item-meta">
          ${item.quantity ? html`${item.quantity} · ` : ""}${formatUseBy(item.use_by)}
        </p>
        <p class="item-badge">${status.label}</p>
      </div>
      <div class="item-actions">${itemActions(item, member)}</div>
    </li>
  `;
}

export async function fridgeView(
  fridge: Fridge,
  member: Member,
  items: Item[],
  members: Map<string, Member>,
  inviteUrl: string,
): Promise<string> {
  const body = html`
    <h1>${fridge.name}</h1>
    <nav class="tabs">
      <span class="tab active">Current</span>
      <a class="tab" href="/f/${fridge.id}/history">History</a>
    </nav>

    <section class="invite-box">
      <h2>Invite a housemate</h2>
      <p>Anyone with this link can join as a member of this fridge.</p>
      <div class="invite-row">
        <input id="inviteLink" type="text" readonly value="${inviteUrl}" onclick="this.select()" />
        <button type="button" data-copy="#inviteLink">Copy</button>
      </div>
    </section>

    <section>
      <h2>Add something to the fridge</h2>
      <form method="post" action="/f/${fridge.id}/items" class="stacked-form">
        <div class="field">
          <label for="itemName">Name</label>
          <input id="itemName" name="name" required maxlength="80" placeholder="e.g. Milk" />
        </div>
        <div class="field">
          <label for="itemQuantity">Quantity (optional)</label>
          <input id="itemQuantity" name="quantity" maxlength="40" placeholder="e.g. half a bag" />
        </div>
        <div class="field">
          <label for="itemUseBy">Hoping to use by (optional)</label>
          <input id="itemUseBy" name="useBy" type="date" />
        </div>
        <div class="field checkbox-field">
          <input id="itemShared" name="shared" type="checkbox" value="1" />
          <label for="itemShared">Anyone can claim this</label>
        </div>
        <button type="submit">Add to fridge</button>
      </form>
    </section>

    <section>
      <h2>Current items</h2>
      ${items.length === 0
        ? html`<p class="empty">Nothing in the fridge yet — add the first thing above.</p>`
        : html`<ul class="item-list">
            ${items.map((item) => itemRow(item, member, members))}
          </ul>`}
    </section>

    <script>
      // Progressive enhancement only: the link is plain, selectable text
      // above even if this never runs.
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
  return layout(fridge.name, body);
}

export async function notAMemberView(fridge: Fridge): Promise<string> {
  const body = html`
    <h1>${fridge.name}</h1>
    <p>You're not a member of this fridge yet. Ask a housemate for the invite link.</p>
    <p><a href="/">Go home</a></p>
  `;
  return layout("Not a member", body);
}
