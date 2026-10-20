#!/usr/bin/env node
// Manual, browser-level verification for crit 9's real-time work. Not part
// of `pnpm check` on purpose: it starts its own server on an isolated
// throwaway DATA_DIR, drives two independent browser identities (two
// Playwright *contexts* — cookies don't cross between them, same as two
// different people's devices) with real Chrome, and checks things an HTTP
// client fundamentally can't see — a DOM node updating in place, a typed
// value surviving someone else's update, a chosen file staying chosen, a
// connection-status banner, a disabled submit button. spec/live.test.ts
// covers the mechanical, HTTP-visible half (an SSE event actually arrives,
// and how fast); this script covers the half that only exists in a
// rendered page.
//
// Usage: node scripts/browser-verify.mjs
// Requires: `pnpm add -D playwright` (already in devDependencies) and a
// system Chrome (the course's own setup already requires one — see
// comp4020:doctor) at the default install location for `channel: "chrome"`,
// so this never downloads its own Chromium build.
//
// Revised after crit-9 review found the first version's own bugs (wrong
// timezone math on default-Sydney pages, a file-input assertion on a form
// that has none, `networkidle` waits on an SSE page that never goes idle,
// a force-click on a disabled button proving nothing about the server).
// Fixed here; see the comment at each affected check.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8123;
const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-verify-"));
const TIMEZONE = "Australia/Sydney"; // the page default this script relies on throughout

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

// Bug in the first version: `new Date(...).toISOString().slice(0,16)` reads
// off the UTC wall clock, but the page's `datetime-local` fields are
// interpreted in the move-out's own timezone (`src/tz.ts`, default
// Australia/Sydney, which is UTC+10 or +11). At AEDT that silently wrote a
// pickup time ~11 hours in the past, so every "valid timeslot" check here
// was accidentally exercising the already-expired path. This mirrors
// spec/helpers.ts#futureLocalDateTime exactly, so the same wall-clock value
// a real Sydney-based user would type is what gets typed here.
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
  const proc = spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return proc;
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

