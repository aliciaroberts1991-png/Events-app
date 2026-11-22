import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDemo } from '../../src/server/services/seed';
import { PASSPHRASE, samplePayload, setup, type TestEnv } from './helpers';

let env: TestEnv;
let ids: Record<string, string>;
beforeEach(async () => {
  env = await setup();
  const r = await env.research('POST', '/import', samplePayload());
  ids = Object.fromEntries(r.body.items.map((i: any) => [i.ref, i.id]));
});
afterEach(async () => {
  await env.close();
});

const titles = (body: any) => body.items.map((e: any) => e.title).sort();

describe('browsing without sign-in', () => {
  it('lists, filters, searches and opens events anonymously', async () => {
    const list = await env.anon('GET', '/api/events?mode=all');
    expect(list.status).toBe(200);
    expect(list.body.items.map((e: any) => e.title)).toEqual(expect.arrayContaining(['Roller Night', 'Ridge Hike', 'Summer Bass Festival 2027']));
    const detail = await env.anon('GET', `/api/events/${ids['festival']}`);
    expect(detail.body.artists.map((a: any) => a.name)).toEqual(expect.arrayContaining(['Chase & Status', 'Bicep']));
    expect(detail.body).not.toHaveProperty('bookings');
    expect(detail.body).not.toHaveProperty('state');
    for (const url of ['/api/artists', '/api/festivals?festival_scope=europe', '/api/ibiza?season=2027', '/api/cities', '/api/search?q=chase', '/api/status', '/api/feed', '/api/meta', '/api/watchlist']) {
      expect((await env.anon('GET', url)).status, url).toBe(200);
    }
  });

  it('never exposes the notification email address publicly', async () => {
    const full = await env.api('GET', '/api/preferences/full');
    full.body.data.notifications.email.address = 'me@example.com';
    await env.api('PUT', '/api/preferences', { data: full.body.data, version: full.body.version });
    const pub = await env.anon('GET', '/api/preferences');
    expect(JSON.stringify(pub.body)).not.toContain('me@example.com');
    expect(pub.body.data.notifications.email.address).toBe('(set)');
  });

  it('fetches a device’s saved events by id, with occurrences, including past and missing ones', async () => {
    const r = await env.anon('GET', `/api/events?ids=${ids['dnb-bratislava']},${ids['festival']},evt_gone&occurrences=1`);
    expect(r.body.items.map((e: any) => e.id).sort()).toEqual([ids['dnb-bratislava'], ids['festival']].sort());
    expect(r.body.missing).toEqual(['evt_gone']);
    expect(r.body.items[0].occurrences.length).toBeGreaterThan(0);
  });

  it('reports changes to given events since a time (for flags on saved events)', async () => {
    const since = new Date().toISOString();
    await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], start: '2026-12-05T22:00', end: '05:00', status: 'rescheduled' }] });
    const r = await env.anon('GET', `/api/changes?ids=${ids['dnb-bratislava']}&since=${since}`);
    expect(r.body.changes.map((c: any) => c.change_type)).toEqual(expect.arrayContaining(['date_changed', 'status_changed']));
  });
});

