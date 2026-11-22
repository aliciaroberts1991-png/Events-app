import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadDemo } from '../../src/server/services/seed';
import { samplePayload, setup, type TestEnv } from './helpers';

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

describe('combined filters', () => {
  it('Vienna, next weekend, food and drink', async () => {
    const r = await env.api('GET', '/api/events?mode=all&hubs=vienna&nearby=0&range=next-weekend&categories=food-drink');
    expect(r.body.range.label).toBe('Fri 27 – Sun 29 Nov');
    expect(titles(r.body)).toEqual(['Vienna Wine Weekend']);
  });

  it('all four cities, this month, drum and bass (genre lineage and artist genres)', async () => {
    const r = await env.api('GET', '/api/events?mode=all&range=this-month&genres=dnb');
    expect(titles(r.body)).toEqual(['Roller Night']);
  });

  it('Bratislava, English-language comedy finds nothing in Bratislava but works in Prague', async () => {
    const bra = await env.api('GET', '/api/events?mode=all&hubs=bratislava&categories=english-comedy');
    expect(bra.body.items).toHaveLength(0);
    const pra = await env.api('GET', '/api/events?mode=all&hubs=prague&categories=english-comedy&english=1');
    expect(titles(pra.body)).toEqual(['English Comedy Night']);
  });

  it('nearby areas follow the configurable radius and show the actual town', async () => {
    const strict = await env.api('GET', '/api/events?mode=all&hubs=bratislava&nearby=0');
    expect(titles(strict.body)).not.toContain('Ridge Hike');
    const near = await env.api('GET', '/api/events?mode=all&hubs=bratislava&nearby=1&radius=30');
    const hike = near.body.items.find((e: any) => e.title === 'Ridge Hike');
    expect(hike.city).toBe('Hainburg an der Donau');
    expect(hike.participation).toBe('participant');
    const tight = await env.api('GET', '/api/events?mode=all&hubs=bratislava&nearby=1&radius=5');
    expect(titles(tight.body)).not.toContain('Ridge Hike');
  });

  it('European festivals featuring an artist I follow', async () => {
    const r = await env.api('GET', '/api/festivals?festival_scope=europe&followed=1');
    expect(titles(r.body)).toEqual(['Coastline Sounds 2027', 'Summer Bass Festival 2027']);
    const near = await env.api('GET', '/api/festivals?festival_scope=nearby');
    expect(titles(near.body)).toEqual(['Summer Bass Festival 2027']);
    const fest = near.body.items[0];
    expect(fest.artists.find((a: any) => a.name === 'Chase & Status')).toMatchObject({ date: '2027-07-10', format: 'live', followed: true });
  });

  it('multi-day events appear when they overlap the range; sorting options work', async () => {
    const sat = await env.api('GET', '/api/events?mode=all&range=custom&from=2026-11-29&to=2026-11-29');
    expect(titles(sat.body)).toEqual(expect.arrayContaining(['Vienna Wine Weekend', 'Ridge Hike']));
    // Overnight Saturday event does not leak into Sunday
    expect(titles(sat.body)).not.toContain('Roller Night');
    const recent = await env.api('GET', '/api/events?mode=all&sort=relevance');
    expect(recent.body.items[0].score).toBeGreaterThanOrEqual(recent.body.items[1].score);
  });

  it('searches events, artists, venues and cities', async () => {
    const s = await env.api('GET', '/api/search?q=chase');
    expect(s.body.artists[0].name).toBe('Chase & Status');
    expect(s.body.events.map((e: any) => e.title)).toEqual(expect.arrayContaining(['Roller Night']));
    const v = await env.api('GET', '/api/search?q=laugh');
    expect(v.body.venues[0].name).toBe('Laugh Bar');
    const c = await env.api('GET', '/api/search?q=wien');
    expect(c.body.cities[0].slug).toBe('vienna');
  });
});

