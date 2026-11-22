import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { importPayload, runCompleteInput, runCreateInput, runFailInput } from '../../src/shared/research-schema';
import { setup, type TestEnv } from './helpers';

const dir = path.resolve('examples');
const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

describe('documented examples', () => {
  let env: TestEnv;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => env.close());

  it('validate against the schemas', () => {
    for (const f of fs.readdirSync(dir).filter((x) => /^0\d-.*\.json$/.test(x))) {
      const r = importPayload.safeParse(read(f));
      expect(r.success, `${f}: ${JSON.stringify(r.error?.issues)}`).toBe(true);
    }
    expect(runCreateInput.safeParse(read('run-start.json')).success).toBe(true);
    expect(runCompleteInput.safeParse(read('run-complete.json')).success).toBe(true);
    expect(runFailInput.safeParse(read('run-fail.json')).success).toBe(true);
  });

  it('import cleanly in order, with no errors', async () => {
    for (const f of ['01-discovery-import.json', '02-partial-update.json', '03-verification-batch.json', '04-reschedule-and-cancel.json', '05-ibiza-residency.json', '06-recurring-market.json']) {
      const res = await env.research('POST', '/import', read(f));
      expect(res.status, f).toBe(200);
      expect(res.body.counts.error, `${f}: ${JSON.stringify(res.body.items.filter((i: any) => i.error))}`).toBe(0);
    }
    const events = (await env.research('GET', '/events?upcoming=false&limit=50')).body.items;
    const rollers = events.find((e: any) => e.title === 'Example Rollers all night');
    expect(rollers.start_local).toBe('2026-12-12T22:00');
    expect(rollers.status).toBe('rescheduled');
    expect(events.find((e: any) => e.title.startsWith('Example Band')).status).toBe('cancelled');
    const market = events.find((e: any) => e.title === 'Example Farmers’ Market');
    expect(market.kind).toBe('recurring');
  });
});
