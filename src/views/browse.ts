import { html } from "hono/html";
import { layout } from "./layout.ts";
import { formatInZone } from "../tz.ts";
import { ITEM_CATEGORIES, type ItemCategory } from "../db.ts";
import type { BrowseItemRow, BrowseSort } from "../ownership.ts";

export interface BrowseState {
  search: string;
  category: ItemCategory | "";
  sort: BrowseSort;
}

// A neutral, inline placeholder for an item with no uploaded photo — never a
// stand-in for a real possession (CLAUDE.md: generated art is for brand/
// explanatory use only, never presented as an actual listing's photo). Plain
// SVG, no network request, themed by currentColor so dark mode is free.
const PLACEHOLDER_PHOTO = html`<svg class="item-photo placeholder-photo" viewBox="0 0 160 120" role="img" aria-label="No photo provided" xmlns="http://www.w3.org/2000/svg">
  <rect width="160" height="120" rx="10" fill="currentColor" opacity="0.08" />
  <path d="M40 82 L66 54 L84 72 L104 48 L124 82 Z" fill="currentColor" opacity="0.22" />
  <circle cx="54" cy="42" r="9" fill="currentColor" opacity="0.22" />
</svg>`;

function daysUntil(deadlineAt: string): string {
  const ms = new Date(deadlineAt).getTime() - Date.now();
  const days = Math.max(0, Math.ceil(ms / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return `in ${days} days`;
}

function browseCard(item: BrowseItemRow) {
  return html`
    <li class="browse-card" data-item-id="${item.id}" data-item-status="${item.status}">
      <a class="browse-card-link" href="/m/${item.moveout_id}#item-${item.id}">
        ${item.photo_path ? html`<img class="item-photo" src="/${item.photo_path}" alt="" loading="lazy" />` : PLACEHOLDER_PHOTO}
        <div class="browse-card-body">
          <span class="category-chip">${item.category}</span>
          <p class="item-name">${item.name}</p>
          <p class="item-meta">${item.moveout_area}</p>
          <p class="item-badge tone-pending">Available</p>
          <p class="item-meta muted">Pickup deadline: ${daysUntil(item.moveout_deadline_at)}</p>
        </div>
      </a>
    </li>
  `;
}

function emptyState(hasFilters: boolean) {
  return html`
    <li class="empty-state" data-placeholder>
      <svg class="empty-illustration" viewBox="0 0 200 140" role="presentation" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
        <rect x="20" y="60" width="160" height="60" rx="12" fill="currentColor" opacity="0.08" />
        <rect x="40" y="40" width="60" height="40" rx="8" fill="currentColor" opacity="0.16" />
        <circle cx="150" cy="50" r="22" fill="currentColor" opacity="0.12" />
        <path d="M138 50 L148 60 L164 40" stroke="currentColor" stroke-width="4" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.4" />
      </svg>
      <p>${hasFilters ? "No items match your search — try clearing a filter." : "Nothing public is up for grabs right now — check back soon."}</p>
    </li>
  `;
}

export async function browseView(
  items: BrowseItemRow[],
  total: number,
  state: BrowseState,
): Promise<string> {
  const hasFilters = Boolean(state.search || state.category);
  const body = html`
    <h1>Browse</h1>
    <p id="connection-status" class="conn-status" role="status" aria-live="polite" hidden></p>
    <p class="lede">
      Free things other students are giving away before they move out. Find
      something you need, request it, and arrange a pickup time with the mover.
    </p>

    <form method="get" action="/" class="browse-form" id="browseForm">
      <div class="browse-search-row">
        <label class="visually-hidden" for="browseSearch">Search items</label>
        <input
          id="browseSearch"
          name="q"
          type="search"
          value="${state.search}"
          placeholder="Search for a desk, a kettle, textbooks…"
          autocomplete="off"
        />
        <button type="submit">Search</button>
      </div>
      <div class="browse-filter-row">
        <label class="visually-hidden" for="browseCategory">Category</label>
        <select id="browseCategory" name="category">
          <option value="">All categories</option>
          ${ITEM_CATEGORIES.map(
            (cat) => html`<option value="${cat}" ${cat === state.category ? "selected" : ""}>${cat}</option>`,
          )}
        </select>
        <label class="visually-hidden" for="browseSort">Sort by</label>
        <select id="browseSort" name="sort">
          <option value="newest" ${state.sort === "newest" ? "selected" : ""}>Newest first</option>
          <option value="deadline" ${state.sort === "deadline" ? "selected" : ""}>Soonest deadline first</option>
        </select>
        ${hasFilters ? html`<a class="muted-link" href="/">Clear filters</a>` : ""}
      </div>
    </form>

    <p class="muted browse-count" data-browse-count>
      ${total === 0
        ? "No items found."
        : items.length < total
          ? `Showing the newest ${items.length} of ${total} items — narrow your search to see more.`
          : `${total} item${total === 1 ? "" : "s"} found.`}
    </p>

    <ul class="browse-grid" data-live-list="browse-items">
      ${items.length === 0 ? emptyState(hasFilters) : items.map(browseCard)}
    </ul>

    <p class="muted browse-post-cta">
      Moving out and giving things away?
      <a href="/mine">Post your items</a>
      — they'll appear here once you mark the page Public.
    </p>

    <script src="/live.js" data-live="/browse/events"></script>
  `;
  return layout("Browse", body);
}