describe('highlights and all events', () => {
  it('highlights prioritise followed artists and strong matches; small nights only in All', async () => {
    const h = await env.api('GET', '/api/events?mode=highlights');
    const all = await env.api('GET', '/api/events?mode=all');
    expect(titles(h.body)).toContain('Roller Night');
    expect(titles(h.body)).not.toContain('Tiny House Session');
    expect(titles(all.body)).toContain('Tiny House Session');
    expect(h.body.counts.all).toBe(all.body.items.length);
    const roller = h.body.items.find((e: any) => e.title === 'Roller Night');
    expect(roller.reasons[0]).toMatch(/Chase & Status is on your watchlist/);
  });

  it('"fewer like this" and interest changes adjust highlights', async () => {
    const prefs = (await env.api('GET', '/api/preferences')).body;
    prefs.data.categoryWeights.wine = 3;
    const saved = await env.api('PUT', '/api/preferences', { data: prefs.data, version: prefs.version });
    expect(saved.status).toBe(200);
    const stale = await env.api('PUT', '/api/preferences', { data: prefs.data, version: prefs.version });
    expect(stale.status).toBe(409);
    const before = (await env.api('GET', '/api/events?mode=all')).body.items.find((e: any) => e.title === 'Vienna Wine Weekend').score;
    await env.api('POST', `/api/events/${ids['vienna-wine']}/feedback`, { kind: 'less_similar' });
    const after = (await env.api('GET', '/api/events?mode=all')).body.items.find((e: any) => e.title === 'Vienna Wine Weekend').score;
    expect(after).toBeLessThan(before);
  });

  it('hidden events disappear everywhere but can be listed and restored', async () => {
    await env.api('PUT', `/api/events/${ids['prague-comedy']}/state`, { hidden: true });
    expect(titles((await env.api('GET', '/api/events?mode=all')).body)).not.toContain('English Comedy Night');
    expect(titles((await env.api('GET', '/api/events?mode=all&saved=hidden')).body)).toEqual(['English Comedy Night']);
    await env.api('PUT', `/api/events/${ids['prague-comedy']}/state`, { hidden: false });
    expect(titles((await env.api('GET', '/api/events?mode=all')).body)).toContain('English Comedy Night');
  });
});

describe('watchlist', () => {
  it('adds, edits, pauses and removes artists without touching saved events', async () => {
    const add = await env.api('POST', '/api/watchlist', { name: 'Goddard', links: { official: 'https://other-goddard.example' } });
    expect(add.status).toBe(200);
    let list = (await env.api('GET', '/api/watchlist')).body.artists;
    // "Goddard." already exists with no conflicting link, so it is matched via alias rather than duplicated
    expect(list.filter((a: any) => a.name.startsWith('Goddard'))).toHaveLength(1);
    const chase = list.find((a: any) => a.name === 'Chase & Status');
    await env.api('PUT', `/api/events/${ids['dnb-bratislava']}/state`, { plan_status: 'booked' });
    await env.api('PUT', `/api/watchlist/${chase.id}`, { status: 'paused', aliases: ['Chase and Status', 'C&S'] });
    list = (await env.api('GET', '/api/watchlist')).body.artists;
    expect(list.find((a: any) => a.name === 'Chase & Status')).toMatchObject({ status: 'paused', aliases: ['Chase and Status', 'C&S'] });
    const ctx = (await env.research('GET', '/context')).body;
    expect(ctx.watchlist.paused.map((a: any) => a.name)).toContain('Chase & Status');
    expect(ctx.watchlist.active.map((a: any) => a.name)).not.toContain('Chase & Status');
    await env.api('DELETE', `/api/watchlist/${chase.id}`);
    const ev = (await env.api('GET', `/api/events/${ids['dnb-bratislava']}`)).body;
    expect(ev.state.plan_status).toBe('booked');
    expect(ev.artists[0].followed).toBe(false);
  });

  it('keeps similarly named acts apart when identifying links differ', async () => {
    await env.api('POST', '/api/watchlist', { name: 'Twin Name', links: { official: 'https://a.example' } });
    await env.api('POST', '/api/watchlist', { name: 'Twin Name', links: { official: 'https://b.example' } });
    const list = (await env.api('GET', '/api/watchlist')).body.artists.filter((a: any) => a.name === 'Twin Name');
    expect(list).toHaveLength(2);
  });

  it('lists European appearances and festival associations per artist', async () => {
    const artists = (await env.api('GET', '/api/artists')).body.artists;
    const bicep = artists.find((a: any) => a.name === 'Bicep');
    expect(bicep.appearances.map((e: any) => e.title)).toEqual(['Summer Bass Festival 2027']);
    const detail = (await env.api('GET', `/api/artists/${bicep.artist_id}`)).body;
    expect(detail.appearances[0].festival.name).toBe('Summer Bass Festival');
  });
});