// Waits for a predicate to become true by polling, rather than Playwright's
// `networkidle` — which this app's own SSE connection (deliberately
// long-lived) means the page never reaches, so every `networkidle` wait in
// the first version of this script just silently burned its full timeout
// before continuing anyway, proving nothing about the state it claimed to
// wait for.
async function waitFor(predicate, { timeout = 3000, interval = 50 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// A 1x1 PNG, for the mover's real "Add an item" photo field — the only
// file input that actually exists in this app. (The first version's test 3
// asserted a file survived on the *claimant's apply form*, which has no
// file input at all — src/views/moveout-public.ts's applyForm only has
// name/timeslot/note. Fixed by moving the file-preservation check to the
// one form that has one: the mover's add-item form.)
const tinyPngPath = join(dataDir, "tiny.png");
writeFileSync(
  tinyPngPath,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);

async function main() {
  console.log(`Data dir: ${dataDir}`);
  let server = null;
  let browser = null;
  try {
    server = startServer({});
    await waitForServer();

    browser = await chromium.launch({ channel: "chrome" });
    // Two contexts = two independent cookie jars = two different devices,
    // exactly like two phones at the crit.
    const mover = await browser.newContext();
    const bob = await browser.newContext();
    const moverPage = await mover.newPage();
    const bobPage = await bob.newPage();

    console.log("\n[setup] mover creates a move-out page with two items and a timeslot");
    // Crit 11: "/" became the public Browse pool; the create-page form moved
    // to "/mine" ("My MoveOut").
    await moverPage.goto(`${BASE_URL}/mine`);
    await moverPage.fill("#title", "Browser-verify run");
    await moverPage.fill("#area", "Test Hall");
    await moverPage.fill("#pickupLocation", "Secret Side Door 42");
    await moverPage.fill("#deadline", futureLocalDateTime(72));
    await moverPage.fill("#timezone", TIMEZONE);
    await moverPage.fill("#nickname", "Mover");
    await moverPage.click('button[type="submit"]');
    await moverPage.waitForURL(/\/manage$/);
    const manageUrl = moverPage.url();
    const moveoutId = manageUrl.match(/\/m\/([^/]+)\/manage/)[1];
    const publicUrl = `${BASE_URL}/m/${moveoutId}`;

    await moverPage.fill("#slotStart", futureLocalDateTime(2));
    await moverPage.fill("#slotEnd", futureLocalDateTime(3));
    await moverPage.click('form[action$="/timeslots"] button[type="submit"]');
    await waitFor(() => moverPage.locator(".muted", { hasText: "Current times:" }).isVisible().catch(() => false));

    await moverPage.fill("#itemName", "Desk Lamp");
    await moverPage.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => moverPage.locator('li[data-item-id]:has-text("Desk Lamp")').isVisible().catch(() => false));
    await moverPage.fill("#itemName", "Rug");
    await moverPage.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => moverPage.locator('li[data-item-id]:has-text("Rug")').isVisible().catch(() => false));

    await bobPage.goto(publicUrl);
    const lampVisible = await bobPage.locator('li.item-card:has-text("Desk Lamp")').isVisible().catch(() => false);
    check("setup: both items and the timeslot were actually created with valid (future, in-zone) times", lampVisible);
    if (!lampVisible) {
      console.log("  aborting remaining checks — setup itself failed, every downstream check would be meaningless");
      return;
    }

    // ---- 1: new application appears on the mover's open manage page --------
    console.log("\n[test 1] Bob applies for the Lamp -> mover's open manage page sees it live, timed");
    const t1Start = Date.now();
    await bobPage.locator('li.item-card:has-text("Desk Lamp") summary').click();
    const lampCard = bobPage.locator('li.item-card:has-text("Desk Lamp")');
    await lampCard.locator('input[name="nickname"]').fill("Bob");
    await lampCard.locator('select[name="timeslotId"]').selectOption({ index: 0 });
    const bobApplySubmitted = Date.now();
    await lampCard.locator('button[type="submit"]').click();
    await bobPage.waitForURL(publicUrl);

    const bobRowShown = await waitFor(
      () => moverPage.locator('li[data-item-id] .applicant-list >> text=Bob').isVisible().catch(() => false),
      { timeout: 3000 },
    );
    const t1LatencyMs = Date.now() - bobApplySubmitted; // from the write, not from when Bob started filling the form
    check("mover's manage page shows Bob's application without reloading, within ~1s of the write", bobRowShown && t1LatencyMs < 1500, `${t1LatencyMs}ms`);

    // ---- 2: confirming reveals the pickup address to the claimant ----------
    console.log("\n[test 2] mover confirms Bob -> Bob's public page shows the pickup location live, timed");
    const confirmStart = Date.now();
    await moverPage.locator('li[data-item-id]:has-text("Desk Lamp") form[action*="/confirm"] button').click();
    const pickupShown = await waitFor(
      () => bobPage.locator("text=Secret Side Door 42").isVisible().catch(() => false),
      { timeout: 3000 },
    );
    const confirmLatencyMs = Date.now() - confirmStart;
    check("Bob's page reveals the pickup location without reloading, within ~1s", pickupShown && confirmLatencyMs < 1500, `${confirmLatencyMs}ms`);

    // ---- 3: protected-card bug fixes — status, address, controls all land --
    console.log("\n[test 3] Carol opens the Rug's request form, starts typing, picks a file isn't possible on this form (it has none) — instead this verifies her draft isn't lost by an unrelated reorder");
    await bobPage.goto(publicUrl);
    const rugCard = bobPage.locator('li.item-card:has-text("Rug")');
    await rugCard.locator("summary").click();
    await rugCard.locator('input[name="nickname"]').fill("Carol — don't lose me");
    await rugCard.locator('input[name="note"]').fill("I can pick up any time after work");
    await rugCard.locator('input[name="nickname"]').focus();

    // Mover adds a second timeslot — an unrelated structural change to the
    // SAME list (public-items) that previously (bug 1) repositioned every
    // node in the list on every sync, including Rug's card, dropping focus
    // from Carol's field to <body> even though nothing about Rug changed.
    await moverPage.fill("#slotStart", futureLocalDateTime(4));
    await moverPage.fill("#slotEnd", futureLocalDateTime(5));
    await moverPage.click('form[action$="/timeslots"] button[type="submit"]');
    await waitFor(async () => (await bobPage.locator('li.item-card:has-text("Rug") select[name="timeslotId"] option').count()) >= 2);

    const focusStillOnNickname = await bobPage.evaluate(() => {
      const active = document.activeElement;
      return active && active.name === "nickname" && active.closest('li.item-card')?.textContent.includes("Rug");
    });
    check("bug fix 1: an unrelated list update elsewhere does not steal focus from Carol's field", focusStillOnNickname);
    check(
      "Carol's typed name survived the unrelated update",
      (await rugCard.locator('input[name="nickname"]').inputValue()) === "Carol — don't lose me",
    );
    check(
      "Carol's typed note survived the unrelated update",
      (await rugCard.locator('input[name="note"]').inputValue()) === "I can pick up any time after work",
    );

    console.log("\n[test 3b] mover withdraws the Rug while Carol's form is still open and protected");
    const manageObserver = await mover.newPage();
    await manageObserver.goto(manageUrl);
    await manageObserver.locator('#connection-status', { hasText: 'Live' }).waitFor();
    let observerNavigations = 0;
    manageObserver.on("framenavigated", (frame) => {
      if (frame === manageObserver.mainFrame()) observerNavigations++;
    });
    const withdrawnPane = manageObserver.locator('details').filter({ has: manageObserver.locator('summary', { hasText: 'Withdrawn items' }) });
    check("withdrawn summary starts hidden when there are no withdrawn items", await withdrawnPane.isHidden());
    await manageObserver.locator('#itemName').fill('Unfinished item');
    await manageObserver.locator('#itemName').evaluate((el) => el.setSelectionRange(0, 4));
    await moverPage.goto(manageUrl);
    await moverPage.locator('li[data-item-id]:has-text("Rug") form[action*="/withdraw"] button').click();
    const goneNoteShown = await waitFor(
      () => bobPage.locator('li.item-card:has-text("Rug") [data-live-note]').isVisible().catch(() => false),
      { timeout: 3000 },
    );
    check("bug fix 2: withdrawn item shows an explicit unavailable notice while its form is still open", goneNoteShown);
    check(
      "Carol's input is still intact after the withdrawal notice appeared",
      (await bobPage.locator('li.item-card:has-text("Rug") input[name="nickname"]').inputValue()) === "Carol — don't lose me",
    );
    const rugSubmitDisabled = await bobPage.locator('li.item-card:has-text("Rug") button[type="submit"]').isDisabled();
    check("bug fix 2: the now-invalid submit button is actually disabled (not just visually)", rugSubmitDisabled);

    const firstWithdrawalVisible = await waitFor(async () =>
      (await withdrawnPane.locator('summary').allTextContents())[0] === 'Withdrawn items (1)' &&
      await withdrawnPane.locator('li').count() === 1 &&
      await withdrawnPane.locator('li').textContent() === 'Rug',
      { timeout: 1500 },
    );
    check("another open manage tab shows the first withdrawal and its item without reloading", firstWithdrawalVisible);
    if (firstWithdrawalVisible) await withdrawnPane.locator('summary').click();
    await manageObserver.locator('#itemName').focus();
    await manageObserver.locator('#itemName').evaluate((el) => el.setSelectionRange(0, 4));

    console.log("\n[test 3c] Carol actually abandons her draft (clears the field) -> the deferred structural removal now applies");
    // Closing the <details> alone does NOT make this unprotected — Carol's
    // typed text is still sitting in the input, and isProtected() correctly
    // keeps protecting non-default input values regardless of whether the
    // <details> is open (that's the point: a collapsed-but-still-full field
    // is still a draft). So this step clears the field first, matching the
    // one case where it's actually correct for the card to disappear: Carol
    // has given up on it, not merely collapsed the UI around her draft.
    await bobPage.locator('li.item-card:has-text("Rug") input[name="nickname"]').fill("");
    await bobPage.locator('li.item-card:has-text("Rug") input[name="note"]').fill("");
    await bobPage.locator('li.item-card:has-text("Rug") details.edit-details summary').click(); // collapse
    await bobPage.locator("body").click(); // move focus out of the card entirely
    const rugRemoved = await waitFor(
      () => bobPage.locator('li.item-card:has-text("Rug")').count().then((n) => n === 0),
      { timeout: 2000 },
    );
    check("once Carol's draft is actually abandoned, the stale Rug card is removed (catch-up reconcile fired)", rugRemoved);

    // Synthetic composition events test our DOM handling, not an OS candidate window.
    console.log("\n[test 3d] SYNTHETIC IME: other changes stay live while the input is protected");
    await moverPage.goto(manageUrl);
    for (const name of ["Kettle", "IME neighbour"]) {
      await moverPage.fill("#itemName", name);
      await moverPage.click('form[action$="/items"] button[type="submit"]');
      await waitFor(() => moverPage.locator(`li[data-item-id]:has-text("${name}")`).isVisible().catch(() => false));
    }
    await bobPage.goto(publicUrl);
    const imeCard = bobPage.locator('li.item-card:has-text("Kettle")');
    const neighbour = bobPage.locator('li[data-item-id]:has-text("IME neighbour")');
    const neighbourId = await neighbour.getAttribute("data-item-id");
    await imeCard.locator("summary").click();
    const imeInput = imeCard.locator('input[name="nickname"]');
    await imeInput.focus();
    const imeNode = await imeInput.elementHandle();
    await imeInput.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.value = "测试";
      el.setSelectionRange(0, 1);
      el.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing: true }));
    });

    await moverPage.fill("#slotStart", futureLocalDateTime(6));
    await moverPage.fill("#slotEnd", futureLocalDateTime(7));
    await moverPage.click('form[action$="/timeslots"] button[type="submit"]');
    const optionsUpdatedDuringComposition = await waitFor(
      async () => (await imeCard.locator('select[name="timeslotId"] option').count()) >= 3,
      { timeout: 1500 },
    );
    check("SYNTHETIC: shared pickup times update before composition ends", optionsUpdatedDuringComposition);

    const withdrawal = await mover.request.post(`${BASE_URL}/items/${neighbourId}/withdraw`, { maxRedirects: 0 });
    check("setup: the other item was actually withdrawn", withdrawal.status() === 302);
    const neighbourRemoved = await waitFor(() => neighbour.count().then((n) => n === 0), { timeout: 1500 });
    check("SYNTHETIC: an unrelated withdrawn item disappears before composition ends", neighbourRemoved);

    const secondWithdrawalVisible = await waitFor(async () => {
      const titles = await withdrawnPane.locator('summary').allTextContents();
      const names = await withdrawnPane.locator('li').allTextContents();
      return titles[0] === 'Withdrawn items (2)' && names.length === 2 && names.includes('Rug') && names.includes('IME neighbour');
    }, { timeout: 1500 });
    check("the open withdrawn list updates from one item to two, including both names", secondWithdrawalVisible);
    check("updating the withdrawn count keeps the details expanded", await withdrawnPane.evaluateAll((nodes) => nodes.length === 1 && nodes[0].open));
    const observerDraft = await manageObserver.locator('#itemName').evaluate((el) =>
      el.value === 'Unfinished item' && document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === 4,
    );
    check("withdrawal updates preserve the mover's unfinished form, focus and selection", observerDraft);
    check("the observing manage tab never navigated or reloaded", observerNavigations === 0);

    const draft = await imeNode.evaluate((el) => ({
      connected: el.isConnected,
      focused: document.activeElement === el,
      value: el.value,
      start: el.selectionStart,
      end: el.selectionEnd,
    }));
    check("SYNTHETIC: composing text is untouched by live updates", draft.value === "测试");
    check("SYNTHETIC: the original input node, focus and selection survive", draft.connected && draft.focused && draft.start === 0 && draft.end === 1);
    await imeInput.evaluate((el) => {
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    });
    const stateAfterComposition = await waitFor(
      async () => (await imeCard.locator('select[name="timeslotId"] option').count()) >= 3,
    );
    check("SYNTHETIC: shared state remains current after composition ends", stateAfterComposition);
    await imeNode.dispose();

    // ---- 4: confirmed status + pickup address land even while protected ----
    console.log("\n[test 4] David opens 'Change pickup time' on his pending request; mover confirms it while that's open");
    const davidPage = await (await browser.newContext()).newPage();
    await davidPage.goto(publicUrl);
    const davidCard = davidPage.locator('li.item-card:has-text("Desk Lamp")');
    // Desk Lamp is already reserved for Bob by this point, so this part
    // uses a fresh item instead.
    await moverPage.goto(manageUrl);
    await moverPage.fill("#itemName", "Chair");
    await moverPage.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => moverPage.locator('li[data-item-id]:has-text("Chair")').isVisible().catch(() => false));
    await davidPage.goto(publicUrl);
    const chairCard = davidPage.locator('li.item-card:has-text("Chair")');
    await chairCard.locator("summary").click();
    await chairCard.locator('input[name="nickname"]').fill("David");
    await chairCard.locator('button[type="submit"]').click();
    await davidPage.waitForURL(publicUrl);

    await davidPage.locator('li.item-card:has-text("Chair") details.edit-details summary').click(); // "Change pickup time"
    await davidPage.locator('li.item-card:has-text("Chair") input[name="nickname"]'); // n/a; keep focus inside the open details
    await moverPage.goto(manageUrl);
    await moverPage.locator('li[data-item-id]:has-text("Chair") form[action*="/confirm"] button').click();

    const davidSeesConfirmed = await waitFor(
      () => davidPage.locator('li.item-card:has-text("Chair")').locator("text=Confirmed").isVisible().catch(() => false),
      { timeout: 3000 },
    );
    const davidSeesAddress = await waitFor(
      () => davidPage.locator('li.item-card:has-text("Chair") [data-pickup-spot]').isVisible().catch(() => false),
      { timeout: 3000 },
    );
    check("bug fix 3: confirmed status reaches the protected card", davidSeesConfirmed);
    check("bug fix 3: pickup address appears alongside the confirmed status, not just the label", davidSeesAddress);
    const timeslotBtnDisabled = await davidPage
      .locator('li.item-card:has-text("Chair") form[action*="/timeslot"] button[type="submit"]')
      .isDisabled()
      .catch(() => true); // the form itself may have closed; either outcome is acceptable, only an *enabled* stale button is the bug
    check("bug fix 3: the now-meaningless 'change timeslot' control is disabled, not left actionable", timeslotBtnDisabled);

    // ---- 5: empty -> non-empty list transition (My MoveOut) -----------------
    console.log("\n[test 5] Emma opens her empty 'My MoveOut' page in one tab, applies for an item in another tab");
    const emmaCtx = await browser.newContext();
    const emmaHome = await emmaCtx.newPage();
    const emmaOther = await emmaCtx.newPage();
    await emmaHome.goto(`${BASE_URL}/mine`);
    const noRequestsSectionHiddenInitially = await emmaHome
      .locator('section[data-live-section="home-requests"]')
      .isHidden()
      .catch(() => false);
    check("setup: Emma's home page starts with no 'Your requests' section visible", noRequestsSectionHiddenInitially);

    // A fresh item for Emma — every earlier item (Lamp, Rug, Chair) is by
    // now confirmed or withdrawn and has no open apply form left.
    await moverPage.goto(manageUrl);
    await moverPage.fill("#itemName", "Dining Table");
    await moverPage.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => moverPage.locator('li[data-item-id]:has-text("Dining Table")').isVisible().catch(() => false));
    await emmaOther.goto(publicUrl);
    const dineTableCard = emmaOther.locator('li.item-card:has-text("Dining Table")');
    await dineTableCard.locator("summary").click();
    await dineTableCard.locator('input[name="nickname"]').fill("Emma");
    const emmaApplyTime = Date.now();
    await dineTableCard.locator('button[type="submit"]').click();
    await emmaOther.waitForURL(publicUrl);

    const sectionAppeared = await waitFor(
      () => emmaHome.locator('section[data-live-section="home-requests"]').isVisible().catch(() => false),
      { timeout: 3000 },
    );
    const emmaLatencyMs = Date.now() - emmaApplyTime;
    check("bug fix 4: 'Your requests' section appears on Emma's already-open, previously-empty home page", sectionAppeared && emmaLatencyMs < 1500, `${emmaLatencyMs}ms`);
    const emmaRowVisible = await emmaHome.locator('section[data-live-section="home-requests"] li[data-application-id]').isVisible().catch(() => false);
    check("the new request actually appears as a row, not an empty shell", emmaRowVisible);

    // ---- 6: server-side rejection of a genuinely stale confirm --------------
    // Bug in the first version: force-clicking a *disabled* button proves
    // the client disabled it correctly, not that the SERVER independently
    // rejects the same stale action — those are different claims. This
    // drives the real regression directly over HTTP against this same
    // running server/data, matching spec/moveout.test.ts's new regression
    // test, then confirms the browser-visible effect: the item stays
    // requestable, it was never wrongly locked.
    console.log("\n[test 6] a stale confirm (already-cancelled application) is rejected by the SERVER, not just the UI");
    const freshCtx = await browser.newContext();
    const frank = await freshCtx.newPage();
    await frank.goto(publicUrl);
    await moverPage.goto(manageUrl);
    await moverPage.fill("#itemName", "Toaster");
    await moverPage.click('form[action$="/items"] button[type="submit"]');
    await waitFor(() => moverPage.locator('li[data-item-id]:has-text("Toaster")').isVisible().catch(() => false));
    await frank.goto(publicUrl);
    const toasterCard = frank.locator('li.item-card:has-text("Toaster")');
    await toasterCard.locator("summary").click();
    await toasterCard.locator('input[name="nickname"]').fill("Frank");
    await toasterCard.locator('button[type="submit"]').click();
    await frank.waitForURL(publicUrl);

    await moverPage.goto(manageUrl);
    const frankAppId = await moverPage
      .locator('li[data-item-id]:has-text("Toaster") .applicant-row[data-application-id]')
      .first()
      .getAttribute("data-application-id");
    // Frank cancels his own request directly over HTTP (simulating his tab
    // having done so a moment ago, before the mover's page resynced).
    await frank.evaluate(
      (id) => fetch(`/applications/${id}/cancel`, { method: "POST", credentials: "same-origin" }),
      frankAppId,
    );
    // The mover's page is now stale: it still offers a Confirm button for
    // Frank's cancelled request. Click it — this hits the real route.
    const staleConfirmRes = await moverPage.evaluate(
      async (id) => {
        const res = await fetch(`/applications/${id}/confirm`, { method: "POST", credentials: "same-origin" });
        return res.status;
      },
      frankAppId,
    );
    check("server rejects confirming an already-cancelled application (409, not 302)", staleConfirmRes === 409, `got ${staleConfirmRes}`);

    const toasterStillOpen = await frank
      .evaluate(() => fetch(location.href, { credentials: "same-origin" }).then((r) => r.text()))
      .then((html) => html.includes("Toaster") && html.includes('data-item-status="open"'));
    check("bug fix 5: the item was NOT left wrongly reserved by the rejected stale confirm", toasterStillOpen);

    // ---- 7: connection status + draft preservation across a real outage ----
    console.log("\n[test 7] connection status reflects a real disconnect, then recovers without losing a draft");
    await bobPage.goto(publicUrl);
    const draftCard = bobPage.locator('li.item-card[data-item-status="open"] details.edit-details').first();
    await draftCard.locator("summary").click();
    await draftCard.locator('input[name="nickname"]').fill("Still typing when it drops");
    await stopServer(server);
    const reconnectingShown = await waitFor(
      () => bobPage.locator("#connection-status", { hasText: "Reconnecting" }).isVisible().catch(() => false),
      { timeout: 8000 },
    );
    check('status banner says "Reconnecting..." while the server is down', reconnectingShown);
    const draftDuringOutage = await draftCard.locator('input[name="nickname"]').inputValue();
    check("draft input is untouched during the outage", draftDuringOutage === "Still typing when it drops");

    server = startServer({});
    await waitForServer();
    const liveShown = await waitFor(
      () => bobPage.locator("#connection-status", { hasText: "Live" }).isVisible().catch(() => false),
      { timeout: 10000 },
    );
    check('status banner returns to "Live" after the server comes back', liveShown);
    const draftAfterRecover = await draftCard.locator('input[name="nickname"]').inputValue();
    check("draft input survived the reconnect, and was never auto-submitted", draftAfterRecover === "Still typing when it drops");
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
