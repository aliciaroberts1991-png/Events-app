// End-to-end browser checks of the main user journeys (revised requirements).
// Separate browser contexts act as separate devices: central data (listings, followed
// artists, settings) must appear on both; personal data (favourites, plans, notes,
// bookings) must stay on the device unless exported and imported.
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
const PASSPHRASE = 'correct horse battery';
const shots = process.env.E2E_SCREENSHOTS;

const server = spawn('node', ['dist/server/index.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', DATABASE_URL: `sqlite:${path.join(dir, 'e2e.db')}`, EDITOR_PASSWORD: PASSPHRASE, SEED_DEMO: 'true', COOKIE_SECURE: 'false', NODE_ENV: 'production', SCHEDULER_ENABLED: 'false' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, error: e.message });
    console.log(`  ✗ ${name}\n    ${e.message.split('\n').slice(0, 8).join('\n    ')}`);
  }
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Server did not start:\n${serverLog}`);
}

async function unlock(page) {
  await page.goto(`${base}/settings/editing`);
  await page.getByRole('button', { name: 'Unlock editing' }).first().click();
  const dlg = page.getByRole('dialog', { name: 'Unlock editing' });
  await dlg.getByLabel('Editor passphrase').fill(PASSPHRASE);
  await dlg.getByRole('button', { name: 'Unlock' }).click();
  await page.getByText('Editing unlocked on this device').first().waitFor();
}

async function noHorizontalScroll(page, label) {
  const { sw, cw } = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert.ok(sw <= cw + 1, `${label}: page scrolls horizontally (${sw} > ${cw})`);
}

const apiAs = (page, method, url, body) =>
  page.evaluate(
    async ([m, u, b]) => {
      const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json', 'x-quartet-csrf': '1' }, body: b ? JSON.stringify(b) : undefined });
      return { status: r.status, body: await r.json().catch(() => null) };
    },
    [method, url, body],
  );

await waitForServer();
const browser = await chromium.launch();
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
};
try {
  const laptop = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-GB', timezoneId: 'Europe/Bratislava', acceptDownloads: true });
  const page = await laptop.newPage();
  watch(page);
  const phone = await browser.newContext({ viewport: { width: 375, height: 812 }, locale: 'en-GB', isMobile: true, hasTouch: true, acceptDownloads: true });
  const mp = await phone.newPage();
  watch(mp);

  console.log('Laptop');
  await step('browsing works without signing in', async () => {
    await page.goto(base);
    await page.getByRole('heading', { name: 'Discover', level: 1 }).waitFor();
    await page.locator('.event-card').first().waitFor();
    await page.goto(`${base}/artists`);
    await page.getByRole('heading', { name: 'Bicep' }).waitFor();
  });

  await step('protected endpoints refuse changes without the editor passphrase', async () => {
    assert.equal((await apiAs(page, 'POST', '/api/watchlist', { name: 'X' })).status, 401);
    assert.equal((await apiAs(page, 'PUT', '/api/preferences', { data: {}, version: 0 })).status, 401);
    assert.equal((await apiAs(page, 'POST', '/api/import', { events: [] })).status, 401);
    assert.equal((await fetch(`${base}/api/research/v1/context`)).status, 401);
    await page.getByText('Unlock editing to add, edit, pause or remove followed artists').waitFor();
  });

  await step('Highlights is the default and All events shows more', async () => {
    await page.goto(base);
    assert.equal(await page.getByRole('radio', { name: /Highlights/ }).getAttribute('aria-checked'), 'true');
    await page.locator('.event-card').first().waitFor();
    const n = await page.locator('.event-card').count();
    await page.getByRole('radio', { name: /All events/ }).click();
    await page.waitForFunction((x) => document.querySelectorAll('.event-card').length > x, n);
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
    await page.waitForFunction(() => document.querySelectorAll('.event-card').length === 1 && /Liquid Sessions/.test(document.querySelector('.event-card h3')?.textContent ?? ''));
    assert.match(page.url(), /loc=bratislava/);
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

  await step('keyboard: skip link, visible focus, arrow keys, Enter opens a card', async () => {
    await page.goto(base);
    await page.locator('.event-card').first().waitFor();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Skip to content');
    assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none');
    await page.getByRole('radio', { name: /Highlights/ }).focus();
    await page.keyboard.press('ArrowRight');
    await page.getByRole('radio', { name: /All events/, checked: true }).waitFor();
    await page.locator('.event-card a.stretched').first().focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Tickets' }).waitFor();
  });

  let liquidUrl;
  await step('favourite, Going and notes are saved on this device without signing in', async () => {
    await page.goto(`${base}/?mode=all`);
    await page.locator('.event-card', { hasText: 'Liquid Sessions (demo)' }).getByRole('button', { name: /Add Liquid Sessions/ }).click();
    await page.getByRole('link', { name: 'Liquid Sessions (demo)' }).click();
    liquidUrl = page.url();
    await page.getByText('22:00 – 05:00 (next day)').first().waitFor();
    // Planning is secondary: it sits in a collapsed section until used.
    assert.equal(await page.getByRole('radio', { name: 'Going' }).isVisible(), false);
    await page.getByText('Plans, notes and bookings').click();
    await page.getByRole('radio', { name: 'Going' }).click();
    await page.getByLabel('Private notes').fill('Meet Jana by the bar at 23:30');
    await page.getByRole('heading', { name: 'Lineup' }).click();
    await page.getByText('Saved on this device', { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel('Private notes').waitFor();
    assert.equal(await page.getByLabel('Private notes').inputValue(), 'Meet Jana by the bar at 23:30');
    assert.equal(await page.getByRole('radio', { name: 'Going' }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('button', { name: 'Favourite', exact: true }).getAttribute('aria-pressed'), 'true');
  });

  await step('hide an event: gone from Discover, listed under My plans → Hidden', async () => {
    await page.goto(`${base}/?mode=all`);
    await page.getByRole('link', { name: 'Kolektiv Tide residents night (demo)' }).click();
    await page.getByRole('button', { name: 'Hide this event' }).click();
    await page.goto(`${base}/?mode=all`);
    await page.locator('.event-card').first().waitFor();
    assert.equal(await page.getByText('Kolektiv Tide residents night (demo)').count(), 0);
    await page.goto(`${base}/plans?tab=hidden`);
    await page.getByText('Kolektiv Tide residents night (demo)').waitFor();
  });

  await step('unlock editing with the passphrase; add and pause a followed artist', async () => {
    await unlock(page);
    await page.goto(`${base}/artists`);
    await page.getByRole('button', { name: 'Add artist' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add an artist' });
    await dlg.getByLabel('Artist name').fill('Test Artist E2E');
    await dlg.getByLabel('Aliases').fill('TAE');
    await dlg.getByLabel('Identifying links').fill('official: https://test-artist.example');
    await dlg.getByRole('button', { name: 'Add to watchlist' }).click();
    const card = page.locator('.artist-card', { hasText: 'Test Artist E2E' });
    await card.waitFor();
    await card.getByRole('button', { name: /Pause tracking Test Artist E2E/ }).click();
    await card.getByText('Paused — not being tracked').waitFor();
  });

  console.log('Phone (a second device)');
  await step('the phone sees the laptop’s artist change, and it reaches scheduled research', async () => {
    await mp.goto(`${base}/artists`);
    await mp.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByText('Paused — not being tracked').waitFor();
    const tok = await apiAs(page, 'POST', '/api/research-tokens', { name: 'e2e' });
    const readCtx = async () => (await fetch(`${base}/api/research/v1/context`, { headers: { authorization: `Bearer ${tok.body.token}` } })).json();
    let ctx = await readCtx();
    assert.ok(ctx.watchlist.paused.some((a) => a.name === 'Test Artist E2E'));
    await unlock(mp);
    await mp.goto(`${base}/artists`);
    await mp.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByRole('button', { name: /Resume tracking/ }).click();
    await mp.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByRole('button', { name: /Pause tracking/ }).waitFor();
    ctx = await readCtx();
    assert.ok(ctx.watchlist.active.some((a) => a.name === 'Test Artist E2E'));
    await page.goto(`${base}/artists`);
    page.once('dialog', (d) => d.accept());
    await page.locator('.artist-card', { hasText: 'Test Artist E2E' }).getByRole('button', { name: /Remove Test Artist E2E/ }).click();
    await page.locator('.artist-card', { hasText: 'Test Artist E2E' }).waitFor({ state: 'detached' });
  });

  await step('personal data stays on its device; export and import copies it across', async () => {
    await mp.goto(liquidUrl);
    await mp.getByRole('heading', { name: 'Tickets' }).waitFor();
    assert.equal(await mp.getByRole('button', { name: 'Add to favourites' }).getAttribute('aria-pressed'), 'false');
    await page.goto(`${base}/settings/device`);
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Export this device/ }).click()]);
    const file = await dl.path();
    await mp.goto(`${base}/settings/device`);
    await mp.locator('input[type=file]').setInputFiles(file);
    await mp.getByText(/Saved events: [1-9]\d* new/).waitFor();
    await mp.getByRole('button', { name: 'Merge into this device' }).click();
    await mp.goto(liquidUrl);
    await mp.getByLabel('Private notes').waitFor();
    assert.equal(await mp.getByLabel('Private notes').inputValue(), 'Meet Jana by the bar at 23:30');
    await mp.goto(`${base}/settings/device`);
    await mp.locator('input[type=file]').setInputFiles(file);
    await mp.getByText(/Saved events: 0 new, 0 to merge/).waitFor();
    await mp.getByRole('button', { name: 'Cancel' }).click();
  });

  console.log('Laptop');
  await step('European artist dates and festival associations', async () => {
    await page.goto(`${base}/festivals?scope=europe&followed=1`);
    await page.locator('.festival-card', { hasText: 'Costa Bloom' }).getByText('Maribou State').waitFor();
    await page.locator('.festival-card', { hasText: 'Danube Pulse' }).getByText('Chase & Status').waitFor();
    await page.getByRole('radio', { name: 'Nearby' }).click();
    await page.locator('.festival-card', { hasText: 'Costa Bloom' }).waitFor({ state: 'detached' });
  });

  await step('enter an already-booked Chase & Status show (kept on this device)', async () => {
    await page.goto(`${base}/artists`);
    await page.locator('.artist-card', { hasText: 'Chase & Status' }).getByRole('link', { name: /already booked/ }).click();
    await page.waitForFunction(() => (document.querySelector('input[list=followed-artists]')?.value ?? '') === 'Chase & Status');
    await page.getByLabel('Date', { exact: true }).fill('2026-12-12');
    await page.getByLabel('Start time (if known)').fill('20:00');
    await page.getByLabel('Venue', { exact: true }).fill('Example Arena');
    await page.getByLabel('Town or city').fill('Prague');
    await page.getByLabel('Country').selectOption('CZ');
    await page.getByLabel('Ticket provider').fill('Ticketmaster');
    await page.getByLabel('Booking reference').fill('CS-4471');
    await page.getByLabel('Amount paid').fill('1290');
    await page.getByRole('button', { name: 'Save booking' }).click();
    await page.getByRole('heading', { name: 'Chase & Status', level: 1 }).waitFor();
    await page.getByText('Ref: CS-4471').waitFor();
    assert.equal(await page.getByRole('radio', { name: 'Tickets booked' }).getAttribute('aria-checked'), 'true');
  });

  await step('personal plan and calendar clash, keeping both', async () => {
    const iso = await page.evaluate(async () => (await (await fetch('/api/events?mode=all&scope=any&q=Liquid')).json()).items[0].start_local.slice(0, 10));
    await page.goto(`${base}/plans?tab=calendar`);
    await page.getByRole('button', { name: 'Add plan' }).click();
    const dlg = page.getByRole('dialog', { name: 'Add a personal plan' });
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
    await page.locator('.agenda-row', { hasText: 'Chase & Status' }).waitFor();
  });

  await step('calendar: Interested toggle, month view and ICS download', async () => {
    await page.goto(`${base}/?mode=all`);
    await page.getByRole('link', { name: /Halle Süd/ }).click();
    await page.getByText('Plans, notes and bookings').click();
    await page.getByRole('radio', { name: 'Interested' }).click();
    await page.goto(`${base}/plans?tab=calendar`);
    await page.locator('.agenda-row').first().waitFor();
    assert.equal(await page.locator('.agenda-row', { hasText: 'Halle Süd' }).count(), 0);
    await page.getByText('Include Interested').click();
    await page.locator('.agenda-row', { hasText: 'Halle Süd' }).waitFor();
    await page.getByRole('radio', { name: 'Month' }).click();
    await page.locator('.month-grid').waitFor();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /Download .ics/ }).click()]);
    const ics = fs.readFileSync(await download.path(), 'utf8');
    assert.match(ics, /BEGIN:VCALENDAR/);
    assert.match(ics, /SUMMARY:Liquid Sessions \(demo\)/);
    assert.match(ics, /SUMMARY:Birthday dinner/);
    assert.match(ics, /SUMMARY:Chase & Status/);
  });

  await step('Ibiza: holiday dates show only overlapping parties; stays saved on this device', async () => {
    await page.goto(`${base}/ibiza`);
    const season = await page.getByLabel('Season').inputValue();
    await page.locator('.event-card').first().waitFor();
    const total = await page.locator('.event-card').count();
    await page.getByLabel('Arrive').fill(`${season}-07-14`);
    await page.getByLabel('Leave').fill(`${season}-07-24`);
    await page.getByText(/with confirmed dates during your stay/).waitFor();
    await page.waitForFunction((t) => document.querySelectorAll('.event-card').length < t, total);
    const titles = await page.locator('.event-card h3').allTextContents();
    assert.ok(titles.every((t) => /Rebel Sundays \(demo\)|Bass Theory/.test(t)), titles.join(', '));
    await page.getByRole('button', { name: 'Save these dates' }).click();
    await page.locator('.stay-list').waitFor();
    await page.getByRole('radio', { name: /Residencies/ }).click();
    await page.getByText('Residency confirmed').first().waitFor();
    await page.getByText('Residency announced').first().waitFor();
    await page.getByRole('radio', { name: 'Week overview' }).click();
    await page.getByRole('table').getByText('Rebel Sundays').waitFor();
  });

  await step('accurate research status; Search now queues a real job; manual import', async () => {
    await page.goto(`${base}/settings/research`);
    // A token was used earlier in this test, so the status is "Connected", not yet "Operational".
    await page.getByText('Connected — no research run completed yet').waitFor();
    await page.getByRole('button', { name: 'Search now' }).first().click();
    await page.getByText(/Search queued\. Results appear when the research service picks it up/).waitFor();
    await page.getByLabel('Import JSON').fill(JSON.stringify({ events: [{ title: 'E2E Imported Night', start: '2027-01-15T22:00', timezone: 'Europe/Vienna', venue: { name: 'Test Hall', city: 'Vienna', country: 'AT' }, categories: ['techno'] }] }));
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('1 created · 0 updated · 0 unchanged · 0 errors').waitFor();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByText('0 created · 0 updated · 1 unchanged · 0 errors').waitFor();
  });

  await step('a shared listing added on the laptop appears on the phone', async () => {
    await page.goto(`${base}/add/listing`);
    await page.getByLabel('Title').fill('Pottery evening');
    await page.getByLabel('Date', { exact: true }).fill('2027-02-03');
    await page.getByLabel('Start time').fill('18:00');
    await page.getByLabel('Finish time').fill('20:00');
    await page.getByLabel('Venue', { exact: true }).fill('Clay Studio');
    await page.getByLabel('Town or city').fill('Bratislava');
    await page.getByLabel('Workshops and activities').check();
    await page.getByRole('button', { name: 'Add event' }).click();
    await page.getByRole('heading', { name: 'Pottery evening', level: 1 }).waitFor();
    await mp.goto(`${base}/?mode=all&range=custom&from=2027-02-03&to=2027-02-03`);
    await mp.getByText('Pottery evening').waitFor();
  });

  await step('notification status is shown accurately', async () => {
    await page.goto(`${base}/settings/notifications`);
    await page.getByText('Not configured').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Send a test email' }).isDisabled(), true);
  });
  if (shots) await page.screenshot({ path: path.join(shots, 'e2e-desktop.png') });

  console.log('Phone layout');
  await step('mobile: five discovery tabs, My plans in the header, no horizontal scrolling', async () => {
    await mp.goto(base);
    const nav = mp.getByRole('navigation', { name: 'Main navigation' }).last();
    assert.equal(await nav.getByRole('link').count(), 5);
    for (const name of ['Cities', 'Festivals', 'Artists', 'Ibiza', 'Discover']) {
      await nav.getByRole('link', { name }).click();
      await mp.waitForLoadState('networkidle');
      await noHorizontalScroll(mp, name);
    }
    await mp.getByRole('link', { name: 'My plans' }).click();
    await mp.getByRole('heading', { name: 'My plans' }).waitFor();
    for (const p of ['/?mode=all&range=custom&from=2026-11-01&to=2026-12-31', '/plans?tab=calendar&view=month', '/settings/research', '/settings/device', '/add/booking', '/updates', liquidUrl.replace(base, '')]) {
      await mp.goto(base + p);
      await mp.waitForLoadState('networkidle');
      await noHorizontalScroll(mp, p);
    }
  });
  await step('mobile: secondary filters collapse behind a Filters button', async () => {
    await mp.goto(base);
    await mp.locator('.event-card').first().waitFor();
    assert.equal(await mp.getByRole('button', { name: /Categories/ }).isVisible(), false);
    await mp.getByRole('button', { name: /^Filters/ }).click();
    assert.equal(await mp.getByRole('button', { name: /Categories/ }).isVisible(), true);
  });
  if (shots) await mp.screenshot({ path: path.join(shots, 'e2e-phone.png') });

  await step('no JavaScript errors in the browser', async () => {
    const real = errors.filter((e) => !/Failed to load resource: the server responded with a status of 40[1349]/.test(e));
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
