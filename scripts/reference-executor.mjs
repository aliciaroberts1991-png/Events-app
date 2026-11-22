#!/usr/bin/env node
// Reference research executor and connection smoke test.
//
// Shows the full protocol a research service follows, using plain HTTPS calls,
// so it can be re-implemented in ChatGPT Actions, a Python script, n8n, etc.
//
//   RESEARCH_API=https://your-app.example.com/api/research/v1 \
//   RESEARCH_TOKEN=qrt_… \
//   node scripts/reference-executor.mjs --ping
//
//   … --run discovery --import examples/01-discovery-import.json
//   … --claim --import results.json        (process a queued "Search now" / scheduled run)
//
// It does not research anything by itself: --import sends a file you (or an AI
// researcher) produced.
import fs from 'node:fs';

const api = (process.env.RESEARCH_API ?? 'http://localhost:3000/api/research/v1').replace(/\/$/, '');
const token = process.env.RESEARCH_TOKEN;
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
if (!token) {
  console.error('Set RESEARCH_TOKEN (create one in Settings → Research and updates).');
  process.exit(2);
}

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}: ${text.slice(0, 500)}`);
  return { status: res.status, data };
}

try {
  if (has('--ping')) {
    const r = await call('POST', '/ping', { executor: 'reference-executor', note: 'Connection test from scripts/reference-executor.mjs' });
    console.log(`✓ Authenticated write recorded (run ${r.data.run.id}, status ${r.data.run.status}).`);
  }

  let run = null;
  if (has('--claim')) {
    const r = await call('POST', '/runs/claim', { executor: 'reference-executor' });
    if (r.status === 204) console.log('Nothing queued.');
    else {
      run = r.data.run;
      console.log(`✓ Claimed run ${run.id} (${run.type}). Brief: ${r.data.brief.instructions}`);
    }
  } else if (val('--run')) {
    const r = await call('POST', '/runs', { type: val('--run'), executor: 'reference-executor' });
    run = r.data.run;
    console.log(`✓ Started run ${run.id} (${run.type}).`);
  }

  if (run || has('--context')) {
    const ctx = await call('GET', '/context');
    console.log(`✓ Read context: ${ctx.data.watchlist.active.length} active artists (${ctx.data.watchlist.active.map((a) => a.name).join(', ')}); planning time zone ${ctx.data.planning_timezone}.`);
  }

  const file = val('--import');
  let coverage = [];
  if (file) {
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    coverage = payload.coverage ?? [];
    delete payload.coverage;
    const r = await call('POST', '/import', { ...payload, ...(run ? { run_id: run.id } : {}) });
    console.log(`✓ Imported ${file}: ${JSON.stringify(r.data.counts)}${r.data.replayed ? ' (replayed — already imported with this idempotency key)' : ''}`);
    for (const i of r.data.items.filter((x) => x.status === 'error')) console.log(`  ! ${i.type} ${i.ref ?? i.index}: ${i.error}`);
    if (run) await call('POST', `/runs/${run.id}/heartbeat`);
  }

  if (run) {
    const done = await call('POST', `/runs/${run.id}/complete`, { outcome: 'success', summary: `Reference executor${file ? `: imported ${file}` : ''}`, coverage });
    console.log(`✓ Run ${done.data.run.id} is ${done.data.run.status}.`);
  }
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exit(1);
}
