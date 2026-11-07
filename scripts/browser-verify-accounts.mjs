#!/usr/bin/env node
// Manual, browser-level acceptance for this round's permission/login-gate
// fix: once a page or application is bound to an account, the device cookie
// that created it must stop granting access (src/ownership.ts#matchesOwner),
// publishing/applying now requires being signed in (src/routes/moveout.ts,
// src/routes/home.ts), and logout must actually revoke the server-side
// session, not just clear a cookie. Not part of `pnpm check` on purpose (same
// reasoning as scripts/browser-verify.mjs): starts its own server on an
// isolated throwaway DATA_DIR and drives multiple independent Playwright
// *contexts* with real Chrome — the thing spec/accounts.test.ts and
// spec/permission-regression.test.ts's HTTP-only tests can't themselves
// show: a real page navigation, a real cookie jar, a visible rendered page.
//
// Usage: node scripts/browser-verify-accounts.mjs
// Requires the same system Chrome as scripts/browser-verify.mjs.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8126;
const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-accounts-verify-"));
const TIMEZONE = "Australia/Sydney";
const VIEWPORTS = [
  { name: "desktop 1920x1080", width: 1920, height: 1080 },
  { name: "mobile 390x844", width: 390, height: 844 },
];

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

function startServer() {
  return spawn(process.execPath, ["src/server.ts"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir },
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

async function waitFor(predicate, { timeout = 5000, interval = 100 } = {}) {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return true;
    if (Date.now() - start > timeout) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// A page with the live-update SSE connection open (src/public/live.js) can
// trigger its own background navigation (reconnect/resync) at the same
// instant a script-driven `goto` fires. Playwright's own `goto` doesn't
// retry on "interrupted by another navigation", so this wraps it with one.
async function safeGoto(page, url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await page.goto(url);
    } catch (err) {
      const retryable = /interrupted by another navigation|ERR_ABORTED/.test(String(err));
      if (!retryable || attempt === 3) throw err;
      await page.waitForTimeout(300);
    }
  }
}

async function register(page, email, password, { next } = {}) {
  await safeGoto(page, next ? `${BASE_URL}/register?next=${encodeURIComponent(next)}` : `${BASE_URL}/register`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('form[action="/register"] button[type="submit"]').click({ force: true });
  await page.waitForLoadState("networkidle");
}

async function login(page, email, password, { next } = {}) {
  await safeGoto(page, next ? `${BASE_URL}/login?next=${encodeURIComponent(next)}` : `${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('form[action="/login"] button[type="submit"]').click({ force: true });
  await page.waitForLoadState("networkidle");
}

async function createMoveoutPage(page, { title, pickupLocation, nickname }) {
  await safeGoto(page, `${BASE_URL}/mine`);
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

async function addTimeslot(page) {
  await page.fill("#slotStart", futureLocalDateTime(2));
  await page.fill("#slotEnd", futureLocalDateTime(3));
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
    page.locator('form[action$="/items"] button[type="submit"]').click({ force: true }),
  ]);
  if (resp.status() >= 400) throw new Error(`add-item failed: ${resp.status()}`);
  await page.waitForFunction((n) => document.body.innerText.includes(n), name, { timeout: 5000 });
}

async function runAt(viewport, browser) {
  console.log(`\n=== viewport: ${viewport.name} ===`);
  const email = `verify-${viewport.width}-${Date.now()}@example.com`;
  const password = "a-strong-password-123";

  // ---- 0: an unauthenticated visitor clicking "publish" is guided to log in
  console.log("[0] an unauthenticated visitor is guided to log in before publishing, and before applying");
  const anonCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const anon = await anonCtx.newPage();
  await safeGoto(anon, `${BASE_URL}/mine`);
  const minePromptsLogin = await anon.locator('a[href^="/login"]').first().isVisible().catch(() => false);
  check(`[${viewport.name}] /mine prompts an anonymous visitor to log in, rather than showing the create-page form`, minePromptsLogin);
  await anonCtx.close();

  // ---- 1: a signed-in owner creates a page -------------------------------
  console.log("[1] a signed-in owner creates and publishes a page");
  const ownerCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const owner = await ownerCtx.newPage();
  await register(owner, email, password);
  const manageUrl = await createMoveoutPage(owner, { title: `Verify Account Page ${viewport.width}`, pickupLocation: "Door 1", nickname: "Owner" });
  await addTimeslot(owner);
  await addItem(owner, "Verify Lamp");
  const publicUrl = manageUrl.replace("/manage", "");
  const publicPath = new URL(publicUrl).pathname;

  // An anonymous visitor to the public page is guided to log in rather than
  // shown the apply form.
  const visitorCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const visitor = await visitorCtx.newPage();
  await safeGoto(visitor, publicUrl);
  const applyPromptsLogin = await visitor.locator('a[href^="/login"]').first().isVisible().catch(() => false);
  check(`[${viewport.name}] an anonymous visitor to the public page is prompted to log in before requesting an item, not shown the request form`, applyPromptsLogin);
  await visitorCtx.close();

  // ---- 2: a second, independent browser context logs in and manages it --
  console.log("[2] a second, independent browser context logs into the SAME account");
  const secondCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const secondDevice = await secondCtx.newPage();
  const beforeLoginStatus = await safeGoto(secondDevice, manageUrl);
  check(`[${viewport.name}] before logging in, the second device cannot reach the manage page`, beforeLoginStatus.status() === 403);

  await login(secondDevice, email, password);
  const afterLoginManage = await safeGoto(secondDevice, manageUrl);
  check(`[${viewport.name}] after logging in, the second device CAN reach the manage page it never created`, afterLoginManage.status() === 200);
  const secondDeviceBody = await secondDevice.locator("body").innerText();
  check(
    `[${viewport.name}] the second device's manage page shows the same page's content`,
    secondDeviceBody.includes(`Verify Account Page ${viewport.width}`) && secondDeviceBody.includes("Verify Lamp"),
  );

  // Can it actually WRITE, not just view? Add a second item from here.
  await addItem(secondDevice, "Added From Second Device");
  const itemAddedBody = await secondDevice.locator("body").innerText();
  check(`[${viewport.name}] the second device can actually add an item (a creator-only write), not just view`, itemAddedBody.includes("Added From Second Device"));

  // ---- 3: a signed-in claimant requests the item, logs out via login+next -
  console.log("[3] a claimant applies after being guided through login, landing back on the original page");
  const claimantCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const claimant = await claimantCtx.newPage();
  await safeGoto(claimant, publicUrl);
  const loginLink = await claimant.locator('li.item-card a[href^="/login"]').first().getAttribute("href");
  check(`[${viewport.name}] the login prompt's link carries a same-site "next" back to this exact page`, loginLink && loginLink.includes("next=") && !loginLink.includes("http"));
  const claimantEmail = `verify-claimant-${viewport.width}-${Date.now()}@example.com`;
  await register(claimant, claimantEmail, password, { next: publicPath });
  // Lands on the intermediate "linked" confirmation, not auto-redirected —
  // the user clicks through themselves.
  const onConfirmation = claimant.url().includes("/register") || (await claimant.locator(`a[href="${publicPath}"]`).count()) > 0;
  check(`[${viewport.name}] after registering via the login gate, the user is shown a confirmation to click through, not auto-redirected with the original request replayed`, onConfirmation);
  await claimant.locator(`a[href="${publicPath}"]`).first().click({ force: true });
  await claimant.waitForLoadState("networkidle");

  const firstItemCard = claimant.locator("li.item-card").first();
  await firstItemCard.locator('summary:has-text("Request this")').click({ force: true });
  await firstItemCard.locator('input[name="nickname"]').fill("Claimant");
  const [applyResp] = await Promise.all([
    claimant.waitForResponse((r) => r.url().includes("/apply") && r.request().method() === "POST"),
    firstItemCard.locator('form[action*="/apply"] button[type="submit"]').click({ force: true }),
  ]);
  if (applyResp.status() >= 400) throw new Error(`apply failed: ${applyResp.status()}`);
  check(`[${viewport.name}] the now-logged-in claimant's apply actually succeeds`, applyResp.status() < 400);

  // ---- 4: cross-account isolation ----------------------------------------
  console.log("[4] cross-account isolation — an unrelated account cannot manage this page or act on its applications");
  const strangerCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const stranger = await strangerCtx.newPage();
  const strangerEmail = `verify-stranger-${viewport.width}-${Date.now()}@example.com`;
  await register(stranger, strangerEmail, password);
  const strangerManageAttempt = await safeGoto(stranger, manageUrl);
  check(`[${viewport.name}] an unrelated signed-in account cannot reach someone else's manage page`, strangerManageAttempt.status() === 403);

  // ---- 5: a different device, signed into the claimant's account --------
  console.log("[5] a different device, signed into the claimant's account, can manage the SAME application");
  await safeGoto(owner, manageUrl);
  await owner.waitForLoadState("networkidle");
  const claimantRow = owner.locator('li.applicant-row:has-text("Claimant")').first();
  const [confirmResp] = await Promise.all([
    owner.waitForResponse((r) => r.url().includes("/confirm") && r.request().method() === "POST"),
    claimantRow.locator('form[action*="/confirm"] button[type="submit"]').click({ force: true }),
  ]);
  if (confirmResp.status() >= 400) throw new Error(`confirm failed: ${confirmResp.status()}`);
  await owner.waitForLoadState("networkidle");

  const claimantSecondDeviceCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const claimantSecondDevice = await claimantSecondDeviceCtx.newPage();
  await login(claimantSecondDevice, claimantEmail, password);
  await safeGoto(claimantSecondDevice, publicUrl);
  await claimantSecondDevice.waitForLoadState("networkidle");
  const pickupShown = await waitFor(() => claimantSecondDevice.locator(".pickup-card").isVisible().catch(() => false));
  check(`[${viewport.name}] a different device, signed into the claimant's account, sees the confirmed pickup card`, pickupShown);

  // ---- 6: A logs out — old page/link/direct-request attempts all fail ---
  console.log("[6] A logs out — the old device cookie can no longer manage the page via page, link, or direct request");
  const sessionCookieBefore = (await ownerCtx.cookies()).find((c) => c.name === "session");
  check(`[${viewport.name}] setup: the owner had a real session cookie before logout`, Boolean(sessionCookieBefore));

  await owner.locator('form[action="/logout"] button[type="submit"]').click({ force: true });
  await owner.waitForLoadState("networkidle");
  const afterLogoutHeader = await owner.locator(".site-nav").innerText();
  check(`[${viewport.name}] after logout, the header no longer shows the account — back to Log in / Register`, afterLogoutHeader.includes("Log in") && afterLogoutHeader.includes("Register"));

  // Via the same tab, revisiting the manage URL directly.
  const sameTabRetry = await safeGoto(owner, manageUrl);
  check(`[${viewport.name}] after logout, revisiting the manage URL in the SAME tab is rejected`, sameTabRetry.status() === 403);

  // Via a fresh context replaying the exact pre-logout session cookie — a
  // "stolen cookie" / "old open tab elsewhere" scenario.
  const replayCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await replayCtx.addCookies([{ name: "session", value: sessionCookieBefore.value, domain: "localhost", path: "/" }]);
  const replayPage = await replayCtx.newPage();
  const replayManageAttempt = await safeGoto(replayPage, manageUrl);
  check(`[${viewport.name}] the exact pre-logout session cookie, replayed after logout, can no longer reach the manage page`, replayManageAttempt.status() === 403);
  // A direct POST write attempt with the same stale cookie must also fail.
  const replayWrite = await replayPage.evaluate(async (url) => {
    const res = await fetch(url, { method: "POST", redirect: "manual", body: new URLSearchParams({ reason: "stale" }) });
    return res.status;
  }, `${publicUrl}/items/does-not-matter/withdraw`);
  check(`[${viewport.name}] a direct POST write with the stale cookie is rejected (not a 2xx)`, replayWrite >= 400);

  // ---- 7: an open tab's private content clears when logged out elsewhere -
  // The real scenario the brief asks for: TWO TABS of the SAME browser
  // (same cookie jar — a single BrowserContext, two Pages), one left open
  // on a page showing private content, logout happening in the OTHER tab —
  // and the first tab must notice and clear that content on its own,
  // without this script ever reloading it by hand. A bare "GET the manage
  // URL again, see 403" (what step 6 above checks) does NOT prove this: the
  // bug was specifically that an already-open tab kept SHOWING its
  // already-fetched private DOM indefinitely, not that a fresh request
  // would fail.
  console.log("[7] an already-open tab (same browser, second tab) clears its private content when logout happens in a sibling tab");
  const sessionEmail = `verify-session-${viewport.width}-${Date.now()}@example.com`;
  const sessionPassword = "a-strong-password-123";
  const sharedCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const tabA = await sharedCtx.newPage();
  await register(tabA, sessionEmail, sessionPassword);
  const sessionManageUrl = await createMoveoutPage(tabA, { title: `Stale-tab test ${viewport.width}`, pickupLocation: "Stale Tab Secret Door", nickname: "Owner" });

  // tabB is a SECOND tab in the SAME context — same cookies, genuinely left
  // open on the manage page (which shows the exact pickup location,
  // management controls, etc., all private to this account).
  const tabB = await sharedCtx.newPage();
  await safeGoto(tabB, sessionManageUrl);
  await tabB.waitForLoadState("networkidle");
  const tabBShowsPrivateBefore = (await tabB.locator("body").innerText()).includes("Stale Tab Secret Door");
  check(`[${viewport.name}] setup: the open second tab shows this account's private pickup location before logout`, tabBShowsPrivateBefore);

  // Logout happens in tabA — tabB never navigates, never reloads; its only
  // path to finding out is its own SSE "sync" event (src/routes/auth.ts's
  // logout now calls notifyDevice/notifyAccount) triggering a resync
  // (src/public/live.js), which re-fetches and gets a 401/403 back.
  await tabA.locator('form[action="/logout"] button[type="submit"]').click({ force: true });
  await tabA.waitForLoadState("networkidle");

  const tabBCleared = await waitFor(async () => {
    const text = await tabB.locator("body").innerText().catch(() => "");
    return !text.includes("Stale Tab Secret Door");
  }, { timeout: 5000 });
  check(`[${viewport.name}] the open second tab's private pickup location is gone within ~5s, with no manual reload from this script`, tabBCleared);

  // It must land somewhere that doesn't re-show management/private content
  // either — not just blank the one string checked above.
  const tabBFinalText = await tabB.locator("body").innerText().catch(() => "");
  check(
    `[${viewport.name}] the cleared tab shows a not-signed-in/not-found view, not leftover management controls`,
    !tabBFinalText.includes("Withdraw") && !tabBFinalText.includes("Confirm"),
  );
  await sharedCtx.close();

  // ---- 8: two devices, same account, can't both actively claim one item -
  console.log("[8] two devices signed into the same account can't hold two active requests for the same item");
  const dupEmail = `verify-dup-${viewport.width}-${Date.now()}@example.com`;
  const dupPassword = "a-strong-password-123";
  const dupOwnerCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const dupOwner = await dupOwnerCtx.newPage();
  await register(dupOwner, `verify-dup-owner-${viewport.width}-${Date.now()}@example.com`, dupPassword);
  const dupManageUrl = await createMoveoutPage(dupOwner, { title: `Dup-apply test ${viewport.width}`, pickupLocation: "Door", nickname: "Owner" });
  await addTimeslot(dupOwner);
  await addItem(dupOwner, "Dup Item");
  const dupPublicUrl = dupManageUrl.replace("/manage", "");

  const dupDevice1Ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const dupDevice1 = await dupDevice1Ctx.newPage();
  await register(dupDevice1, dupEmail, dupPassword);
  await safeGoto(dupDevice1, dupPublicUrl);
  const dupItemCard1 = dupDevice1.locator("li.item-card").first();
  await dupItemCard1.locator('summary:has-text("Request this")').click({ force: true });
  await dupItemCard1.locator('input[name="nickname"]').fill("First device");
  const [dupApply1] = await Promise.all([
    dupDevice1.waitForResponse((r) => r.url().includes("/apply") && r.request().method() === "POST"),
    dupItemCard1.locator('form[action*="/apply"] button[type="submit"]').click({ force: true }),
  ]);
  check(`[${viewport.name}] the first device's apply for the item succeeds`, dupApply1.status() < 400);

  const dupDevice2Ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const dupDevice2 = await dupDevice2Ctx.newPage();
  await login(dupDevice2, dupEmail, dupPassword);
  await safeGoto(dupDevice2, dupPublicUrl);
  // "Your requests" also renders `li.item-card` rows (keyed by
  // data-application-id) — this has to scope to the public items list
  // (data-live-list="public-items", keyed by data-item-id) specifically, or
  // `.first()` finds the "Your requests" row instead and proves nothing.
  const dupItemCard2 = dupDevice2.locator('[data-live-list="public-items"] li.item-card').first();
  const dupItemCard2Text = await dupItemCard2.innerText().catch(() => "");
  const alreadyRequestedShown = dupItemCard2Text.includes("already requested");
  check(`[${viewport.name}] the second device (same account) sees "already requested" rather than a fresh apply form`, alreadyRequestedShown);
  await dupOwnerCtx.close();
  await dupDevice1Ctx.close();
  await dupDevice2Ctx.close();

  // ---- 9: My MoveOut live-updates across devices on the same account -----
  console.log("[9] device B's My MoveOut updates live when device A (same account) creates a page, without B reloading");
  const syncEmail = `verify-sync-${viewport.width}-${Date.now()}@example.com`;
  const syncPassword = "a-strong-password-123";
  const deviceACtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const deviceA = await deviceACtx.newPage();
  await register(deviceA, syncEmail, syncPassword);

  const deviceBCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const deviceB = await deviceBCtx.newPage();
  await login(deviceB, syncEmail, syncPassword);
  await safeGoto(deviceB, `${BASE_URL}/mine`);
  await deviceB.waitForLoadState("networkidle");

  const pageTitle = `Cross-device sync test ${viewport.width}`;
  await createMoveoutPage(deviceA, { title: pageTitle, pickupLocation: "Door", nickname: "Owner" });

  // deviceB never navigates or reloads — only its own SSE "sync" event
  // (src/live.ts#notifyAccount, wired into homeRoutes's GET /events) and
  // live.js's resync should bring the new page into view.
  const deviceBSeesNewPage = await waitFor(async () => {
    const text = await deviceB.locator("body").innerText().catch(() => "");
    return text.includes(pageTitle);
  }, { timeout: 5000 });
  check(`[${viewport.name}] device B's already-open My MoveOut shows device A's new page within ~5s, with no reload`, deviceBSeesNewPage);
  await deviceACtx.close();
  await deviceBCtx.close();

  await ownerCtx.close();
  await secondCtx.close();
  await claimantCtx.close();
  await strangerCtx.close();
  await claimantSecondDeviceCtx.close();
  await replayCtx.close();
}

async function main() {
  console.log(`Data dir: ${dataDir}`);
  let server = null;
  let browser = null;
  try {
    server = startServer();
    await waitForServer();
    browser = await chromium.launch({ channel: "chrome" });

    for (const viewport of VIEWPORTS) {
      await runAt(viewport, browser);
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
