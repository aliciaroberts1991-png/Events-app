import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app';
import { sampleSlug } from './util';
import { samplePayload, setup, type TestEnv } from './helpers';

let env: TestEnv;
beforeEach(async () => {
  env = await setup();
});
afterEach(async () => {
  await env.close();
});

const findRef = (body: any, ref: string) => body.items.find((i: any) => i.ref === ref);

describe('research API access', () => {
  it('rejects missing, wrong and revoked tokens', async () => {
    const none = await env.app.inject({ method: 'GET', url: '/api/research/v1/context' });
    expect(none.statusCode).toBe(401);
    const wrong = await env.app.inject({ method: 'GET', url: '/api/research/v1/context', headers: { authorization: 'Bearer nope' } });
    expect(wrong.statusCode).toBe(401);
    const tokens = await env.api('GET', '/api/research-tokens');
    await env.api('DELETE', `/api/research-tokens/${tokens.body.tokens[0].id}`);
    expect((await env.research('GET', '/context')).status).toBe(401);
  });

  it('records a real authenticated update with /ping and reports the executor as connected', async () => {
    const before = await env.api('GET', '/api/status');
    expect(before.body.executor.state).toBe('awaiting_connection');
    const ping = await env.research('POST', '/ping', { executor: 'vitest' });
    expect(ping.status).toBe(200);
    expect(ping.body.run.status).toBe('completed');
    const after = await env.api('GET', '/api/status');
    expect(after.body.executor.state).toBe('connected'); // not "operational" until real research runs complete
    expect(after.body.executor.last_connection_test.ok).toBe(true);
  });

  it('exposes the watchlist and preferences in /context without personal records', async () => {
    const res = await env.research('GET', '/context');
    expect(res.status).toBe(200);
    expect(res.body.watchlist.active.map((a: any) => a.name)).toEqual(expect.arrayContaining(['Maribou State', 'Bicep', 'Chase & Status', 'Damian Lazarus', 'Goddard.']));
    expect(res.body.geographic_scopes.cities).toHaveLength(4);
    expect(JSON.stringify(res.body)).not.toContain('notes');
  });

  it('serves an OpenAPI document generated from the validation schemas', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/api/research/v1/openapi.json' });
    const doc = JSON.parse(res.body);
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.components.schemas.ImportPayload.properties.events).toBeDefined();
  });
});