describe('saved state across devices', () => {
  it('syncs statuses and notes between two sessions and detects conflicting edits', async () => {
    const phone = await env.login();
    const laptop = env.cookie;
    const a = await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { plan_status: 'interested', notes: 'Ask Jana', version: 0 }, { cookie: phone });
    expect(a.body.state.version).toBe(1);
    const seen = await env.api('GET', `/api/events/${ids['vienna-wine']}`, undefined, { cookie: laptop });
    expect(seen.body.state).toMatchObject({ plan_status: 'interested', notes: 'Ask Jana' });
    await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { plan_status: 'going', version: 1 }, { cookie: laptop });
    const conflict = await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { notes: 'stale edit', version: 1 }, { cookie: phone });
    expect(conflict.status).toBe(409);
    // Status is consistent in every view
    const card = (await env.api('GET', '/api/events?mode=all')).body.items.find((e: any) => e.id === ids['vienna-wine']);
    expect(card.state.plan_status).toBe('going');
  });
});

describe('bookings, plans and calendar', () => {
  it('enters an already-booked show quickly', async () => {
    const watch = (await env.api('GET', '/api/watchlist')).body.artists;
    const chase = watch.find((a: any) => a.name === 'Chase & Status');
    const r = await env.api('POST', '/api/bookings/quick', {
      artist_id: chase.artist_id,
      date: '2026-12-12',
      time: '20:00',
      venue_name: 'Example Arena',
      city: 'Prague',
      country: 'CZ',
      format: 'live',
      booking: { provider: 'Ticketmaster', amount: 89.5, currency: 'CZK', reference: 'XYZ-1' },
    });
    expect(r.status).toBe(200);
    const d = (await env.api('GET', `/api/events/${r.body.id}`)).body;
    expect(d).toMatchObject({ title: 'Chase & Status', origin: 'manual', timezone: 'Europe/Prague', start_local: '2026-12-12T20:00' });
    expect(d.state.plan_status).toBe('booked');
    expect(d.bookings[0]).toMatchObject({ provider: 'Ticketmaster', amount: 89.5, reference: 'XYZ-1' });
    expect(d.artists[0]).toMatchObject({ name: 'Chase & Status', format: 'live' });
    const cal = (await env.api('GET', '/api/calendar?from=2026-12-01&to=2026-12-31')).body;
    expect(cal.entries.map((e: any) => e.title)).toContain('Chase & Status');
  });

  it('detects real overlaps, possible same-day clashes and allows keeping both', async () => {
    await env.api('PUT', `/api/events/${ids['dnb-bratislava']}/state`, { plan_status: 'going' }); // Sat 22:00–05:00
    await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { plan_status: 'booked' }); // Sat–Sun, no times
    await env.api('PUT', `/api/events/${ids['prague-comedy']}/state`, { plan_status: 'interested' }); // Fri 20–22
    await env.api('POST', '/api/plans', { title: 'Late dinner', start: '2026-11-28T21:00', end: '2026-11-28T23:00', timezone: 'Europe/Bratislava' });
    await env.api('POST', '/api/plans', { title: 'Sunday brunch', start: '2026-11-29T11:00', end: '2026-11-29T13:00', timezone: 'Europe/Bratislava' });

    let cal = (await env.api('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).body;
    expect(cal.entries.map((e: any) => e.title)).not.toContain('English Comedy Night'); // Interested excluded by default
    const overlap = cal.clashes.find((c: any) => c.type === 'overlap');
    expect([overlap.a, overlap.b].some((k: string) => k.startsWith('plan:'))).toBe(true);
    expect(cal.clashes.some((c: any) => c.type === 'possible')).toBe(true);
    // Overnight event (ends 05:00 Sunday) does not clash with Sunday brunch
    const brunch = cal.entries.find((e: any) => e.title === 'Sunday brunch').key;
    const roller = cal.entries.find((e: any) => e.title === 'Roller Night').key;
    expect(cal.clashes.some((c: any) => [c.a, c.b].includes(brunch) && [c.a, c.b].includes(roller))).toBe(false);

    await env.api('POST', '/api/calendar/clashes/review', { a: overlap.a, b: overlap.b, decision: 'keep_both' });
    cal = (await env.api('GET', '/api/calendar?from=2026-11-01&to=2026-11-30&include_interested=1')).body;
    expect(cal.clashes.find((c: any) => c.a === overlap.a && c.b === overlap.b).reviewed).toBe(true);
    expect(cal.entries.map((e: any) => e.title)).toContain('English Comedy Night');
    expect(cal.entries.filter((e: any) => e.kind === 'event')).toHaveLength(3); // both clashing items kept
  });

  it('compares events in different timezones correctly', async () => {
    // 20:00–22:00 Prague == 20:00–22:00 Bratislava (same offset); a London plan 19:30–20:30 is 20:30–21:30 CET.
    await env.api('PUT', `/api/events/${ids['prague-comedy']}/state`, { plan_status: 'going' });
    await env.api('POST', '/api/plans', { title: 'Call from London', start: '2026-11-27T19:30', end: '2026-11-27T20:30', timezone: 'Europe/London' });
    await env.api('POST', '/api/plans', { title: 'Lisbon call', start: '2026-11-27T22:30', end: '2026-11-27T23:00', timezone: 'Europe/Lisbon' });
    const cal = (await env.api('GET', '/api/calendar?from=2026-11-27&to=2026-11-27')).body;
    const titlesIn = (c: any) => [c.a, c.b].map((k: string) => cal.entries.find((e: any) => e.key === k).title);
    expect(cal.clashes.map(titlesIn)).toEqual([expect.arrayContaining(['English Comedy Night', 'Call from London'])]);
  });

  it('exports standard ICS with UTC times, all-day dates and escaping', async () => {
    await env.api('PUT', `/api/events/${ids['dnb-bratislava']}/state`, { plan_status: 'going' });
    await env.api('PUT', `/api/events/${ids['festival']}/state`, { plan_status: 'booked' });
    const res = await env.app.inject({ method: 'GET', url: '/api/calendar.ics', headers: { cookie: env.cookie } });
    expect(res.headers['content-type']).toMatch(/text\/calendar/);
    expect(res.body).toMatch(/^BEGIN:VCALENDAR\r\n/);
    expect(res.body).toContain('DTSTART:20261128T210000Z');
    expect(res.body).toContain('DTEND:20261129T040000Z');
    expect(res.body).toContain('DTSTART;VALUE=DATE:20270709');
    expect(res.body).toContain('DTEND;VALUE=DATE:20270712');
    expect(res.body.split('\r\n').every((l: string) => Buffer.byteLength(l) <= 75)).toBe(true);
    const single = await env.app.inject({ method: 'GET', url: `/api/events/${ids['prague-comedy']}/ics`, headers: { cookie: env.cookie } });
    expect(single.body).toContain('SUMMARY:English Comedy Night');
  });

  it('keeps past bookings in history after archiving', async () => {
    await env.api('POST', `/api/events/${ids['prague-comedy']}/bookings`, { provider: 'GoOut', amount: 350, currency: 'CZK' });
    env.clock.now = new Date('2026-12-10T10:00:00Z');
    const { archivePastEvents } = await import('../../src/server/services/runs');
    expect(await archivePastEvents(env.ctx)).toBeGreaterThan(0);
    const hist = (await env.api('GET', '/api/calendar/history')).body.items;
    expect(hist[0]).toMatchObject({ title: 'English Comedy Night', archived: true });
    expect(hist[0].bookings[0].provider).toBe('GoOut');
    expect(titles((await env.api('GET', '/api/events?mode=all')).body)).not.toContain('English Comedy Night');
  });

  it('merges a manual booking into the researched listing when it appears', async () => {
    const quick = await env.api('POST', '/api/bookings/quick', { title: 'Roller Night', date: '2026-11-28', city: 'Bratislava', country: 'SK', booking: { reference: 'R1' } });
    const d = (await env.api('GET', `/api/events/${quick.body.id}`)).body;
    expect(d.possible_matches.map((m: any) => m.id)).toContain(ids['dnb-bratislava']);
    await env.api('POST', `/api/events/${quick.body.id}/merge`, { target_id: ids['dnb-bratislava'] });
    const t = (await env.api('GET', `/api/events/${ids['dnb-bratislava']}`)).body;
    expect(t.state.plan_status).toBe('booked');
    expect(t.bookings[0].reference).toBe('R1');
    expect((await env.api('GET', `/api/events/${quick.body.id}`)).status).toBe(404);
  });
});

describe('Ibiza', () => {
  it('filters parties to holiday dates and separates residencies from confirmed dates', async () => {
    await loadDemo(env.ctx);
    const season = 2027;
    const all = (await env.api('GET', `/api/ibiza?season=${season}`)).body;
    expect(all.residencies.map((r: any) => r.title)).toEqual(expect.arrayContaining(['Rebel Sundays (demo)', 'Bass Theory (demo)']));
    expect(all.residencies.find((r: any) => r.title === 'Rebel Sundays (demo)').residents.map((x: any) => x.name)).toContain('Damian Lazarus');
    expect(all.openings.map((e: any) => e.occasion).sort()).toEqual(['closing', 'opening']);
    const stay = (await env.api('GET', `/api/ibiza?season=${season}&stay_from=2027-07-18&stay_to=2027-07-22`)).body;
    expect(stay.stay_parties.map((e: any) => e.title).sort()).toEqual(['Bass Theory: Velvet Circuit (demo)', 'Rebel Sundays (demo)']);
    expect(stay.residencies.find((r: any) => r.title === 'Bass Theory (demo)').overlaps_stay).toBe(true);
    await env.api('POST', '/api/ibiza/stays', { start_date: '2027-07-18', end_date: '2027-07-22', label: 'Summer trip' });
    expect((await env.api('GET', '/api/ibiza/stays')).body.stays).toHaveLength(1);
  });
});

describe('demo data', () => {
  it('is labelled and removable without touching personal records on real events', async () => {
    await loadDemo(env.ctx);
    const all = (await env.api('GET', '/api/events?mode=all&scope=any&limit=200')).body.items;
    expect(all.filter((e: any) => e.is_demo).every((e: any) => /\(demo\)/.test(e.title))).toBe(true);
    await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { favourite: true });
    await env.api('DELETE', '/api/demo');
    const after = (await env.api('GET', '/api/events?mode=all&scope=any&limit=200')).body.items;
    expect(after.some((e: any) => e.is_demo)).toBe(false);
    expect(after.find((e: any) => e.id === ids['vienna-wine']).state.favourite).toBe(true);
    expect((await env.api('GET', '/api/watchlist')).body.artists).toHaveLength(5);
  });
});

