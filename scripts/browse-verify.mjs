#!/usr/bin/env node
// Manual, browser-level verification for Crit 11's public browse pool. Not
// part of `pnpm check` on purpose (same reasoning as scripts/browser-verify.mjs):
// starts its own server on an isolated throwaway DATA_DIR, drives two
// independent browser identities (two Playwright *contexts*) with real
// Chrome, and walks the actual new-user path the brief asks for: /readme/ ->
// Browse -> an item's page -> apply -> confirm -> pickup info, with zero
// prior visits to the move-out page's own URL. spec/browse.test.ts covers
// the mechanical, HTTP-visible half (what the server returns to a bare
// client); this script covers what that produces in a rendered page.
//
// Usage: node scripts/browse-verify.mjs
// Requires the same system Chrome as scripts/browser-verify.mjs.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8124;
const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-browse-verify-"));
const TIMEZONE = "Australia/Sydney";

let passCount = 0;
let failCount = 0;
const failures = [];
function check(label, ok, detail) {
  if (ok) {
    passCount++;
    console.log(`  ✓ ${label}`);
  } else {
    failCount++;
    failures.push(label);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function futureLocalDateTime(hoursFromNow, timeZone = TIMEZONE) {
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
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function startServer(env) {
  return spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer() {
  for (let i = 0; i < 150; i++) {
    try {
      const res = await fetch(BASE_URL);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server never answered at ${BASE_URL}`);
}

function stopServer(proc) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) return resolve();
    proc.once("exit", resolve);
    proc.kill("SIGTERM");
  });
}

async function waitFor(predicate, { timeout = 3000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function main() {
  console.log(`Data dir: ${dataDir}`);
  let server = null;
  let browser = null;
  try {
    server = startServer({});
    await waitForServer();
    browser = await chromium.launch({ channel: "chrome" });

    // ---- setup: a mover posts a public item, never visited directly by bob
    const mover = await (await browser.newContext()).newPage();
    await mover.goto(`${BASE_URL}/mine`);
    await mover.fill("#title", "Browse-verify move-out");
    await mover.fill("#area", "Test Hall");
    await mover.fill("#pickupLocation", "Browse Verify Secret Door");
    await mover.fill("#deadline", futureLocalDateTime(72));
    await mover.fill("#timezone", TIMEZONE);
    await mover.fill("#nickname", "Mover");
    await mover.check('input[name="visibility"][value="public"]');
    await mover.click('button[type="submit"]');
    await mover.waitForURL(/\/manage$/);
    const manageUrl = mover.url();

    await mover.fill("#slotStart", futureLocalDateTime(2));
    await mover.fill("#slotEnd", futureLocalDateTime(3));
    await mover.click('form[action$="/timeslots"] button[type="submit"]');
    await waitFor(() => mover.locator(".muted", { hasText: "Current times:" }).isVisible().catch(() => false));

    await mover.fill("#itemName", "Browse Verify Desk");
    await mover.selectOption("#itemCategory", "Furniture");
    await mover.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => mover.locator('li[data-item-id]:has-text("Browse Verify Desk")').isVisible().catch(() => false));

    // ---- 1: enter from /readme/ -> Browse -> item page, two FRESH contexts,
    //        neither of which has ever opened the move-out's own URL directly
    console.log("\n[test 1] bob discovers the item from /readme/ -> Browse -> item page, having never visited the move-out URL");
    const bob = await (await browser.newContext()).newPage();
    await bob.goto(`${BASE_URL}/readme/`);
    await bob.click("text=Enter MoveOut");
    await bob.waitForURL(`${BASE_URL}/`);
    check("landed on Browse (the public pool), not a login or management view", bob.url() === `${BASE_URL}/`);

    await bob.fill("#browseSearch", "Browse Verify Desk");
    await bob.click('.browse-search-row button[type="submit"]');
    await bob.waitForLoadState();
    const cardLink = bob.locator('.browse-card:has-text("Browse Verify Desk") a');
    check("the search finds the card in Browse", await cardLink.isVisible().catch(() => false));
    check("the card shows its category", await bob.locator(".category-chip", { hasText: "Furniture" }).isVisible().catch(() => false));

    await cardLink.click();
    await bob.waitForURL(/\/m\/.+#item-/);
    check("clicking the card lands on the move-out page, scrolled to that item", bob.url().includes("#item-"));

    // ---- 2: apply from there, as a visitor who arrived via Browse
    console.log("\n[test 2] bob applies for the item from the page Browse sent him to");
    const itemCard = bob.locator('li.item-card:has-text("Browse Verify Desk")');
    await itemCard.locator("summary").click();
    await itemCard.locator('input[name="nickname"]').fill("Bob via Browse");
    await itemCard.locator('select[name="timeslotId"]').selectOption({ index: 0 });
    await itemCard.locator('button[type="submit"]').click();
    await bob.waitForURL(/\/m\//);
    const applyAccepted = await waitFor(
      () => bob.locator("text=Waiting for confirmation").isVisible().catch(() => false),
      { timeout: 2000 },
    );
    check("bob's request was accepted", applyAccepted);

    // ---- 3: mover confirms, bob gets the pickup address, item leaves the pool
    console.log("\n[test 3] mover confirms -> bob sees the pickup spot; the item drops out of Browse");
    await mover.goto(manageUrl);
    await mover.locator('li[data-item-id]:has-text("Browse Verify Desk") form[action*="/confirm"] button').click();
    const bobSeesAddress = await waitFor(
      () => bob.locator("text=Browse Verify Secret Door").isVisible().catch(() => false),
      { timeout: 3000 },
    );
    check("bob's page reveals the pickup address once confirmed", bobSeesAddress);

    const watcher = await (await browser.newContext()).newPage();
    await watcher.goto(`${BASE_URL}/`);
    const itemGoneFromPool = await waitFor(
      () => watcher.locator("text=Browse Verify Desk").isVisible().then((v) => !v),
      { timeout: 3000 },
    );
    check("the now-reserved item disappears from an already-open Browse tab without a reload", itemGoneFromPool);

    // ---- 4: visibility flip propagates live to an open Browse tab ----------
    console.log("\n[test 4] mover posts a second, unlisted-then-flipped item; Browse updates live on the visibility change");
    await mover.goto(manageUrl);
    await mover.fill("#itemName", "Visibility Flip Item");
    await mover.selectOption("#itemCategory", "Other");
    await mover.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => mover.locator('li[data-item-id]:has-text("Visibility Flip Item")').isVisible().catch(() => false));

    await mover.locator('form[action*="/visibility"] button').click(); // public -> unlisted
    await watcher.goto(`${BASE_URL}/`);
    const absentWhileUnlisted = !(await watcher.locator("text=Visibility Flip Item").isVisible().catch(() => false));
    check("an unlisted item never appears in an already-open Browse tab", absentWhileUnlisted);

    await mover.locator('form[action*="/visibility"] button').click(); // unlisted -> public
    const appearedLive = await waitFor(
      () => watcher.locator("text=Visibility Flip Item").isVisible().catch(() => false),
      { timeout: 3000 },
    );
    check("flipping back to public adds the item to an already-open Browse tab live, no reload", appearedLive);

    // ---- 5: a draft in the search box survives an unrelated pool update ----
    console.log("\n[test 5] an in-progress search draft survives an unrelated live pool update");
    const draftWatcher = await (await browser.newContext()).newPage();
    await draftWatcher.goto(`${BASE_URL}/`);
    await draftWatcher.fill("#browseSearch", "unsent draft text");
    await mover.fill("#itemName", "Unrelated Trigger Item");
    await mover.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => mover.locator('li[data-item-id]:has-text("Unrelated Trigger Item")').isVisible().catch(() => false));
    await draftWatcher.waitForTimeout(1200);
    const draftValue = await draftWatcher.inputValue("#browseSearch");
    check("the unsent search draft is untouched by the live pool update", draftValue === "unsent draft text", `got "${draftValue}"`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    await stopServer(server);
    rmSync(dataDir, { recursive: true, force: true });
  }

  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (failures.length > 0) {
    console.log("Failed checks:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
