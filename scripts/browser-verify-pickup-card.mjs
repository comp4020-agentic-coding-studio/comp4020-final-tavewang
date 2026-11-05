#!/usr/bin/env node
// Manual, browser-level verification for the pickup-arrangement card
// (src/views/pickup-card.ts, src/public/live.js#syncPickupCard). Not part of
// `pnpm check` on purpose (same reasoning as scripts/browser-verify.mjs):
// starts its own server on an isolated throwaway DATA_DIR and drives two
// independent browser identities (two Playwright *contexts*) with real
// Chrome, checking things spec/reschedule.test.ts's HTTP-only tests
// fundamentally cannot see — a draft surviving in the live DOM, a stale
// control actually being disabled, an empty-looking page never existing in
// the first place.
//
// Usage: node scripts/browser-verify-pickup-card.mjs
// Requires the same system Chrome as scripts/browser-verify.mjs.
//
// Written after two real bugs were found this way (not by code review
// alone — both were *reproduced* against a running server before being
// fixed, and this script is that reproduction made permanent):
//
//  1. syncPickupCard used to treat the whole `.pickup-card` as one
//     protected-or-not unit. A claimant with an open "propose a different
//     pickup time" draft (reason text typed, nothing submitted yet) had
//     their ENTIRE card frozen — including the read-only confirmed
//     time/location/travel-status facts, and any new reschedule proposal
//     the other party sent in the meantime, which the draft-holder would
//     never see arrive. Fixed by splitting the card into
//     `[data-pickup-facts]` (always safe to refresh — never a draft) and
//     `[data-reschedule-area]` (only skipped, with an explicit stale note
//     left in place, when ITS OWN open form holds a draft).
//  2. The "cancelled/completed disables stale controls" pass
//     (syncApplicationStatus) only knew about /cancel and /timeslot forms
//     from crit 9, so a claimant with an open reschedule draft whose
//     booking got cancelled kept fully-enabled departure-status buttons and
//     a reschedule-propose submit button that would 409 if ever clicked —
//     visually still "live", not actually acting on anything real anymore.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8125;
const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-pickup-card-verify-"));
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

// Mirrors spec/helpers.ts#futureLocalDateTime — a `datetime-local` value is
// entered as a wall-clock time in the move-out's own declared timezone
// (src/tz.ts), not the machine's local time or bare UTC.
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

async function waitFor(predicate, { timeout = 5000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// --- Shared setup helpers, used by every scenario below -------------------

async function createMoveoutPage(page, { title, pickupLocation, nickname }) {
  await page.goto(`${BASE_URL}/mine`);
  await page.fill("#title", title);
  await page.fill("#area", "Test Hall");
  await page.fill("#pickupLocation", pickupLocation);
  await page.fill("#deadline", futureLocalDateTime(72));
  await page.fill("#timezone", TIMEZONE);
  await page.fill("#nickname", nickname);
  await page.locator('form[action="/moveouts"] button[type="submit"]').click({ force: true });
  await page.waitForURL(/\/manage$/);
  return page.url();
}

async function addTimeslot(page, startHours, endHours) {
  await page.fill("#slotStart", futureLocalDateTime(startHours));
  await page.fill("#slotEnd", futureLocalDateTime(endHours));
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/timeslots") && r.request().method() === "POST"),
    page.locator('form[action*="/timeslots"] button[type="submit"]').click({ force: true }),
  ]);
  if (resp.status() >= 400) throw new Error(`add-timeslot failed: ${resp.status()}`);
  await page.waitForLoadState("networkidle");
}

async function addItem(page, name) {
  await page.fill("#itemName", name);
  await page.selectOption("#itemCategory", "Furniture");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/items") && r.request().method() === "POST"),
    page.locator('form[action*="/items"] button[type="submit"]').click({ force: true }),
  ]);
  if (resp.status() >= 400) throw new Error(`add-item failed: ${resp.status()}`);
  await page.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 5000 });
}