describe('protected editing of central data', () => {
  it('refuses writes without an unlocked editor session', async () => {
    const attempts: [string, string, unknown][] = [
      ['POST', '/api/watchlist', { name: 'Someone' }],
      ['PUT', '/api/preferences', { data: {}, version: 0 }],
      ['POST', '/api/runs', { type: 'adhoc' }],
      ['POST', '/api/import', { events: [] }],
      ['POST', '/api/research-tokens', { name: 'x' }],
      ['POST', '/api/events', { title: 'x', start: '2026-12-01', timezone: 'Europe/Bratislava' }],
      ['POST', '/api/demo', {}],
      ['PUT', '/api/priority-events', { device_id: 'device-12345', events: {} }],
    ];
    for (const [m, u, b] of attempts) expect((await env.anon(m, u, b)).status, `${m} ${u}`).toBe(401);
    expect((await env.anon('GET', '/api/research-tokens')).status).toBe(401);
    expect((await env.anon('GET', '/api/preferences/full')).status).toBe(401);
  });

  it('requires the CSRF header on writes', async () => {
    expect((await env.api('POST', '/api/watchlist', { name: 'X' }, { csrf: false })).status).toBe(403);
  });

  it('unlocks with the passphrase, throttles wrong guesses and locks again', async () => {
    const wrong = await env.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: '10.1.1.1', headers: { 'content-type': 'application/json', 'x-quartet-csrf': '1' }, payload: JSON.stringify({ password: 'nope' }) });
    expect(wrong.statusCode).toBe(401);
    let last = 0;
    for (let i = 0; i < 6; i++) {
      last = (await env.app.inject({ method: 'POST', url: '/api/auth/unlock', remoteAddress: '10.1.1.1', headers: { 'content-type': 'application/json', 'x-quartet-csrf': '1' }, payload: JSON.stringify({ password: 'nope' }) })).statusCode;
    }
    expect(last).toBe(429);
    const c = await env.login();
    expect((await env.api('GET', '/api/auth/state', undefined, { cookie: c })).body.editor).toBe(true);
    await env.api('POST', '/api/auth/lock', {}, { cookie: c });
    expect((await env.api('GET', '/api/auth/state', undefined, { cookie: c })).body.editor).toBe(false);
    expect((await env.api('POST', '/api/watchlist', { name: 'X' }, { cookie: c })).status).toBe(401);
  });

  it('keeps editing locked until a passphrase is configured, while browsing still works', async () => {
    const locked = await setup({ editorPassword: null });
    try {
      expect((await locked.anon('GET', '/api/auth/state')).body).toMatchObject({ editing_configured: false, editor: false });
      const r = await locked.app.inject({ method: 'POST', url: '/api/auth/unlock', headers: { 'content-type': 'application/json', 'x-quartet-csrf': '1' }, payload: JSON.stringify({ password: PASSPHRASE }) });
      expect(r.statusCode).toBe(409);
      expect((await locked.anon('GET', '/api/events')).status).toBe(200);
    } finally {
      await locked.close();
    }
  });
});

describe('central followed-artist list', () => {
  it('changes made on one device appear on another and in the research context', async () => {
    const phone = await env.login();
    const laptop = await env.login();
    await env.api('POST', '/api/watchlist', { name: 'New Artist', aliases: ['N.A.'], links: { official: 'https://new-artist.example' } }, { cookie: phone });
    const seen = (await env.api('GET', '/api/watchlist', undefined, { cookie: laptop })).body.artists;
    expect(seen.map((a: any) => a.name)).toContain('New Artist');
    expect((await env.anon('GET', '/api/watchlist')).body.artists.map((a: any) => a.name)).toContain('New Artist');
    const chase = seen.find((a: any) => a.name === 'Chase & Status');
    await env.api('PUT', `/api/watchlist/${chase.id}`, { status: 'paused' }, { cookie: laptop });
    const ctx = (await env.research('GET', '/context')).body;
    expect(ctx.watchlist.active.map((a: any) => a.name)).toEqual(expect.arrayContaining(['New Artist']));
    expect(ctx.watchlist.active.map((a: any) => a.name)).not.toContain('Chase & Status');
    expect(ctx.watchlist.paused.map((a: any) => a.name)).toContain('Chase & Status');
    // Paused artists no longer count as followed in highlights
    const ev = (await env.anon('GET', `/api/events/${ids['dnb-bratislava']}`)).body;
    expect(ev.artists[0].followed).toBe(false);
    await env.api('DELETE', `/api/watchlist/${chase.id}`, undefined, { cookie: phone });
    expect((await env.research('GET', '/context')).body.watchlist.paused).toHaveLength(0);
  });

  it('keeps similarly named acts apart when identifying links differ', async () => {
    await env.api('POST', '/api/watchlist', { name: 'Twin Name', links: { official: 'https://a.example' } });
    await env.api('POST', '/api/watchlist', { name: 'Twin Name', links: { official: 'https://b.example' } });
    expect((await env.anon('GET', '/api/watchlist')).body.artists.filter((a: any) => a.name === 'Twin Name')).toHaveLength(2);
    await env.api('POST', '/api/watchlist', { name: 'Goddard', links: { official: 'https://goddard.example' } });
    expect((await env.anon('GET', '/api/watchlist')).body.artists.filter((a: any) => a.name.startsWith('Goddard'))).toHaveLength(1);
  });

  it('central interest changes are versioned against concurrent edits', async () => {
    const prefs = (await env.api('GET', '/api/preferences/full')).body;
    prefs.data.categoryWeights.wine = 3;
    expect((await env.api('PUT', '/api/preferences', { data: prefs.data, version: prefs.version })).status).toBe(200);
    expect((await env.api('PUT', '/api/preferences', { data: prefs.data, version: prefs.version })).status).toBe(409);
  });
});