describe('personal data export and import', () => {
  it('round-trips into a fresh database with duplicate handling', async () => {
    await env.api('PUT', `/api/events/${ids['dnb-bratislava']}/state`, { plan_status: 'booked', notes: 'Row 3', favourite: true });
    await env.api('POST', `/api/events/${ids['dnb-bratislava']}/bookings`, { provider: 'Ticketportal', amount: 20, currency: 'EUR', reference: 'T-1' });
    await env.api('POST', '/api/plans', { title: 'Dentist', start: '2026-12-01T09:00', end: '2026-12-01T10:00' });
    await env.api('POST', '/api/bookings/quick', { artist_name: 'Chase & Status', date: '2026-12-12', time: '20:00', city: 'Prague', country: 'CZ', booking: { reference: 'CS-1' } });
    await env.api('POST', '/api/watchlist', { name: 'New Artist', aliases: ['N.A.'] });
    const exp = (await env.api('GET', '/api/export')).body;
    expect(exp.format).toBe('quartet-personal-export');

    const fresh = await setup();
    try {
      await fresh.research('POST', '/import', samplePayload()); // research collection rebuilt with new ids
      const dry = await fresh.api('POST', '/api/import-personal?dry_run=1', exp);
      expect(dry.body.dry_run).toBe(true);
      expect((await fresh.api('GET', '/api/plans')).body.plans).toHaveLength(0);
      const res = await fresh.api('POST', '/api/import-personal', exp);
      expect(res.body.event_states.unmatched).toBe(0);
      expect(res.body.bookings.added).toBe(2);
      expect(res.body.manual_events.created).toBe(1);
      expect(res.body.watchlist.added).toBe(1);
      const again = await fresh.api('POST', '/api/import-personal', exp);
      expect(again.body.bookings).toMatchObject({ added: 0, duplicates: 2 });
      expect(again.body.plans).toMatchObject({ added: 0, duplicates: 1 });
      expect(again.body.manual_events).toMatchObject({ created: 0 });
      const roller = (await fresh.api('GET', '/api/events?mode=all&q=roller')).body.items[0];
      expect(roller.state).toMatchObject({ plan_status: 'booked', favourite: true, notes: 'Row 3' });
      const bad = await fresh.api('POST', '/api/import-personal', { format: 'something-else' });
      expect(bad.status).toBe(422);
    } finally {
      await fresh.close();
    }
  });
});

