#!/usr/bin/env node
// Manual, browser-level verification for accounts (src/auth.ts,
// src/routes/auth.ts) — register/login/logout, claiming an existing
// device's anonymous data into an account, and reaching that same account's
// pages/requests from a genuinely different browser context. Not part of
// `pnpm check` on purpose (same reasoning as scripts/browser-verify.mjs):
// starts its own server on an isolated throwaway DATA_DIR and drives
// multiple independent Playwright *contexts* with real Chrome — this is the
// one thing spec/accounts.test.ts's HTTP-only tests can't themselves show:
// a real page navigation, a real cookie jar, a visible "My MoveOut" page
// actually listing the right content in a rendered browser.
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

async function register(page, email, password) {
  await safeGoto(page, `${BASE_URL}/register`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('form[action="/register"] button[type="submit"]').click({ force: true });
  await page.waitForLoadState("networkidle");
}

async function login(page, email, password) {
  await safeGoto(page, `${BASE_URL}/login`);
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.locator('form[action="/login"] button[type="submit"]').click({ force: true });
  await page.waitForLoadState("networkidle");
}

async function main() {
  console.log(`Data dir: ${dataDir}`);
  let server = null;
  let browser = null;
  try {
    server = startServer();
    await waitForServer();
    browser = await chromium.launch({ channel: "chrome" });
    const email = `verify-${Date.now()}@example.com`;
    const password = "a-strong-password-123";

    // ---- 1: anonymous page, then register on the SAME browser claims it ---
    console.log("\n[1] create a page anonymously, then register — the page should be claimed into the new account");
    const ownerCtx = await browser.newContext();
    const owner = await ownerCtx.newPage();
    const manageUrl = await createMoveoutPage(owner, { title: "Verify Account Page", pickupLocation: "Door 1", nickname: "Owner" });
    await addTimeslot(owner);
    await addItem(owner, "Verify Lamp");
    const publicUrl = manageUrl.replace("/manage", "");

    await register(owner, email, password);
    const registerBody = await owner.locator("body").innerText();
    check("register page confirms the page was linked", registerBody.includes("Linked 1 move-out page"));

    await safeGoto(owner, `${BASE_URL}/mine`);
    const mineAfterRegister = await owner.locator("body").innerText();
    check("owner's own /mine lists the claimed page after registering", mineAfterRegister.includes("Verify Account Page"));
    const headerShowsEmail = await owner.locator(".account-chip").innerText().catch(() => "");
    check("header shows the signed-in email", headerShowsEmail.includes(email));

    // ---- 2: a genuinely different browser context logs in and manages it --
    console.log("\n[2] a second, independent browser context logs into the SAME account");
    const secondCtx = await browser.newContext();
    const secondDevice = await secondCtx.newPage();
    const beforeLoginStatus = await safeGoto(secondDevice, manageUrl);
    check("before logging in, the second device cannot reach the manage page", beforeLoginStatus.status() === 403);

    await login(secondDevice, email, password);
    const afterLoginManage = await safeGoto(secondDevice, manageUrl);
    check("after logging in, the second device CAN reach the manage page it never created", afterLoginManage.status() === 200);
    const secondDeviceBody = await secondDevice.locator("body").innerText();
    check("the second device's manage page shows the same page's content", secondDeviceBody.includes("Verify Account Page") && secondDeviceBody.includes("Verify Lamp"));

    await safeGoto(secondDevice, `${BASE_URL}/mine`);
    const secondMine = await secondDevice.locator("body").innerText();
    check("the second device's own /mine also lists the same page", secondMine.includes("Verify Account Page"));

    // Can it actually WRITE, not just view? Add a second item from here.
    await safeGoto(secondDevice, manageUrl);
    await addItem(secondDevice, "Added From Second Device");
    const itemAddedBody = await secondDevice.locator("body").innerText();
    check("the second device can actually add an item (a creator-only write), not just view", itemAddedBody.includes("Added From Second Device"));

    // ---- 3: a third, unrelated visitor cannot see the claimant request ----
    console.log("\n[3] cross-account isolation — an unrelated account cannot manage this page or act on its applications");
    const claimantCtx = await browser.newContext();
    const claimant = await claimantCtx.newPage();
    await safeGoto(claimant, publicUrl);
    const firstItemCard = claimant.locator("li.item-card").first();
    await firstItemCard.locator('summary:has-text("Request this")').click({ force: true });
    await firstItemCard.locator('input[name="nickname"]').fill("Claimant");
    const [applyResp] = await Promise.all([
      claimant.waitForResponse((r) => r.url().includes("/apply") && r.request().method() === "POST"),
      firstItemCard.locator('form[action*="/apply"] button[type="submit"]').click({ force: true }),
    ]);
    if (applyResp.status() >= 400) throw new Error(`apply failed: ${applyResp.status()}`);
    const claimantEmail = `verify-claimant-${Date.now()}@example.com`;
    await register(claimant, claimantEmail, password);

    const strangerCtx = await browser.newContext();
    const stranger = await strangerCtx.newPage();
    const strangerEmail = `verify-stranger-${Date.now()}@example.com`;
    await register(stranger, strangerEmail, password);
    const strangerManageAttempt = await safeGoto(stranger, manageUrl);
    check("an unrelated signed-in account cannot reach someone else's manage page", strangerManageAttempt.status() === 403);

    // ---- 4: claimant's own application is reachable from a new device -----
    console.log("\n[4] a different device, signed into the claimant's account, can manage the SAME application");
    await safeGoto(owner, manageUrl);
    await owner.waitForLoadState("networkidle");
    // Scoped to the applicant row that actually says "Claimant" — with two
    // items on this page, an unscoped `.first()` confirm button isn't
    // reliably the claimant's own request.
    const claimantRow = owner.locator('li.applicant-row:has-text("Claimant")').first();
    const [confirmResp] = await Promise.all([
      owner.waitForResponse((r) => r.url().includes("/confirm") && r.request().method() === "POST"),
      claimantRow.locator('form[action*="/confirm"] button[type="submit"]').click({ force: true }),
    ]);
    if (confirmResp.status() >= 400) throw new Error(`confirm failed: ${confirmResp.status()}`);
    await owner.waitForLoadState("networkidle");

    const claimantSecondDeviceCtx = await browser.newContext();
    const claimantSecondDevice = await claimantSecondDeviceCtx.newPage();
    await login(claimantSecondDevice, claimantEmail, password);
    await safeGoto(claimantSecondDevice, publicUrl);
    await claimantSecondDevice.waitForLoadState("networkidle");
    const pickupShown = await waitFor(() => claimantSecondDevice.locator(".pickup-card").isVisible().catch(() => false));
    check("a different device, signed into the claimant's account, sees the confirmed pickup card", pickupShown);
    await claimantSecondDevice.getByRole("button", { name: "On the way", exact: true }).click({ force: true });
    await claimantSecondDevice.waitForLoadState("networkidle");
    const departureShown = await waitFor(() =>
      claimantSecondDevice.locator("[data-departure-status-text]").innerText().then((t) => t.includes("On the way")).catch(() => false),
    );
    check("that second device can actually set departure status on a request it never personally created", departureShown);

    // ---- 5: logout actually revokes, a replayed cookie can't act ----------
    console.log("\n[5] logout revokes the session — replaying the old cookie cannot perform a write");
    const sessionCookieBefore = (await secondCtx.cookies()).find((c) => c.name === "session");
    check("setup: the second device had a real session cookie before logout", Boolean(sessionCookieBefore));

    await secondDevice.locator('form[action="/logout"] button[type="submit"]').click({ force: true });
    await secondDevice.waitForLoadState("networkidle");
    const afterLogoutHeader = await secondDevice.locator(".site-nav").innerText();
    check("after logout, the header no longer shows the account — back to Log in / Register", afterLogoutHeader.includes("Log in") && afterLogoutHeader.includes("Register"));

    // Replay the pre-logout cookie value directly via a raw request in a
    // FRESH context (so no other cookie from this browsing session is
    // involved) — simulating a stolen cookie used after the real owner
    // signed out.
    const replayCtx = await browser.newContext();
    await replayCtx.addCookies([
      { name: "session", value: sessionCookieBefore.value, domain: "localhost", path: "/" },
    ]);
    const replayPage = await replayCtx.newPage();
    const replayManageAttempt = await safeGoto(replayPage, manageUrl);
    check("the exact pre-logout session cookie, replayed after logout, can no longer reach the manage page", replayManageAttempt.status() === 403);
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