describe('imports', () => {
  it('creates events and reports repeated imports as unchanged (duplicate detection)', async () => {
    const first = await env.research('POST', '/import', samplePayload());
    expect(first.status).toBe(200);
    expect(first.body.counts.created).toBe(7);
    expect(first.body.counts.error).toBe(0);
    const second = await env.research('POST', '/import', samplePayload());
    expect(second.body.counts).toMatchObject({ created: 0, unchanged: 7, error: 0 });
    const events = await env.research('GET', '/events?limit=50');
    expect(events.body.items).toHaveLength(7);
  });

  it('matches without source keys by title, date and place', async () => {
    await env.research('POST', '/import', samplePayload());
    const res = await env.research('POST', '/import', {
      events: [{ title: 'Roller Night', start: '2026-11-28T22:00', timezone: 'Europe/Bratislava', venue: { name: 'Test Club', city: 'Bratislava', country: 'SK' }, prominence: 50 }],
    });
    expect(res.body.items[0].status).toBe('unchanged');
    expect(res.body.items[0].matched_by).toBeDefined();
    const fuzzy = await env.research('POST', '/import', {
      events: [{ title: 'ROLLER NIGHT!', start: '2026-11-28T22:00', timezone: 'Europe/Bratislava', venue: { name: 'Test Club', city: 'Bratislava', country: 'SK' } }],
    });
    expect(fuzzy.body.items[0].status).not.toBe('created');
  });

  it('replays the stored result for a repeated idempotency key and rejects a reused key with a different payload', async () => {
    const payload = { ...samplePayload(), idempotency_key: 'daily-2026-11-22-a' };
    const a = await env.research('POST', '/import', payload);
    const b = await env.research('POST', '/import', payload);
    expect(b.body.replayed).toBe(true);
    expect(b.body.counts).toEqual(a.body.counts);
    const c = await env.research('POST', '/import', { ...payload, events: payload.events.slice(0, 1) });
    expect(c.status).toBe(409);
  });

  it('applies partial updates: absent fields are kept, null clears', async () => {
    await env.research('POST', '/import', samplePayload());
    const up = await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], tickets: { price_min: 25 } }] });
    expect(up.body.items[0].status).toBe('updated');
    const id = up.body.items[0].id;
    let ev = (await env.research('GET', `/events/${id}`)).body;
    expect(ev.price_min).toBe(25);
    expect(ev.ticket_url).toBe('https://tickets.example/roller'); // kept
    expect(ev.title).toBe('Roller Night');
    expect(ev.artists.map((a: any) => a.name)).toContain('Chase & Status');
    await env.research('POST', '/import', { events: [{ id, tickets: { url: null } }] });
    ev = (await env.research('GET', `/events/${id}`)).body;
    expect(ev.ticket_url).toBeNull();
    expect(ev.price_min).toBe(25);
  });

  it('merges lineups and records a reschedule with the previous date, keeping bookings attached', async () => {
    const r = await env.research('POST', '/import', samplePayload());
    const id = findRef(r.body, 'dnb-bratislava').id;
    await env.api('POST', `/api/events/${id}/bookings`, { provider: 'Ticketportal', amount: 20, currency: 'EUR', reference: 'ABC123' });
    await env.api('PUT', `/api/events/${id}/state`, { notes: 'Meet at 23:00' });

    const res = await env.research('POST', '/import', {
      events: [{ source_keys: ['test:evt:dnb-1'], start: '2026-12-05T22:00', end: '05:00', status: 'rescheduled', lineup: [{ name: 'Sub Focus Test', billing: 'special_guest', format: 'dj_set' }] }],
    });
    expect(res.body.items[0].changes).toEqual(expect.arrayContaining(['start_local', 'status', 'lineup_added']));
    const d = (await env.api('GET', `/api/events/${id}`)).body;
    expect(d.start_local).toBe('2026-12-05T22:00');
    expect(d.previous_schedule[0].start_local).toBe('2026-11-28T22:00');
    expect(d.artists.map((a: any) => a.name)).toEqual(expect.arrayContaining(['Chase & Status', 'Sub Focus Test']));
    expect(d.bookings).toHaveLength(1);
    expect(d.state.plan_status).toBe('booked');
    expect(d.state.notes).toBe('Meet at 23:00');
    const feed = (await env.api('GET', '/api/feed')).body.items.map((i: any) => i.type);
    expect(feed).toEqual(expect.arrayContaining(['date_change']));
  });

  it('flags missing sources for review but keeps the listing', async () => {
    const r = await env.research('POST', '/import', samplePayload());
    const id = findRef(r.body, 'vienna-wine').id;
    const v = await env.research('POST', '/import', { verifications: [{ event_id: id, outcome: 'source_missing', note: 'Page returns 404' }] });
    expect(v.body.counts.updated).toBe(1);
    const d = (await env.api('GET', `/api/events/${id}`)).body;
    expect(d.needs_review).toBe(true);
    expect(d.verification_state).toBe('source_missing');
    expect(d.title).toBe('Vienna Wine Weekend');
  });

  it('never lets research modify owner-entered events', async () => {
    const created = await env.api('POST', '/api/events', { title: 'My own gig', start: '2026-12-10T20:00', timezone: 'Europe/Bratislava', venue: { name: 'Somewhere', city: 'Bratislava', country: 'SK' } });
    const res = await env.research('POST', '/import', { events: [{ id: created.body.id, title: 'Hijacked' }] });
    expect(res.body.items[0].status).toBe('error');
    const d = (await env.api('GET', `/api/events/${created.body.id}`)).body;
    expect(d.title).toBe('My own gig');
    // and manual events are invisible to the research API
    expect((await env.research('GET', `/events/${created.body.id}`)).status).toBe(404);
  });

  it('validates payloads and reports item errors without dropping valid items', async () => {
    const bad = await env.research('POST', '/import', { events: [{ title: 'x', start: '28/11/2026' }] });
    expect(bad.status).toBe(422);
    const mixed = await env.research('POST', '/import', { events: [{ title: 'No time zone', start: '2026-12-01' }, samplePayload().events[0]] });
    expect(mixed.body.counts.error).toBe(1);
    expect(mixed.body.counts.created).toBe(1);
  });
});