describe('combined filters (anonymous)', () => {
  it('Vienna, next weekend, food and drink', async () => {
    const r = await env.anon('GET', '/api/events?mode=all&hubs=vienna&nearby=0&range=next-weekend&categories=food-drink');
    expect(r.body.range.label).toBe('Fri 27 – Sun 29 Nov');
    expect(titles(r.body)).toEqual(['Vienna Wine Weekend']);
  });

  it('all four cities, this month, drum and bass', async () => {
    expect(titles((await env.anon('GET', '/api/events?mode=all&range=this-month&genres=dnb')).body)).toEqual(['Roller Night']);
  });

  it('English-language comedy by city', async () => {
    expect((await env.anon('GET', '/api/events?mode=all&hubs=bratislava&categories=english-comedy')).body.items).toHaveLength(0);
    expect(titles((await env.anon('GET', '/api/events?mode=all&hubs=prague&categories=english-comedy&english=1')).body)).toEqual(['English Comedy Night']);
  });

  it('nearby radius and the actual town', async () => {
    expect(titles((await env.anon('GET', '/api/events?mode=all&hubs=bratislava&nearby=0')).body)).not.toContain('Ridge Hike');
    const near = await env.anon('GET', '/api/events?mode=all&hubs=bratislava&nearby=1&radius=30');
    expect(near.body.items.find((e: any) => e.title === 'Ridge Hike')).toMatchObject({ city: 'Hainburg an der Donau', participation: 'participant' });
  });

  it('European festivals featuring an artist I follow', async () => {
    expect(titles((await env.anon('GET', '/api/festivals?festival_scope=europe&followed=1')).body)).toEqual(['Coastline Sounds 2027', 'Summer Bass Festival 2027']);
    const near = await env.anon('GET', '/api/festivals?festival_scope=nearby');
    expect(titles(near.body)).toEqual(['Summer Bass Festival 2027']);
    expect(near.body.items[0].artists.find((a: any) => a.name === 'Chase & Status')).toMatchObject({ date: '2027-07-10', format: 'live', followed: true });
  });

  it('multi-day overlap and overnight events belong to their start date', async () => {
    const sun = await env.anon('GET', '/api/events?mode=all&range=custom&from=2026-11-29&to=2026-11-29');
    expect(titles(sun.body)).toEqual(expect.arrayContaining(['Vienna Wine Weekend', 'Ridge Hike']));
    expect(titles(sun.body)).not.toContain('Roller Night');
  });

  it('highlights favour followed artists; small nights only in All', async () => {
    const h = await env.anon('GET', '/api/events?mode=highlights');
    expect(titles(h.body)).toContain('Roller Night');
    expect(titles(h.body)).not.toContain('Tiny House Session');
    expect(titles((await env.anon('GET', '/api/events?mode=all')).body)).toContain('Tiny House Session');
    expect(h.body.items.find((e: any) => e.title === 'Roller Night').reasons[0]).toMatch(/Chase & Status is on your watchlist/);
  });

  it('searches events, artists, venues and cities', async () => {
    expect((await env.anon('GET', '/api/search?q=chase')).body.artists[0].name).toBe('Chase & Status');
    expect((await env.anon('GET', '/api/search?q=laugh')).body.venues[0].name).toBe('Laugh Bar');
    expect((await env.anon('GET', '/api/search?q=wien')).body.cities[0].slug).toBe('vienna');
  });

  it('European appearances per artist', async () => {
    const bicep = (await env.anon('GET', '/api/artists')).body.artists.find((a: any) => a.name === 'Bicep');
    expect(bicep.appearances.map((e: any) => e.title)).toEqual(['Summer Bass Festival 2027']);
  });
});

describe('Ibiza', () => {
  it('filters parties to holiday dates and separates residencies from confirmed dates', async () => {
    await loadDemo(env.ctx);
    const all = (await env.anon('GET', '/api/ibiza?season=2027')).body;
    expect(all.residencies.find((r: any) => r.title === 'Rebel Sundays (demo)').residents.map((x: any) => x.name)).toContain('Damian Lazarus');
    expect(all.openings.map((e: any) => e.occasion).sort()).toEqual(['closing', 'opening']);
    const stay = (await env.anon('GET', '/api/ibiza?season=2027&stay_from=2027-07-18&stay_to=2027-07-22')).body;
    expect(stay.stay_parties.map((e: any) => e.title).sort()).toEqual(['Bass Theory: Velvet Circuit (demo)', 'Rebel Sundays (demo)']);
    expect(stay.residencies.find((r: any) => r.title === 'Bass Theory (demo)').overlaps_stay).toBe(true);
  });
});

