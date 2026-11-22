// End-to-end browser checks of the main user journeys.
// Builds nothing: run `npm run build` first. Starts the production server on a
// temporary SQLite database with demo data, then drives Chromium with Playwright.
//
//   npm run build && npm run test:e2e
//
// Needs the `playwright` package and a Chromium browser (`npx playwright install chromium`).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartet-e2e-'));
const PORT = 3217;
const base = `http://127.0.0.1:${PORT}`;
const EMAIL = 'owner@example.com';
const PASSWORD = 'correct horse battery';
const shots = process.env.E2E_SCREENSHOTS;

const server = spawn('node', ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `sqlite:${path.join(dir, 'e2e.db')}`, OWNER_EMAIL: EMAIL, OWNER_PASSWORD: PASSWORD, SEED_DEMO: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'production', SCHEDULER_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message.split('\n').join('\n    ')}`);
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

async function signIn(page) {
  await page.goto(base);
  await page.getByLabel('Email').fill(EMAIL);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('heading', { name: 'Discover', level: 1 }).waitFor();
}

async function noHorizontalScroll(page, label) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw + 1, `${label}: page scrolls horizontally (${sw} > ${cw})`);
}

await waitForServer();
const browser = await chromium.launch();
const errors = [];
try {
  const desktop = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/Bratislava' });
  const page = await desktop.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  console.log('Desktop');
  await step('private access: unauthenticated API is refused and the app asks to sign in', async () => {
    const r = await fetch(`${base}/api/events`);
    assert.equal(r.status, 401);
    const rr = await fetch(`${base}/api/research/v1/context`);
    assert.equal(rr.status, 401);
    await page.goto(base);
    await page.getByRole('heading', { name: 'Sign in' }).waitFor();
  });

  await step('sign in', () => signIn(page));

  await step('Highlights is the default and All events shows more', async () => {
    const hl = page.getByRole('radio', { name: /Highlights/ });
    assert.equal(await hl.getAttribute('aria-checked'), 'true');
    const nHl = await page.locator('.event-card').count();
    await page.getByRole('radio', { name: /All events/ }).click();
    await page.waitForFunction((n) => document.querySelectorAll('.event-card').length > n, nHl);
    assert.ok((await page.locator('.event-card').count()) > nHl);
    await page.getByText('Kolektiv Tide residents night (demo)').waitFor();
  });

  await step('combined filters: Bratislava + next weekend + drum and bass, with explicit dates', async () => {
    await page.getByLabel('Location').selectOption('bratislava');
    await page.getByRole('radio', { name: 'Next weekend' }).click();
    await page.locator('.range-label').filter({ hasText: /Fri \d+ – Sun \d+/ }).waitFor();
    await page.getByRole('button', { name: /Categories/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Categories' });
    await dialog.getByLabel('Drum and bass').check();
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.event-card h3')].every((h) => /Liquid Sessions/.test(h.textContent)) && document.querySelectorAll('.event-card').length === 1);
    assert.match(page.url(), /loc=bratislava/);
    assert.match(page.url(), /cats=dnb/);
    await page.getByRole('button', { name: 'Reset filters' }).click();
  });

  await step('search across events, artists, venues and cities', async () => {
    await page.getByLabel('Search events, artists, venues and cities').fill('wien');
    await page.getByRole('region', { name: 'Search suggestions' }).getByRole('button', { name: 'Vienna' }).click();
    await page.getByRole('heading', { name: 'Vienna', level: 1 }).waitFor();
    await page.getByLabel('Search events, artists, venues and cities').fill('Chase');
    await page.getByRole('region', { name: 'Search suggestions' }).getByRole('button', { name: /Chase & Status/ }).first().click();
    await page.getByRole('heading', { name: 'Chase & Status', level: 1 }).waitFor();
  });

  await step('keyboard: skip link, visible focus and arrow keys in the mode toggle', async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Discover', level: 1 }).waitFor();
    await page.keyboard.press('Tab');
    const skip = await page.evaluate(() => document.activeElement?.textContent);
    assert.equal(skip, 'Skip to content');
    const outline = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
    assert.notEqual(outline, 'none', 'focused element shows an outline');
    await page.getByRole('radio', { name: /Highlights/ }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('radio', { name: /All events/, checked: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.startsWith('All events')), true, 'focus follows the selection');
    // Cards are reachable by Tab and open with Enter.
    await page.locator('.event-card a.stretched').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Your plans' }).waitFor();
  });

  let liquidUrl;
  await step('event detail: set Going and private notes', async () => {
    await page.goto(`${base}/?mode=all`);
    await page.getByRole('link', { name: 'Liquid Sessions (demo)' }).click();
    await page.getByRole('heading', { name: 'Liquid Sessions (demo)' }).waitFor();
    liquidUrl = page.url();
    await page.getByText('22:00 – 05:00 (next day)').first().waitFor();
    await page.getByRole('radio', { name: 'Going' }).click();
    await page.waitForFunction(() => document.querySelector('[role=radio][aria-checked=true]')?.textContent === 'Going');
    await page.getByLabel('Private notes').fill('Meet Jana by the bar at 23:30');
    await page.getByRole('heading', { name: 'Lineup' }).click(); // blur saves
    await page.getByText('Saved', { exact: true }).waitFor();
  });

  await step('saved status and notes are the same on another device', async () => {
    const phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en-GB' });
    const p2 = await phoneCtx.newPage();
    await signIn(p2);
    await p2.goto(liquidUrl);
    await p2.getByLabel('Private notes').waitFor();
    assert.equal(await p2.getByLabel('Private notes').inputValue(), 'Meet Jana by the bar at 23:30');
    assert.equal(await p2.getByRole('radio', { name: 'Going' }).getAttribute('aria-checked'), 'true');
    await p2.goto(`${base}/?mode=all`);
    const card = p2.locator('.event-card', { hasText: 'Liquid Sessions (demo)' });
    await card.getByText('Going').waitFor();
    await phoneCtx.close();
  });

  await step('watchlist: add, pause and remove an artist through the interface', async () => {
    await page.goto(`${base}/artists`);
    await page.getByRole('button', { name: 'Add artist' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add an artist' });
    await dlg.getByLabel('Artist name').fill('Test Artist E2E');
    await dlg.getByLabel('Aliases').fill('TAE, Test A.');
    await dlg.getByLabel('Identifying links').fill('official: https://test-artist.example');
    await dlg.getByRole('button', { name: 'Add to watchlist' }).click();
    const card = page.locator('.artist-card', { hasText: 'Test Artist E2E' });
    await card.waitFor();
    await card.getByRole('button', { name: /Pause tracking Test Artist E2E/ }).click();
    await card.getByText('Paused — not being tracked').waitFor();
    await page.reload();
    await page.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByText('Paused — not being tracked').waitFor();
    page.once('dialog', (d) => d.accept());
    await page.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByRole('button', { name: /Remove Test Artist E2E/ }).click();
    await page.locator('.artist-card', { hasText: 'Test Artist E2E' }).waitFor({ state: 'detached' });
  });

  await step('European artist dates and festival associations', async () => {
    await page.goto(`${base}/festivals?scope=europe&followed=1`);
    await page.locator('.festival-card', { hasText: 'Costa Bloom' }).getByText('Maribou State').waitFor();
    const fest = page.locator('.festival-card', { hasText: 'Danube Pulse' });
    await fest.getByText('Chase & Status').waitFor();
    await fest.getByText(/Live show/).first().waitFor();
    await page.getByRole('radio', { name: 'Nearby' }).click();
    await page.locator('.festival-card', { hasText: 'Costa Bloom' }).waitFor({ state: 'detached' });
  });

  await step('quick booking: enter an already-booked Chase & Status show', async () => {
    await page.goto(`${base}/artists`);
    await page.locator('.artist-card', { hasText: 'Chase & Status' }).getByRole('link', { name: /already booked/ }).click();
    await page.getByLabel('Artist').first().waitFor();
    assert.equal(await page.locator('select').first().evaluate((s) => s.selectedOptions[0].textContent), 'Chase & Status');
    await page.getByLabel('Date', { exact: true }).fill('2026-12-12');
    await page.getByLabel('Start time (if known)').fill('20:00');
    await page.getByLabel('Venue', { exact: true }).fill('Example Arena');
    await page.getByLabel('Town or city').fill('Prague');
    await page.getByLabel('Country').selectOption('CZ');
    await page.getByLabel('Ticket provider').fill('Ticketmaster');
    await page.getByLabel('Booking reference').fill('CS-4471');
    await page.getByLabel('Amount paid').fill('1290');
    await page.locator('select').filter({ hasText: 'EUR' }).selectOption('CZK');
    await page.getByRole('button', { name: 'Save booking' }).click();
    await page.getByRole('heading', { name: 'Chase & Status', level: 1 }).waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Tickets booked' }).getAttribute('aria-checked'), 'true');
    await page.getByText('Ref: CS-4471').waitFor();
    await page.getByText('Europe/Prague (CET)').waitFor();
  });

  await step('personal plan and calendar clash, keeping both', async () => {
    await page.goto(`${base}/calendar`);
    const iso = await page.evaluate(async () => (await (await fetch('/api/events?mode=all&scope=any&q=Liquid')).json()).items[0].start_local.slice(0, 10));
    const dlg = page.getByRole('dialog', { name: 'Add a personal plan' });
    await page.getByRole('button', { name: 'Add plan' }).click();
    await dlg.getByLabel('What').fill('Birthday dinner');
    await dlg.getByLabel('Date', { exact: true }).fill(iso);
    await dlg.getByLabel('Start time').fill('21:00');
    await dlg.getByLabel('End time').fill('23:30');
    await dlg.getByRole('button', { name: 'Save plan' }).click();
    const panel = page.locator('.clash-panel');
    await panel.getByText('Times overlap').waitFor();
    await panel.getByRole('button', { name: 'Keep both' }).click();
    await panel.waitFor({ state: 'detached' });
    await page.locator('.agenda-row', { hasText: 'Birthday dinner' }).waitFor();
    await page.locator('.agenda-row', { hasText: 'Liquid Sessions' }).waitFor();
  });

  await step('calendar: Interested toggle, month view and ICS download', async () => {
    await page.goto(`${base}/?mode=all`);
    await page.getByRole('link', { name: /Halle Süd/ }).click();
    await page.getByRole('radio', { name: 'Interested' }).click();
    await page.waitForFunction(() => document.querySelector('[role=radio][aria-checked=true]')?.textContent === 'Interested');
    await page.goto(`${base}/calendar`);
    assert.equal(await page.locator('.agenda-row', { hasText: 'Halle Süd' }).count(), 0);
    await page.getByText('Include Interested').click();
    await page.locator('.agenda-row', { hasText: 'Halle Süd' }).waitFor();
    await page.getByRole('radio', { name: 'Month' }).click();
    await page.locator('.month-grid').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download .ics/ }).click()]);
    const file = await download.path();
    const ics = fs.readFileSync(file, 'utf8');
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Liquid Sessions \(demo\)/);
    assert.match(ics, /SUMMARY:Birthday dinner|SUMMARY:\(Interested\)/);
  });

  await step('Ibiza: holiday dates show only overlapping parties', async () => {
    await page.goto(`${base}/ibiza`);
    const season = await page.getByLabel('Season').inputValue();
    await page.locator('.event-card').first().waitFor();
    const total = await page.locator('.event-card').count();
    assert.ok(total >= 3);
    await page.getByLabel('Arrive').fill(`${season}-07-14`);
    await page.getByLabel('Leave').fill(`${season}-07-24`);
    await page.getByText(/with confirmed dates during your stay/).waitFor();
    await page.waitForFunction((t) => document.querySelectorAll('.event-card').length < t, total);
    const titles = await page.locator('.event-card h3').allTextContents();
    assert.ok(titles.every((t) => /Rebel Sundays \(demo\)|Bass Theory/.test(t)), titles.join(', '));
    await page.getByRole('radio', { name: /Residencies/ }).click();
    await page.getByText('Residency confirmed').first().waitFor();
    await page.getByText('Residency announced').first().waitFor();
    await page.getByRole('radio', { name: 'Week overview' }).click();
    await page.getByRole('table').getByText('Rebel Sundays').waitFor();
  });

  await step('accurate research status, Search now queues a real job, manual import works', async () => {
    await page.goto(`${base}/settings/research`);
    await page.getByText('Awaiting connection').waitFor();
    await page.getByRole('button', { name: 'Search now' }).first().click();
    await page.getByText(/no research service is connected yet/).waitFor();
    await page.getByRole('cell', { name: 'queued' }).first().waitFor().catch(async () => {
      await page.getByRole('button', { name: 'Refresh status' }).click();
      await page.locator('.badge', { hasText: 'queued' }).first().waitFor();
    });
    await page.getByLabel('Import JSON').fill(JSON.stringify({ events: [{ title: 'E2E Imported Night', start: '2027-01-15T22:00', timezone: 'Europe/Vienna', venue: { name: 'Test Hall', city: 'Vienna', country: 'AT' }, categories: ['techno'] }] }));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('1 created · 0 updated · 0 unchanged · 0 errors').waitFor();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('0 created · 0 updated · 1 unchanged · 0 errors').waitFor();
  });

  await step('notification status is shown accurately', async () => {
    await page.goto(`${base}/settings/notifications`);
    await page.getByText('Not configured').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send a test email' }).isDisabled(), true);
  });

  await step('add an event manually from the form', async () => {
    await page.goto(`${base}/add/event`);
    await page.getByLabel('Title').fill('Pottery evening');
    await page.getByLabel('Date', { exact: true }).fill('2027-02-03');
    await page.getByLabel('Start time').fill('18:00');
    await page.getByLabel('Finish time').fill('20:00');
    await page.getByLabel('Venue', { exact: true }).fill('Clay Studio');
    await page.getByLabel('Town or city').fill('Bratislava');
    await page.getByLabel('Workshops and activities').check();
    await page.getByRole('button', { name: 'Add event' }).click();
    await page.getByRole('heading', { name: 'Pottery evening', level: 1 }).waitFor();
    await page.getByText('Added by you').waitFor();
  });

  if (shots) await page.screenshot({ path: path.join(shots, 'e2e-desktop.png') });
  await desktop.close();

  console.log('Phone');
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'en-GB', isMobile: true, hasTouch: true });
  const mp = await phone.newPage();
  mp.on('pageerror', (e) => errors.push(e.message));
  await step('mobile sign-in and bottom navigation', async () => {
    await signIn(mp);
    const nav = mp.getByRole('navigation', { name: 'Main navigation' }).last();
    for (const name of ['Cities', 'Festivals', 'Artists', 'Ibiza', 'Calendar', 'Discover']) {
      await nav.getByRole('link', { name }).click();
      await mp.waitForLoadState('networkidle');
      await noHorizontalScroll(mp, name);
    }
  });
  await step('mobile pages have no horizontal scrolling', async () => {
    for (const p of ['/?mode=all&range=custom&from=2026-11-01&to=2026-12-31', '/calendar?view=month', '/settings/research', '/settings/interests', '/add/event', '/updates']) {
      await mp.goto(base + p);
      await mp.waitForLoadState('networkidle');
      await noHorizontalScroll(mp, p);
    }
    await mp.goto(`${base}/?mode=all`);
    await mp.getByRole('link', { name: 'Liquid Sessions (demo)' }).click();
    await mp.getByRole('heading', { name: 'Your plans' }).waitFor();
    await noHorizontalScroll(mp, 'event detail');
  });
  if (shots) await mp.screenshot({ path: path.join(shots, 'e2e-phone.png') });
  await phone.close();

  await step('no JavaScript errors in the browser', async () => {
    const real = errors.filter((e) => !/Failed to load resource: the server responded with a status of 40[134]/.test(e));
    assert.deepEqual(real, []);
  });
} finally {
  await browser.close();
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
if (process.env.E2E_REPORT) fs.writeFileSync(process.env.E2E_REPORT, JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
