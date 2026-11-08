#!/usr/bin/env node
// Explicit manual production acceptance. Only creates clearly marked Unlisted QA data.
// Credentials/cookies stay in the gitignored data directory; no production reset/restart.
// node scripts/production-acceptance.mjs prepare
// node scripts/production-acceptance.mjs check <absolute-private-directory>
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = 'https://comp4020-final-tavewang.fly.dev';
const TZ = 'Australia/Sydney';
const mode = process.argv[2];
assert.ok(['prepare', 'check', 'selftest'].includes(mode), 'Use prepare, check <directory>, or selftest');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const directory = resolve(process.argv[3] || `data/production-acceptance-${stamp}`);
assert.ok(directory.startsWith(resolve('data') + '/'), 'Private evidence must be inside gitignored data/');
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
const save = (name, value) => {
  const path = join(directory, name);
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
};
const load = name => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sizes = [{ width: 1920, height: 1080 }, { width: 390, height: 844 }];
const browser = await chromium.launch({ channel: 'chrome' });
const samples = [];
let manifest = mode === 'check' ? load('manifest.json') : {
  baseUrl: BASE, createdAt: new Date().toISOString(), timezone: TZ,
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  browserVersion: browser.version(), accounts: [], pages: [],
};
function checkpoint() { save('manifest.json', manifest); save('timings.json', samples); }
function localTime(hours) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(Date.now() + hours * 3600000)).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
async function goto(page, url) {
  for (let i = 0; i < 3; i++) {
    try { return await page.goto(url, { waitUntil: 'domcontentloaded' }); }
    catch (e) { if (i === 2 || !/interrupted by another navigation|ERR_ABORTED/.test(String(e))) throw e; }
  }
}
async function live(page) {
  await page.locator('#connection-status[data-state="live"]').waitFor({ timeout: 15000 });
}
async function submit(page, form, button = 'button[type="submit"]') {
  const action = await page.locator(form).getAttribute('action');
  const response = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === action);
  await page.locator(form).locator(button).click();
  const r = await response;
  assert.ok(r.status() < 400, `${action}: HTTP ${r.status()}`);
}
async function account(page, role) {
  const a = { role, email: `qa-${role}-${randomBytes(7).toString('hex')}@example.com`, password: randomBytes(24).toString('base64url') };
  manifest.accounts.push(a); checkpoint();
  await goto(page, `${BASE}/register`);
  await page.fill('#email', a.email); await page.fill('#password', a.password);
  await submit(page, 'form[action="/register"]');
  await goto(page, `${BASE}/mine`); await live(page);
  return a;
}
async function login(page, a) {
  await goto(page, `${BASE}/login`);
  await page.fill('#email', a.email); await page.fill('#password', a.password);
  await submit(page, 'form[action="/login"]');
  await goto(page, `${BASE}/mine`); await live(page);
}
async function fillMoveout(page, title) {
  await goto(page, `${BASE}/mine`); await live(page);
  await page.fill('#title', title); await page.fill('#area', 'QA ONLY — not a real listing');
  await page.fill('#pickupLocation', 'QA fictitious pickup door — DO NOT VISIT');
  await page.fill('#deadline', localTime(144)); await page.fill('#nickname', 'QA mover');
  await page.check('input[name="visibility"][value="unlisted"]');
}
// Timestamp the real submit in the actor's renderer. MutationObserver + two RAFs
// measures the receiver's visible DOM after a paint opportunity, not an SSE packet.
// Both Chrome contexts run on one host; epoch clocks use performance.timeOrigin.
async function measure(actor, receiver, label, form, selector, contains = '', button) {
  await live(receiver);
  let started;
  const handler = message => {
    const text = message.text();
    if (text.startsWith('QA_SUBMIT_TIME:')) started = Number(text.slice(15));
  };
  actor.on('console', handler);
  const navigationCount = { value: 0 };
  const navigated = frame => { if (frame === receiver.mainFrame()) navigationCount.value++; };
  receiver.on('framenavigated', navigated);
  await receiver.evaluate(({ selector, contains }) => {
    const matches = () => [...document.querySelectorAll(selector)].some(el =>
      el.checkVisibility() && el.textContent.includes(contains));
    if (matches()) throw new Error('Timing precondition already true');
    window.__qaTiming = { result: null };
    let seen = false;
    const observer = new MutationObserver(() => {
      if (!seen && matches()) {
        seen = true;
        const domAt = performance.timeOrigin + performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (matches()) window.__qaTiming.result = { domAt, paintedAt: performance.timeOrigin + performance.now() };
          else window.__qaTiming.result = { error: 'Expected state disappeared before paint' };
          observer.disconnect();
        }));
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    window.__qaTiming.observer = observer;
  }, { selector, contains });
  await actor.evaluate(form => {
    const listener = e => {
      if (e.target.matches(form)) {
        console.log('QA_SUBMIT_TIME:' + (performance.timeOrigin + performance.now()));
        document.removeEventListener('submit', listener, true);
      }
    };
    document.addEventListener('submit', listener, true);
  }, form);
  try {
    await submit(actor, form, button);
    await receiver.waitForFunction(() => window.__qaTiming?.result, null, { timeout: 15000 });
    const result = await receiver.evaluate(() => window.__qaTiming.result);
    assert.ok(!result.error, result.error);
    assert.ok(Number.isFinite(started), 'Submit timestamp must be captured');
    const ms = Math.round(result.paintedAt - started);
    assert.ok(ms >= 0, 'Renderer clocks must be comparable');
    assert.equal(navigationCount.value, 0, 'Receiver must not navigate/reload');
    const sample = { label, actorViewport: actor.viewportSize(), receiverViewport: receiver.viewportSize(),
      ms, domMs: Math.round(result.domAt - started), receiverReloads: navigationCount.value };
    samples.push(sample); checkpoint();
    console.log(`${label}: ${ms} ms${ms > 1500 ? ' (above 1500 ms)' : ''}`);
    return sample;
  } finally {
    actor.off('console', handler); receiver.off('framenavigated', navigated);
    await receiver.evaluate(() => window.__qaTiming?.observer?.disconnect()).catch(() => {});
  }
}
async function prepare() {
  for (let direction = 0; direction < 2; direction++) {
    const ownerCtx = await browser.newContext({ viewport: sizes[direction] });
    const claimantCtx = await browser.newContext({ viewport: sizes[1 - direction] });
    const otherCtx = await browser.newContext({ viewport: sizes[1 - direction] });
    for (const ctx of [ownerCtx, claimantCtx, otherCtx]) {
      ctx.setDefaultTimeout(15000); ctx.setDefaultNavigationTimeout(20000);
    }
    const owner = await ownerCtx.newPage(), claimant = await claimantCtx.newPage(), other = await otherCtx.newPage();
    const moverAccount = await account(owner, `owner${direction}`);
    const claimantAccount = await account(claimant, `claimant${direction}`);
    await login(other, moverAccount);
    let primary;
    for (let repetition = 0; repetition < 3; repetition++) {
      const title = `ZZZ-TEST-${stamp.slice(0,10)}-${direction}-${repetition}-DO-NOT-USE`;
      await fillMoveout(owner, title);
      await measure(owner, other, `cross-device page ${direction}/${repetition}`, 'form[action="/moveouts"]', '[data-live-list="my-moveouts"] a', title);
      await owner.waitForURL('**/manage'); await live(owner);
      const record = { title, manageUrl: owner.url(), publicUrl: owner.url().replace(/\/manage$/, ''), moverEmail: moverAccount.email, claimantEmail: claimantAccount.email };
      manifest.pages.push(record); checkpoint();
      assert.equal(await owner.locator('[data-visibility]').getAttribute('data-visibility'), 'unlisted');
      if (repetition === 0) primary = record;
    }
    await goto(owner, primary.manageUrl); await live(owner);
    for (const hours of [72, 96]) {
      await owner.fill('#slotStart', localTime(hours)); await owner.fill('#slotEnd', localTime(hours + 1));
      await submit(owner, 'form[action$="/timeslots"]'); await owner.waitForTimeout(300);
    }
    // A real PNG with a visible QA label, used for byte-for-byte persistence checks.
    const photo = Buffer.from(await owner.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const c = canvas.getContext('2d'); c.fillStyle = '#f0e4ce'; c.fillRect(0, 0, 320, 180);
      c.fillStyle = '#222'; c.font = '24px sans-serif'; c.fillText('MoveOut QA ONLY', 30, 80);
      c.font = '16px sans-serif'; c.fillText('Not a real item', 30, 115);
      return canvas.toDataURL('image/png').split(',')[1];
    }), 'base64');
    primary.photoSha256 = sha(photo);
    primary.items = [];
    for (let repetition = 0; repetition < 3; repetition++) {
      const name = `QA ${direction}/${repetition} — DO NOT COLLECT`;
      await owner.fill('#itemName', name); await owner.selectOption('#itemCategory', 'Other');
      if (repetition === 0) await owner.setInputFiles('#itemPhoto', { name: 'qa-only.png', mimeType: 'image/png', buffer: photo });
      await submit(owner, 'form[action$="/items"]');
      const item = owner.locator('li[data-item-id]').filter({ has: owner.locator('.item-name', { hasText: name }) });
      await item.waitFor();
      const id = await item.getAttribute('data-item-id');
      if (repetition === 0) primary.photoUrl = new URL(await item.locator('img').getAttribute('src'), BASE).href;
      await goto(claimant, primary.publicUrl); await live(claimant);
      const card = claimant.locator(`li[data-item-id="${id}"]`);
      await card.locator('summary').click(); await card.locator('[name="nickname"]').fill(`QA claimant ${repetition}`);
      await item.evaluate(el => el.scrollIntoView({ block: 'center' }));
      await measure(claimant, owner, `apply ${direction}/${repetition}`, `form[action$="/apply"]:has(input[value="${id}"])`, `[data-item-id="${id}"] .applicant-row`, `QA claimant ${repetition}`);
      const appId = await item.locator('.applicant-row').getAttribute('data-application-id');
      const appSelector = `.pickup-card[data-application-id="${appId}"]`;
      await claimant.locator(`li[data-application-id="${appId}"]`).waitFor();
      await claimant.locator(`li[data-application-id="${appId}"]`).evaluate(el => el.scrollIntoView({ block: 'center' }));
      await measure(owner, claimant, `confirm ${direction}/${repetition}`, `form[action="/applications/${appId}/confirm"]`, `${appSelector} [data-pickup-spot]`, 'QA fictitious');
      await owner.locator(appSelector).waitFor(); await owner.locator(appSelector).evaluate(el => el.scrollIntoView({ block: 'center' }));
      await measure(claimant, owner, `departure ${direction}/${repetition}`, `form[action="/applications/${appId}/departure"]:has(input[value="departed"])`, `${appSelector} [data-departure-status-text]`, 'On the way');
      const ownerCard = owner.locator(appSelector);
      await ownerCard.locator('summary').click();
      const reason = `QA timing ${direction}/${repetition}`;
      await ownerCard.locator('[name="reason"]').fill(reason);
      await measure(owner, claimant, `propose ${direction}/${repetition}`, `form[action="/applications/${appId}/reschedule"]`, `${appSelector} .reschedule-pending`, reason);
      const proposalId = await claimant.locator(`${appSelector} [data-reschedule-id]`).getAttribute('data-reschedule-id');
      const before = await ownerCard.locator('[data-pickup-facts]').innerText();
      // Match the new confirmed time, not merely removal of the proposal controls.
      const claimantPending = await claimant.locator(`${appSelector} .reschedule-pending .item-meta`).innerText();
      const targetTime = claimantPending.split(' to ')[1].split(' — ')[0].trim();
      await ownerCard.locator('details').evaluateAll(elements => elements.forEach(el => { el.open = false; el.querySelectorAll('input').forEach(input => { input.value = ''; }); }));
      await owner.locator('h1').click();
      await measure(claimant, owner, `accept ${direction}/${repetition}`, `form[action="/reschedule/${proposalId}/accept"]`, `${appSelector} [data-pickup-facts]`, targetTime);
      assert.notEqual(await ownerCard.locator('[data-pickup-facts]').innerText(), before);
      primary.items.push({ id, name, appId }); checkpoint();
    }
    // Leave one pending proposal overnight so tomorrow can prove a real authorised write.
    const appId = primary.items[0].appId;
    await goto(owner, primary.manageUrl); await live(owner);
    const card = owner.locator(`.pickup-card[data-application-id="${appId}"]`);
    await card.locator('summary').click();
    await card.locator('[name="reason"]').fill('QA overnight persistence — accept only on follow-up');
    await submit(owner, `form[action="/applications/${appId}/reschedule"]`);
    await card.locator('[data-reschedule-id]').waitFor();
    primary.pendingProposalId = await card.locator('[data-reschedule-id]').getAttribute('data-reschedule-id');
    await goto(owner, primary.manageUrl); await live(owner);
    primary.baselineFacts = {};
    for (const item of primary.items) primary.baselineFacts[item.appId] = await owner.locator(`.pickup-card[data-application-id="${item.appId}"] [data-pickup-facts]`).innerText();
    const photoResponse = await ownerCtx.request.get(primary.photoUrl);
    assert.equal(photoResponse.status(), 200); assert.equal(sha(await photoResponse.body()), primary.photoSha256);
    for (const [role, ctx] of [[`owner${direction}`, ownerCtx], [`claimant${direction}`, claimantCtx]]) save(`${role}-session.json`, await ctx.storageState());
    primary.ownerSession = `owner${direction}-session.json`; primary.claimantSession = `claimant${direction}-session.json`;
    checkpoint();
    await owner.screenshot({ path: join(directory, `baseline-${direction}.png`), fullPage: true });
    await ownerCtx.close(); await claimantCtx.close(); await otherCtx.close();
  }
  const anonymous = await browser.newContext();
  for (const page of manifest.pages) {
    const r = await anonymous.request.get(`${BASE}/?q=${encodeURIComponent(page.title)}`);
    assert.equal(r.status(), 200); assert.ok(!(await r.text()).includes(new URL(page.publicUrl).pathname));
  }
  await anonymous.close();
  manifest.readyAt = new Date().toISOString(); checkpoint();
  console.log(`READY: ${directory}`);
}
async function check() {
  assert.ok(manifest.readyAt, 'Baseline preparation must have completed');
  assert.ok(!manifest.verifiedAt, 'Already verified; do not repeat the follow-up write');
  assert.notEqual(new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(manifest.readyAt)), new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date()), 'Run on a later Sydney calendar day');
  const report = { checkedAt: new Date().toISOString(), baselineAt: manifest.readyAt, checks: [] };
  for (const record of manifest.pages.filter(p => p.items)) {
    const ctx = await browser.newContext({ storageState: load(record.ownerSession) });
    const owner = await ctx.newPage();
    assert.equal((await goto(owner, record.manageUrl)).status(), 200); await live(owner);
    assert.equal(await owner.locator('[data-visibility]').getAttribute('data-visibility'), 'unlisted');
    for (const item of record.items) {
      assert.equal(await owner.locator(`.pickup-card[data-application-id="${item.appId}"] [data-pickup-facts]`).innerText(), record.baselineFacts[item.appId]);
    }
    const photo = await ctx.request.get(record.photoUrl);
    assert.equal(photo.status(), 200); assert.equal(sha(await photo.body()), record.photoSha256);
    report.checks.push(`${record.title}: original owner session, all confirmed arrangements and photo SHA-256 unchanged`);
    const claimantCtx = await browser.newContext({ storageState: load(record.claimantSession) });
    const claimant = await claimantCtx.newPage();
    await goto(claimant, record.publicUrl); await live(claimant);
    await claimant.locator(`form[action="/reschedule/${record.pendingProposalId}/accept"]`).waitFor();
    const freshCtx = await browser.newContext(); const fresh = await freshCtx.newPage();
    await login(fresh, manifest.accounts.find(a => a.email === record.moverEmail));
    for (const p of manifest.pages.filter(p => p.moverEmail === record.moverEmail)) await fresh.locator(`a[href="${new URL(p.manageUrl).pathname}"]`).waitFor();
    const freshClaimantCtx = await browser.newContext(); const freshClaimant = await freshClaimantCtx.newPage();
    await login(freshClaimant, manifest.accounts.find(a => a.email === record.claimantEmail));
    for (const item of record.items) await freshClaimant.locator(`[data-application-id="${item.appId}"]`).waitFor();
    report.checks.push(`${record.title}: fresh browser login recovers owner pages and claimant requests`);
    await submit(claimant, `form[action="/reschedule/${record.pendingProposalId}/accept"]`);
    await claimant.waitForFunction(id => !document.querySelector(`[data-reschedule-id="${id}"]`), record.pendingProposalId);
    await goto(owner, record.manageUrl); await live(owner);
    assert.notEqual(await owner.locator(`.pickup-card[data-application-id="${record.items[0].appId}"] [data-pickup-facts]`).innerText(), record.baselineFacts[record.items[0].appId]);
    report.checks.push(`${record.title}: original claimant session successfully accepts overnight proposal; owner sees changed confirmed time`);
    const anon = await browser.newContext(); const visitor = await anon.newPage();
    assert.equal((await goto(visitor, record.manageUrl)).status(), 403);
    await goto(visitor, record.publicUrl);
    assert.ok(!(await visitor.locator('body').innerText()).includes('QA fictitious pickup door'));
    for (const p of manifest.pages.filter(p => p.moverEmail === record.moverEmail)) {
      const r = await anon.request.get(`${BASE}/?q=${encodeURIComponent(p.title)}`);
      assert.ok(!(await r.text()).includes(new URL(p.publicUrl).pathname));
    }
    report.checks.push(`${record.title}: still absent from Browse; anonymous viewer cannot manage or see exact pickup location`);
    await owner.screenshot({ path: join(directory, `followup-${record.ownerSession}.png`), fullPage: true });
    await anon.close(); await freshCtx.close(); await freshClaimantCtx.close(); await claimantCtx.close(); await ctx.close();
    save('followup.json', report);
  }
  manifest.verifiedAt = report.checkedAt; save('manifest.json', manifest);
  console.log(JSON.stringify(report, null, 2));
}
async function selftest() {
  const a = await browser.newPage(), b = await browser.newPage();
  await a.route('https://timing.invalid/**', route => route.fulfill({ contentType: 'text/html', body: '<div id="connection-status" data-state="live">Live</div><form action="/go"><button type="submit">Go</button></form>' }));
  await a.goto('https://timing.invalid/');
  await b.setContent('<div id="connection-status" data-state="live">Live</div>');
  await a.route('https://timing.invalid/go', async route => {
    await new Promise(r => setTimeout(r, 120));
    await b.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p id="arrived">Arrived</p>'));
    await route.fulfill({ body: 'OK' });
  });
  await a.evaluate(() => { const f = document.querySelector('form'); f.method = 'post'; });
  const sample = await measure(a, b, 'timing self-check (120ms delay)', 'form', '#arrived', 'Arrived');
  assert.ok(sample.ms >= 120 && sample.ms < 1500);
  await assert.rejects(measure(a, b, 'reject existing state', 'form', '#arrived', 'Arrived'), /already true/);
  console.log('Timing self-check passed; no production requests made.');
}
try { await ({ prepare, check, selftest }[mode])(); }
finally { await browser.close(); }