async function apply(page, moveoutUrl, nickname) {
  await page.goto(moveoutUrl.replace("/manage", ""));
  await page.locator('summary:has-text("Request this")').click({ force: true });
  await page.fill('input[name="nickname"]', nickname);
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/apply") && r.request().method() === "POST"),
    page.locator('form[action*="/apply"] button[type="submit"]').click({ force: true }),
  ]);
  if (resp.status() >= 400) throw new Error(`apply failed: ${resp.status()}`);
  await page.waitForLoadState("networkidle");
}

async function confirmFirstPending(page, moveoutUrl) {
  await page.goto(moveoutUrl);
  await page.waitForLoadState("networkidle");
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes("/confirm") && r.request().method() === "POST"),
    page.locator('form[action*="/confirm"] button[type="submit"]').first().click({ force: true }),
  ]);
  if (resp.status() >= 400) throw new Error(`confirm failed: ${resp.status()}`);
  await page.waitForLoadState("networkidle");
}

async function main() {
  console.log(`Data dir: ${dataDir}`);
  let server = null;
  let browser = null;
  try {
    server = startServer({});
    await waitForServer();
    browser = await chromium.launch({ channel: "chrome" });

    // ---- Scenario 1: an open reschedule draft no longer blocks the OTHER
    //      party's incoming proposal, and the draft itself survives --------
    console.log("\n[scenario 1] claimant has an open reschedule draft; creator proposes a reschedule meanwhile");
    {
      const ownerCtx = await browser.newContext();
      const claimantCtx = await browser.newContext();
      const owner = await ownerCtx.newPage();
      const claimant = await claimantCtx.newPage();

      const manageUrl = await createMoveoutPage(owner, { title: "Scenario1", pickupLocation: "Door 1", nickname: "Owner" });
      await addTimeslot(owner, 2, 3);
      await addTimeslot(owner, 5, 6);
      await addItem(owner, "Lamp");
      await apply(claimant, manageUrl, "Claimant");
      await confirmFirstPending(owner, manageUrl);

      const pickupCardShown = await waitFor(() => claimant.locator(".pickup-card").isVisible().catch(() => false));
      check("setup: claimant sees the confirmed pickup card", pickupCardShown);

      await claimant.locator('summary:has-text("Propose a different pickup time")').click({ force: true });
      await claimant.locator('input[id^="reschedule-reason-"]').click();
      await claimant.locator('input[id^="reschedule-reason-"]').type("still deciding, don't lose me", { delay: 15 });

      // An UNRELATED structural change elsewhere on the page (a new
      // timeslot) must still reach the claimant, since nothing about THIS
      // change touches their draft.
      await addTimeslot(owner, 8, 9);
      await new Promise((r) => setTimeout(r, 500));
      const draftSurvivedUnrelatedChange =
        (await claimant.locator('input[id^="reschedule-reason-"]').inputValue()) === "still deciding, don't lose me";
      check("an unrelated page change does not clear the claimant's draft", draftSurvivedUnrelatedChange);

      // The REAL regression: owner proposes a reschedule — a change TO the
      // very card the claimant has an open draft inside.
      await owner.goto(manageUrl);
      await owner.waitForLoadState("networkidle");
      await owner.locator('summary:has-text("Propose a different pickup time")').click({ force: true });
      await owner.locator('select[id^="reschedule-slot-"]').waitFor({ state: "visible" });
      await owner.locator('select[id^="reschedule-slot-"]').selectOption({ index: 0 });
      const [proposeResp] = await Promise.all([
        owner.waitForResponse((r) => r.url().includes("/reschedule") && r.request().method() === "POST"),
        owner.evaluate(() => document.querySelector('form[action*="/reschedule"]').requestSubmit()),
      ]);
      if (proposeResp.status() >= 400) throw new Error(`owner propose failed: ${proposeResp.status()}`);
      await owner.waitForLoadState("networkidle");

      await new Promise((r) => setTimeout(r, 800));
      const draftStillIntact =
        (await claimant.locator('input[id^="reschedule-reason-"]').inputValue()) === "still deciding, don't lose me";
      check("bug fix 1a: the claimant's own draft is still intact after the OTHER party's reschedule proposal arrives", draftStillIntact);
      const staleNoteShown = await claimant.locator("[data-reschedule-area] [data-live-note]").isVisible().catch(() => false);
      check("bug fix 1a: a visible notice explains the arrangement changed, rather than silently hiding the update", staleNoteShown);

      // Closing the draft (abandoning it) should then reveal the real
      // pending proposal, the same "finish editing, then catch up" pattern
      // every other protected entity in this app already uses.
      await claimant.locator('input[id^="reschedule-reason-"]').fill("");
      await claimant.locator('details:has(input[id^="reschedule-reason-"]) summary').click({ force: true });
      await claimant.locator("body").click();
      const proposalRevealed = await waitFor(
        () => claimant.locator(".reschedule-pending").isVisible().catch(() => false),
        { timeout: 3000 },
      );
      check("bug fix 1a: abandoning the draft reveals the real pending proposal (catch-up reconcile)", proposalRevealed);

      // ---- Scenario 1b (no draft open at all): must update live, no delay
      console.log("\n[scenario 1b] no draft open — a reschedule proposal from the other side shows up live");
      await claimant.locator('form[action*="/decline"] button[type="submit"]').click({ force: true }).catch(() => {});
      await claimant.waitForLoadState("networkidle");
      await owner.goto(manageUrl);
      await owner.waitForLoadState("networkidle");
      await owner.locator('summary:has-text("Propose a different pickup time")').click({ force: true });
      await owner.locator('select[id^="reschedule-slot-"]').waitFor({ state: "visible" });
      await owner.locator('select[id^="reschedule-slot-"]').selectOption({ index: 0 });
      const [proposeResp2] = await Promise.all([
        owner.waitForResponse((r) => r.url().includes("/reschedule") && r.request().method() === "POST"),
        owner.evaluate(() => document.querySelector('form[action*="/reschedule"]').requestSubmit()),
      ]);
      if (proposeResp2.status() < 400) {
        const shownLive = await waitFor(
          () => claimant.locator(".reschedule-pending").isVisible().catch(() => false),
          { timeout: 3000 },
        );
        check("with no draft open, a new proposal shows up live with no reload", shownLive);
      } else {
        check("with no draft open, a new proposal shows up live with no reload", false, `setup propose failed: ${proposeResp2.status()}`);
      }
    }

    // ---- Scenario 2: cancelling while a draft is open disables stale
    //      controls, not just the terminal status badge -------------------
    console.log("\n[scenario 2] creator cancels a confirmed booking while the claimant's reschedule draft is open");
    {
      const ownerCtx = await browser.newContext();
      const claimantCtx = await browser.newContext();
      const owner = await ownerCtx.newPage();
      const claimant = await claimantCtx.newPage();

      const manageUrl = await createMoveoutPage(owner, { title: "Scenario2", pickupLocation: "Door 2", nickname: "Owner" });
      await addTimeslot(owner, 2, 3);
      await addTimeslot(owner, 5, 6);
      await addItem(owner, "Lamp");
      await apply(claimant, manageUrl, "Claimant");
      await confirmFirstPending(owner, manageUrl);
      await waitFor(() => claimant.locator(".pickup-card").isVisible().catch(() => false));

      await claimant.locator('summary:has-text("Propose a different pickup time")').click({ force: true });
      await claimant.locator('input[id^="reschedule-reason-"]').click();
      await claimant.locator('input[id^="reschedule-reason-"]').type("still deciding", { delay: 15 });

      await owner.goto(manageUrl);
      await owner.waitForLoadState("networkidle");
      await owner.locator('details:has-text("Cancel")').first().locator("summary").click({ force: true });
      await owner.locator('input[id^="reason-"]').fill("mover needs to cancel");
      const [cancelResp] = await Promise.all([
        owner.waitForResponse((r) => r.url().includes("/cancel") && r.request().method() === "POST"),
        owner.locator('form[action*="/cancel"] button[type="submit"]').click({ force: true }),
      ]);
      if (cancelResp.status() >= 400) throw new Error(`cancel failed: ${cancelResp.status()}`);
      await owner.waitForLoadState("networkidle");

      await new Promise((r) => setTimeout(r, 800));
      const draftKept = (await claimant.locator('input[id^="reschedule-reason-"]').inputValue()) === "still deciding";
      check("bug fix 1b: the claimant's draft text is kept (never silently cleared) after the booking is cancelled", draftKept);
      const departureEnabled = await claimant.locator('form[action*="/departure"] button[type="submit"]:not([disabled])').count();
      check("bug fix 1b: departure-status buttons are disabled once the booking is cancelled, even with a draft open", departureEnabled === 0);
      const rescheduleSubmitEnabled = await claimant.locator('form[action*="/reschedule"] button[type="submit"]:not([disabled])').count();
      check("bug fix 1b: the reschedule-propose submit button is disabled once the booking is cancelled", rescheduleSubmitEnabled === 0);

      // The item should now be open again for a new requester — confirms
      // the fix didn't accidentally touch anything about the actual cancel
      // transition itself, only the client-side staleness handling.
      const freshVisitor = await (await browser.newContext()).newPage();
      await freshVisitor.goto(manageUrl.replace("/manage", ""));
      const itemReopened = await freshVisitor.locator('li.item-card[data-item-status="open"]:has-text("Lamp")').isVisible().catch(() => false);
      check("the item is genuinely reopened after the cancel (not just a client-side illusion)", itemReopened);
    }

    // ---- Scenario 3: no other timeslot exists -> no empty dropdown -------
    console.log("\n[scenario 3] only one timeslot ever exists on the page — no dead-end empty reschedule dropdown");
    {
      const ownerCtx = await browser.newContext();
      const claimantCtx = await browser.newContext();
      const owner = await ownerCtx.newPage();
      const claimant = await claimantCtx.newPage();

      const manageUrl = await createMoveoutPage(owner, { title: "Scenario3", pickupLocation: "Door 3", nickname: "Owner" });
      await addTimeslot(owner, 2, 3); // the ONLY timeslot this page will ever have
      await addItem(owner, "Lamp");
      await apply(claimant, manageUrl, "Claimant");
      await confirmFirstPending(owner, manageUrl);
      await waitFor(() => claimant.locator(".pickup-card").isVisible().catch(() => false));

      const claimantDetailsCount = await claimant.locator('[data-reschedule-area] details.edit-details').count();
      check("claimant's card shows no 'propose a different time' control when none exists", claimantDetailsCount === 0);
      const claimantExplanationShown = await claimant.locator("[data-reschedule-area]", { hasText: "No other pickup time is available" }).isVisible().catch(() => false);
      check("claimant sees a plain-language explanation instead", claimantExplanationShown);

      await owner.goto(manageUrl);
      await owner.waitForLoadState("networkidle");
      const ownerDetailsCount = await owner.locator('[data-reschedule-area] details.edit-details').count();
      check("creator's card shows no 'propose a different time' control either", ownerDetailsCount === 0);
      const ownerExplanationShown = await owner.locator("[data-reschedule-area]", { hasText: "No other pickup time is available" }).isVisible().catch(() => false);
      check("creator sees a plain-language explanation instead", ownerExplanationShown);

      // Adding a second timeslot gives both sides something real to use.
      await addTimeslot(owner, 5, 6);
      const reappeared = await waitFor(
        () => claimant.locator('[data-reschedule-area] details.edit-details').isVisible().catch(() => false),
        { timeout: 3000 },
      );
      check("once a second timeslot exists, the propose-reschedule control appears live with real options", reappeared);
      const optionCount = await claimant.locator('[data-reschedule-area] select[id^="reschedule-slot-"] option').count();
      check("the reappeared dropdown actually has options, not an empty one", optionCount > 0);
    }
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
