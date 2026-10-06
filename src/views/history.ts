import { html } from "hono/html";
import { layout } from "./layout.ts";
import type { Fridge, Item, Member } from "../db.ts";

function nickOf(members: Map<string, Member>, id: string | null): string {
  return id ? (members.get(id)?.nickname ?? "a former member") : "—";
}

export async function historyView(fridge: Fridge, items: Item[], members: Map<string, Member>): Promise<string> {
  const body = html`
    <h1>${fridge.name}</h1>
    <nav class="tabs">
      <a class="tab" href="/f/${fridge.id}">Current</a>
      <span class="tab active">History</span>
    </nav>

    <section>
      <h2>Used</h2>
      ${items.length === 0
        ? html`<p class="empty">Nothing used yet.</p>`
        : html`<table class="history-table">
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Owner</th>
                <th scope="col">Claimed by</th>
                <th scope="col">Used</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(
                (item) => html`
                  <tr>
                    <td>${item.name}${item.quantity ? html` <span class="muted">(${item.quantity})</span>` : ""}</td>
                    <td>${nickOf(members, item.owner_member_id)}</td>
                    <td>${nickOf(members, item.claimed_by_member_id)}</td>
                    <td>${item.used_at ?? ""} by ${nickOf(members, item.used_by_member_id)}</td>
                  </tr>
                `,
              )}
            </tbody>
          </table>`}
    </section>
  `;
  return layout(`${fridge.name} · history`, body);
}