describe('shared listings and priority events', () => {
  it('the editor can add, edit and delete a shared listing; researched listings stay protected', async () => {
    const c = await env.api('POST', '/api/events', { title: 'Pottery workshop', start: '2026-12-03T18:00', end: '20:00', timezone: 'Europe/Bratislava', venue: { name: 'Studio', city: 'Bratislava', country: 'SK' }, categories: ['workshop'] });
    expect(c.status).toBe(200);
    expect((await env.anon('GET', `/api/events/${c.body.id}`)).body.origin).toBe('manual');
    expect((await env.api('PUT', `/api/events/${c.body.id}`, { title: 'Pottery workshop (beginners)', start: '2026-12-03T18:00', end: '20:30', timezone: 'Europe/Bratislava', venue: { name: 'Studio', city: 'Bratislava', country: 'SK' } })).status).toBe(200);
    expect((await env.anon('GET', `/api/events/${c.body.id}`)).body).toMatchObject({ title: 'Pottery workshop (beginners)', end_local: '2026-12-03T20:30' });
    expect((await env.research('POST', '/import', { events: [{ id: c.body.id, title: 'Hijacked' }] })).body.items[0].status).toBe('error');
    expect((await env.api('PUT', `/api/events/${ids['vienna-wine']}`, { title: 'x', start: '2026-12-01', timezone: 'Europe/Vienna' })).status).toBe(403);
    expect((await env.api('DELETE', `/api/events/${ids['vienna-wine']}`)).status).toBe(403);
    expect((await env.api('DELETE', `/api/events/${c.body.id}`)).status).toBe(200);
  });

  it('shared Going/Booked ids raise verification priority and trigger change alerts; each device replaces only its own set', async () => {
    await env.api('PUT', '/api/priority-events', { device_id: 'phone-abcdef12', events: { [ids['festival']]: 'booked', evt_unknown: 'going' } });
    await env.api('PUT', '/api/priority-events', { device_id: 'laptop-abcdef12', events: { [ids['vienna-wine']]: 'going' } });
    let q = (await env.research('GET', '/verification-queue?limit=10')).body;
    const fest = q.items.findIndex((i: any) => i.event.id === ids['festival']);
    expect(q.items[fest].reasons).toContain('booked');
    expect(fest).toBeLessThan(q.items.findIndex((i: any) => i.event.id === ids['euro-festival'])); // booked beats an unbooked festival
    await env.api('PUT', '/api/priority-events', { device_id: 'phone-abcdef12', events: {} });
    q = (await env.research('GET', '/verification-queue?limit=10')).body;
    expect(q.items.find((i: any) => i.event.id === ids['vienna-wine']).reasons).toContain('going');
    expect(q.items.find((i: any) => i.event.id === ids['festival']).reasons).not.toContain('booked');
    // A date change on a shared Going event creates an update even though it is not a highlight
    await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:wine-1'], start: '2026-12-05', end: '2026-12-06' }] });
    expect((await env.anon('GET', '/api/feed')).body.items.map((i: any) => i.type)).toContain('date_change');
  });
});

describe('updates feed and notifications', () => {
  it('creates relevant updates once and never repeats unchanged information', async () => {
    const f1 = (await env.anon('GET', '/api/feed')).body;
    expect(f1.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['new_appearance', 'ticket_sale']));
    await env.research('POST', '/import', samplePayload());
    expect((await env.anon('GET', '/api/feed')).body.items.length).toBe(f1.items.length);
    for (let i = 0; i < 2; i++) await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], status: 'cancelled' }] });
    expect((await env.anon('GET', '/api/feed')).body.items.filter((i: any) => i.type === 'cancellation')).toHaveLength(1);
  });

  it('reports email as not configured until a provider is set', async () => {
    const s = (await env.api('GET', '/api/notifications/status')).body;
    expect(s.state).toBe('not_configured');
    expect((await env.api('POST', '/api/notifications/test', {})).body.ok).toBe(false);
  });
});

describe('link extraction', () => {
  it('parses schema.org Event data and refuses private addresses', async () => {
    const { parseHtml } = await import('../../src/server/services/extract');
    const html = `<script type="application/ld+json">{"@type":"MusicEvent","name":"Test &amp; Co","startDate":"2026-12-05T21:00:00+01:00","endDate":"2026-12-06T04:00:00+01:00","location":{"name":"Club X","address":{"addressLocality":"Vienna","addressCountry":"AT"}},"offers":{"price":"35","priceCurrency":"EUR"}}</script>`;
    expect(parseHtml(html, 'https://example.org/e').draft).toMatchObject({ title: 'Test & Co', start: '2026-12-05T21:00', timezone: 'Europe/Vienna' });
    expect((await env.anon('POST', '/api/events/extract', { url: 'http://127.0.0.1/admin' })).status).toBe(400);
  });
});