describe('private access', () => {
  it('requires sign-in and the CSRF header for personal endpoints', async () => {
    expect((await env.api('GET', '/api/events', undefined, { cookie: null })).status).toBe(401);
    expect((await env.api('PUT', `/api/events/${ids['vienna-wine']}/state`, { favourite: true }, { csrf: false })).status).toBe(403);
    const bad = await env.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'owner@example.com', password: 'wrong' }) });
    expect(bad.statusCode).toBe(401);
  });

  it('throttles repeated failed sign-ins', async () => {
    let last = 0;
    for (let i = 0; i < 7; i++) {
      const r = await env.app.inject({ method: 'POST', url: '/api/auth/login', remoteAddress: '10.9.9.9', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'owner@example.com', password: 'nope' }) });
      last = r.statusCode;
    }
    expect(last).toBe(429);
  });

  it('logs out by deleting the server-side session', async () => {
    const c = await env.login();
    await env.api('POST', '/api/auth/logout', {}, { cookie: c });
    expect((await env.api('GET', '/api/events', undefined, { cookie: c })).status).toBe(401);
  });
});

describe('updates feed and notifications', () => {
  it('creates relevant updates once and does not repeat them for unchanged information', async () => {
    const feed1 = (await env.api('GET', '/api/feed')).body;
    expect(feed1.items.map((i: any) => i.type)).toEqual(expect.arrayContaining(['new_appearance', 'ticket_sale']));
    const n = feed1.items.length;
    await env.research('POST', '/import', samplePayload());
    expect((await env.api('GET', '/api/feed')).body.items.length).toBe(n);
    await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], status: 'cancelled', status_note: 'Artist illness' }] });
    await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], status: 'cancelled', status_note: 'Artist illness' }] });
    const feed2 = (await env.api('GET', '/api/feed')).body;
    expect(feed2.items.filter((i: any) => i.type === 'cancellation')).toHaveLength(1);
    await env.api('POST', '/api/feed/read', { ids: 'all' });
    expect((await env.api('GET', '/api/feed')).body.unread).toBe(0);
  });

  it('reports email as not configured until a provider is set', async () => {
    const s = (await env.api('GET', '/api/notifications/status')).body;
    expect(s.state).toBe('not_configured');
    expect(s.missing.length).toBeGreaterThan(0);
    const t = await env.api('POST', '/api/notifications/test', {});
    expect(t.body.ok).toBe(false);
  });
});

