#!/usr/bin/env node
// Browser-level acceptance for this round's second fix: logging in with
// correct credentials used to 500 when this device had its own unclaimed,
// pre-existing application that collided with the signing-in account's own
// active application for the same item (src/auth.ts#claimAnonymousDataForAccount
// hitting `applications_one_active_per_identity`). Not part of `pnpm check`
// on purpose, same reasoning as the other browser-verify scripts: starts its
// own server on an isolated throwaway DATA_DIR and drives real Chrome
// contexts, checking the actual rendered conflict notice and the real
// "continue using the app" path a Playwright-only HTTP test can't show.
//
// Usage: node scripts/browser-verify-claim-conflict.mjs
// Requires the same system Chrome as scripts/browser-verify.mjs.
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const PORT = 8127;
const BASE_URL = `http://localhost:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "moveout-claim-conflict-verify-"));
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

  // ---- Setup: a page with one item, and an account that already applied -
  const ownerCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const owner = await ownerCtx.newPage();
  await register(owner, `verify-cc-owner-${viewport.width}-${Date.now()}@example.com`, "a-strong-password-123");
  const manageUrl = await createMoveoutPage(owner, { title: `Claim conflict verify ${viewport.width}`, pickupLocation: "Door", nickname: "Owner" });
  await addTimeslot(owner);
  await addItem(owner, "Conflict Item");
  const publicUrl = manageUrl.replace("/manage", "");

  const accountEmail = `verify-cc-account-${viewport.width}-${Date.now()}@example.com`;
  const accountPassword = "a-strong-password-123";
  const accountDeviceCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const accountDevice = await accountDeviceCtx.newPage();
  await register(accountDevice, accountEmail, accountPassword);
  await safeGoto(accountDevice, publicUrl);
  const firstItemCard = accountDevice.locator('[data-live-list="public-items"] li.item-card').first();
  await firstItemCard.locator('summary:has-text("Request this")').click({ force: true });
  const timeslotIdFromForm = await firstItemCard.locator('select[name="timeslotId"] option').first().getAttribute("value");
  await firstItemCard.locator('input[name="nickname"]').fill("AccountDevice");
  const [applyResp] = await Promise.all([
    accountDevice.waitForResponse((r) => r.url().includes("/apply") && r.request().method() === "POST"),
    firstItemCard.locator('form[action*="/apply"] button[type="submit"]').click({ force: true }),
  ]);
  check(`[${viewport.name}] setup: the account's own device successfully applied for the item`, applyResp.status() < 400);

  // ---- Conflict device: a real pre-existing, unbound application --------
  // Built by inserting a genuine unbound row for a real device cookie this
  // browser actually holds (captured via document.cookie after one visit),
  // matching how a real pre-accounts browser would have one, not a mock.
  const conflictCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const conflictPage = await conflictCtx.newPage();
  await safeGoto(conflictPage, `${BASE_URL}/`);
  const cookies = await conflictCtx.cookies();
  const conflictDeviceId = cookies.find((c) => c.name === "device")?.value;
  check(`[${viewport.name}] setup: the conflict browser has its own device cookie`, Boolean(conflictDeviceId));

  // The item id is visible to an anonymous fetch; the timeslot id came from
  // the apply form scraped above, since it only renders once signed in.
  const conflictPublicPage = await (await fetch(new URL(publicUrl, BASE_URL), { headers: { Cookie: `device=${conflictDeviceId}` } })).text();
  const itemIdMatch = conflictPublicPage.match(/data-item-id="([A-Za-z0-9_-]+)"/);
  const itemId = itemIdMatch?.[1];
  const timeslotId = timeslotIdFromForm;
  check(`[${viewport.name}] setup: the item/timeslot ids were found to build the conflicting row`, Boolean(itemId && timeslotId));

  const db = new DatabaseSync(join(dataDir, "moveout.db"));
  const conflictAppId = `conflict-${viewport.width}-${Date.now()}`;
  db.prepare(
    `INSERT INTO applications (id, item_id, timeslot_id, claimer_device_id, claimer_nickname, status) VALUES (?,?,?,?,?,?)`,
  ).run(conflictAppId, itemId, timeslotId, conflictDeviceId, "ConflictDevice", "pending");
  db.close();

  // ---- The real bug: logging in with correct credentials -----------------
  console.log("[login] the conflict browser logs in with CORRECT credentials despite the pre-existing conflict");
  await login(conflictPage, accountEmail, accountPassword);
  const bodyText = await conflictPage.locator("body").innerText();
  check(`[${viewport.name}] login does not show an Internal Server Error`, !bodyText.includes("Internal Server Error"));
  check(`[${viewport.name}] login lands on the signed-in confirmation page, not an error page`, bodyText.includes("Welcome"));
  check(`[${viewport.name}] the header shows the account as actually signed in`, bodyText.includes(accountEmail));

  // ---- The conflict is reported honestly, with a real way to continue ---
  check(`[${viewport.name}] the page explains the conflicting request wasn't linked, rather than claiming full success`, bodyText.includes("wasn't linked") || bodyText.includes("weren't linked"));
  check(`[${viewport.name}] the conflicting item is named directly, not just a bare count`, bodyText.includes("Conflict Item"));
  const conflictLink = conflictPage.locator(`a[href="${new URL(publicUrl, BASE_URL).pathname}"]`);
  check(`[${viewport.name}] a real link to the conflicting page is rendered, not just text`, (await conflictLink.count()) > 0);

  // ---- The user can actually continue: visit it, cancel it, and it works
  console.log("[continue] the signed-in user follows the link and resolves the conflict by cancelling the duplicate");
  await conflictLink.first().click({ force: true });
  await conflictPage.waitForLoadState("networkidle");
  const conflictCard = conflictPage.locator(`li[data-application-id="${conflictAppId}"]`);
  check(`[${viewport.name}] the conflicting application is visible and still manageable from this same browser`, (await conflictCard.count()) > 0);
  const [cancelResp] = await Promise.all([
    conflictPage.waitForResponse((r) => r.url().includes("/cancel") && r.request().method() === "POST"),
    conflictCard.locator('form[action*="/cancel"] button[type="submit"]').click({ force: true }),
  ]);
  check(`[${viewport.name}] cancelling the conflicting (still-unclaimed) application succeeds`, cancelResp.status() < 400);

  // ---- Wrong password never gets anywhere near the claim logic ----------
  console.log("[wrong password] a wrong password on the SAME conflicted browser gets no access at all");
  const wrongPwCtx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  const wrongPwPage = await wrongPwCtx.newPage();
  await safeGoto(wrongPwPage, `${BASE_URL}/login`);
  await wrongPwPage.fill("#email", accountEmail);
  await wrongPwPage.fill("#password", "totally-wrong-password");
  await wrongPwPage.locator('form[action="/login"] button[type="submit"]').click({ force: true });
  await wrongPwPage.waitForLoadState("networkidle");
  const wrongPwBody = await wrongPwPage.locator("body").innerText();
  check(`[${viewport.name}] a wrong password shows the normal rejection, not the conflict flow or any account content`, wrongPwBody.includes("doesn't match an account") && !wrongPwBody.includes(accountEmail));

  await ownerCtx.close();
  await accountDeviceCtx.close();
  await conflictCtx.close();
  await wrongPwCtx.close();
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