describe('runs and the job queue', () => {
  it('moves Search now through queued, running and completed, with coverage', async () => {
    const q = await env.api('POST', '/api/runs', { type: 'adhoc' });
    expect(q.body.run.status).toBe('queued');
    const again = await env.api('POST', '/api/runs', { type: 'adhoc' });
    expect(again.body.existing).toBe(true);
    const claim = await env.research('POST', '/runs/claim', { executor: 'vitest' });
    expect(claim.body.run.id).toBe(q.body.run.id);
    expect(claim.body.run.status).toBe('running');
    expect((await env.research('POST', '/runs/claim', {})).status).toBe(204);
    const imp = await env.research('POST', '/import', { ...samplePayload(), run_id: claim.body.run.id });
    expect(imp.body.run_id).toBe(claim.body.run.id);
    const done = await env.research('POST', `/runs/${claim.body.run.id}/complete`, {
      outcome: 'success',
      summary: 'Checked four cities',
      coverage: [
        { area: 'bratislava', kind: 'discovery' },
        { area: 'vienna', kind: 'discovery' },
      ],
    });
    expect(done.body.run.status).toBe('completed');
    expect(done.body.run.stats.created).toBe(7);
    const status = (await env.api('GET', '/api/status')).body;
    expect(status.executor.state).toBe('operational');
    expect(status.coverage.find((c: any) => c.area === 'bratislava').last_discovery_at).toBeTruthy();
    expect(status.coverage.find((c: any) => c.area === 'prague').last_discovery_at).toBeNull();
    expect(status.last_successful_update_at).toBeTruthy();
  });

  it('accepts empty JSON bodies from automation tools', async () => {
    const started = await env.research('POST', '/runs', { type: 'discovery' });
    const res = await env.app.inject({ method: 'POST', url: `/api/research/v1/runs/${started.body.run.id}/heartbeat`, headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' } });
    expect(res.statusCode).toBe(200);
    const bad = await env.app.inject({ method: 'POST', url: '/api/research/v1/import', headers: { authorization: `Bearer ${env.token}`, 'content-type': 'application/json' }, payload: '{not json' });
    expect(bad.statusCode).toBe(400);
  });

  it('marks interrupted runs failed when the lease expires and keeps imported data', async () => {
    const started = await env.research('POST', '/runs', { type: 'discovery' });
    const runId = started.body.run.id;
    await env.research('POST', '/import', { ...samplePayload(), run_id: runId });
    env.clock.now = new Date(env.clock.now.getTime() + 2 * 3600_000);
    const status = (await env.api('GET', '/api/status')).body;
    const run = status.recent_runs.find((r: any) => r.id === runId);
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/Interrupted/);
    expect(status.executor.state).toBe('failing');
    const events = await env.research('GET', '/events?limit=50');
    expect(events.body.items.length).toBe(7);
    // completing after expiry is refused
    expect((await env.research('POST', `/runs/${runId}/complete`, { outcome: 'success' })).status).toBe(409);
  });

  it('re-sending an interrupted batch completes it idempotently', async () => {
    const payload = { ...samplePayload(), idempotency_key: 'batch-interrupt-test' };
    // Simulate an interruption: the batch row exists in "processing" with only part applied.
    await env.research('POST', '/import', { events: payload.events.slice(0, 3) });
    await env.ctx.db
      .insertInto('import_batches')
      .values({ id: 'imp_x', idempotency_key: 'batch-interrupt-test', payload_hash: (await import('../../src/server/util')).sha256((await import('../../src/server/util')).stableStringify({ events: payload.events })), run_id: null, status: 'processing', item_count: 7, result: null, received_at: new Date().toISOString(), completed_at: null })
      .execute();
    const res = await env.research('POST', '/import', payload);
    expect(res.status).toBe(200);
    expect(res.body.counts).toMatchObject({ created: 4, unchanged: 3 });
    const batch = await env.ctx.db.selectFrom('import_batches').selectAll().where('idempotency_key', '=', 'batch-interrupt-test').executeTakeFirstOrThrow();
    expect(batch.status).toBe('completed');
  });

  it('records failures and preserves existing listings', async () => {
    await env.research('POST', '/import', samplePayload());
    const run = await env.research('POST', '/runs', { type: 'verification' });
    const failed = await env.research('POST', `/runs/${run.body.run.id}/fail`, { error: 'Search provider unavailable', errors: [{ item_ref: 'vienna', message: 'timeout' }] });
    expect(failed.body.run.status).toBe('failed');
    const detail = await env.api('GET', `/api/runs/${run.body.run.id}`);
    expect(detail.body.errors[0].message).toBe('timeout');
    expect((await env.research('GET', '/events')).body.items).toHaveLength(7);
  });

  it('queues scheduled discovery once per day and weekly verification on the chosen weekday', async () => {
    const { schedulerTick } = await import('../../src/server/services/runs');
    // Monday 23 Nov 2026 07:00 Bratislava: after both default times (05:30 discovery, Monday 06:30 verification)
    env.clock.now = new Date('2026-11-23T06:00:00Z');
    await schedulerTick(env.ctx);
    await schedulerTick(env.ctx);
    const runs = await env.ctx.db.selectFrom('research_runs').select(['type', 'trigger', 'status']).execute();
    expect(runs.filter((r) => r.type === 'discovery')).toHaveLength(1);
    expect(runs.filter((r) => r.type === 'verification')).toHaveLength(1);
    expect(runs.every((r) => r.trigger === 'schedule' && r.status === 'queued')).toBe(true);
    const status = (await env.api('GET', '/api/status')).body;
    expect(status.schedule.effective).toBe('awaiting_executor');
  });

  it('prioritises booked, soon and on-sale events in the verification queue', async () => {
    const r = await env.research('POST', '/import', samplePayload());
    const fest = findRef(r.body, 'festival').id;
    await env.api('PUT', `/api/events/${fest}/state`, { plan_status: 'booked' });
    const q = await env.research('GET', '/verification-queue?limit=3');
    expect(q.body.total).toBe(7);
    expect(q.body.items[0].event.id).toBe(fest);
    expect(q.body.items[0].reasons).toContain('booked');
    expect(q.body.next_offset).toBe(3);
    expect(JSON.stringify(q.body)).not.toContain('plan_status');
  });
});

describe('preservation across refreshes and restarts', () => {
  it('keeps personal data after re-imports, demo refresh and a restart on the same database', async () => {
    if (process.env.TEST_DATABASE !== 'postgres') {
      // Use a file database so the "restart" really reopens storage.
      await env.close();
      const fs = await import('node:fs');
      const os = await import('node:os');
      const path = await import('node:path');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'quartet-'));
      env = await setup({ dbUrl: `sqlite:${path.join(dir, sampleSlug())}.db` });
    }
    const r = await env.research('POST', '/import', samplePayload());
    const id = findRef(r.body, 'dnb-bratislava').id;
    await env.api('PUT', `/api/events/${id}/state`, { favourite: true, plan_status: 'going', notes: 'Bring earplugs' });
    await env.api('POST', '/api/plans', { title: 'Dinner', start: '2026-11-28T19:00', end: '2026-11-28T21:00' });
    await env.research('POST', '/import', samplePayload());
    await env.research('POST', '/import', { events: [{ source_keys: ['test:evt:dnb-1'], description: 'Updated description' }] });

    const dbUrl = env.dbUrl;
    await env.close();
    const restarted = await buildApp({ databaseUrl: dbUrl, cookieSecure: false }, { now: () => new Date('2026-11-22T09:00:00Z') });
    try {
      const st = await restarted.ctx.db.selectFrom('user_event_state').selectAll().where('event_id', '=', id).executeTakeFirstOrThrow();
      expect(st.notes).toBe('Bring earplugs');
      expect(st.plan_status).toBe('going');
      expect(st.favourite).toBe(1);
      const plans = await restarted.ctx.db.selectFrom('personal_plans').selectAll().execute();
      expect(plans).toHaveLength(1);
      const watch = await restarted.ctx.db.selectFrom('watchlist').selectAll().execute();
      expect(watch).toHaveLength(5); // seed is not re-applied on restart
    } finally {
      await restarted.close();
      env = await setup();
    }
  });
});