describe('manual events and link extraction', () => {
  it('creates, edits and deletes your own events', async () => {
    const c = await env.api('POST', '/api/events', { title: 'Pottery workshop', start: '2026-12-03T18:00', end: '20:00', timezone: 'Europe/Bratislava', venue: { name: 'Studio', city: 'Bratislava', country: 'SK' }, categories: ['workshop'] });
    expect(c.status).toBe(200);
    const e = await env.api('PUT', `/api/events/${c.body.id}`, { title: 'Pottery workshop (beginners)', start: '2026-12-03T18:00', end: '20:30', timezone: 'Europe/Bratislava', venue: { name: 'Studio', city: 'Bratislava', country: 'SK' } });
    expect(e.status).toBe(200);
    const d = (await env.api('GET', `/api/events/${c.body.id}`)).body;
    expect(d).toMatchObject({ title: 'Pottery workshop (beginners)', end_local: '2026-12-03T20:30', categories: ['workshop'] });
    expect((await env.api('PUT', `/api/events/${ids['vienna-wine']}`, { title: 'x', start: '2026-12-01', timezone: 'Europe/Vienna' })).status).toBe(403);
    expect((await env.api('DELETE', `/api/events/${c.body.id}`)).status).toBe(200);
  });

  it('parses schema.org Event data from a page', async () => {
    const { parseHtml } = await import('../../src/server/services/extract');
    const html = `<html><script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicEvent","name":"Test &amp; Co","startDate":"2026-12-05T21:00:00+01:00","endDate":"2026-12-06T04:00:00+01:00","location":{"@type":"Place","name":"Club X","address":{"addressLocality":"Vienna","addressCountry":"AT","streetAddress":"Main 1"}},"performer":[{"@type":"MusicGroup","name":"Bicep"}],"offers":{"price":"35","priceCurrency":"EUR","url":"https://t.example/x"}}</script></html>`;
    const r = parseHtml(html, 'https://example.org/e');
    expect(r.method).toBe('json-ld');
    expect(r.draft).toMatchObject({ title: 'Test & Co', start: '2026-12-05T21:00', end: '2026-12-06T04:00', timezone: 'Europe/Vienna' });
    expect((r.draft as any).venue).toMatchObject({ name: 'Club X', city: 'Vienna', country: 'AT' });
    const refuse = await env.api('POST', '/api/events/extract', { url: 'http://127.0.0.1/admin' });
    expect(refuse.status).toBe(400);
  });
});
