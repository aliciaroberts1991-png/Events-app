// Research job queue.
//
// A run moves through: queued -> running -> completed | failed (or cancelled).
// The app never pretends to research by itself: runs are executed by an external,
// replaceable executor that either polls (POST /runs/claim) or is woken by an
// optional webhook. A running run holds a lease; if the executor disappears the
// lease expires and the run is marked failed ("interrupted"), while everything it
// already imported is kept.
import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import type { CoverageInput } from '../../shared/research-schema';
import type { AppContext } from '../context';
import { HttpError, newId, nowIso, parseJson } from '../util';
import { getSetting, setSetting } from './import';
import { getPreferences } from './preferences';
import { sendPendingEmails } from './notify';

export type RunType = 'discovery' | 'verification' | 'adhoc' | 'import' | 'connection_test';

export const COVERAGE_AREAS = ['bratislava', 'vienna', 'budapest', 'prague', 'europe-artists', 'festivals-nearby', 'festivals-europe', 'ibiza'] as const;

export function serializeRun(r: Awaited<ReturnType<typeof getRun>>) {
  return {
    ...r,
    params: parseJson(r.params, {}),
    coverage: parseJson(r.coverage, []),
    stats: parseJson(r.stats, {}),
  };
}

export async function getRun(ctx: AppContext, id: string) {
  const r = await ctx.db.selectFrom('research_runs').selectAll().where('id', '=', id).executeTakeFirst();
  if (!r) throw new HttpError(404, 'Run not found');
  return r;
}

export async function createRun(
  ctx: AppContext,
  opts: { type: RunType; trigger: 'user' | 'schedule' | 'api' | 'manual_import'; userId?: string | null; params?: Record<string, unknown>; status?: 'queued' | 'running'; executor?: string | null },
) {
  const t = nowIso();
  const status = opts.status ?? 'queued';
  const id = newId('run');
  await ctx.db
    .insertInto('research_runs')
    .values({
      id,
      type: opts.type,
      status,
      trigger: opts.trigger,
      requested_by_user_id: opts.userId ?? null,
      params: JSON.stringify(opts.params ?? {}),
      executor: opts.executor ?? null,
      claimed_at: status === 'running' ? t : null,
      lease_expires_at: status === 'running' ? leaseUntil(ctx) : null,
      heartbeat_at: status === 'running' ? t : null,
      started_at: status === 'running' ? t : null,
      finished_at: null,
      outcome: null,
      summary: null,
      coverage: null,
      stats: JSON.stringify({}),
      error: null,
      dispatch_status: null,
      created_at: t,
      updated_at: t,
    })
    .execute();
  if (status === 'queued') void dispatchWebhook(ctx, id);
  return getRun(ctx, id);
}

function leaseUntil(ctx: AppContext) {
  return new Date(ctx.now().getTime() + ctx.config.runLeaseMinutes * 60_000).toISOString();
}

/** Context sent with each claimed run so the executor starts from current data. */
export async function runBrief(ctx: AppContext, run: { type: string; params: string | null }) {
  const params = parseJson<Record<string, unknown>>(run.params, {});
  return {
    instructions:
      run.type === 'verification'
        ? 'Recheck upcoming listings from GET /verification-queue in batches. Report outcomes with POST /import (verifications[] and changed events[]). Then POST /runs/{id}/complete with coverage.'
        : 'Read GET /context first (watchlist, preferences, scopes). Search for new events, artist appearances, festival lineups, Ibiza residencies and ticket-sale announcements. Send results with POST /import, then POST /runs/{id}/complete with coverage.',
    params,
  };
}

export async function claimNextRun(ctx: AppContext, executor: string, types?: string[]) {
  await sweepExpiredLeases(ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    let q = ctx.db.selectFrom('research_runs').selectAll().where('status', '=', 'queued').orderBy('created_at').limit(1);
    if (types?.length) q = q.where('type', 'in', types);
    const next = await q.executeTakeFirst();
    if (!next) return null;
    const t = nowIso();
    // Conditional update = optimistic lock: only one executor wins a run.
    const res = await ctx.db
      .updateTable('research_runs')
      .set({ status: 'running', executor, claimed_at: t, started_at: t, heartbeat_at: t, lease_expires_at: leaseUntil(ctx), updated_at: t })
      .where('id', '=', next.id)
      .where('status', '=', 'queued')
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) === 1) {
      await setSetting(ctx, 'executor_last_claim_at', t);
      return getRun(ctx, next.id);
    }
  }
  return null;
}

async function requireRunning(ctx: AppContext, id: string) {
  const r = await getRun(ctx, id);
  if (r.status !== 'running') throw new HttpError(409, `Run is ${r.status}`);
  return r;
}

export async function heartbeat(ctx: AppContext, id: string) {
  await requireRunning(ctx, id);
  const t = nowIso();
  await ctx.db.updateTable('research_runs').set({ heartbeat_at: t, lease_expires_at: leaseUntil(ctx), updated_at: t }).where('id', '=', id).execute();
  return getRun(ctx, id);
}

async function recordCoverage(ctx: AppContext, runId: string, runType: string, coverage: CoverageInput[], outcome: string) {
  for (const c of coverage) {
    const t = c.checked_at ?? nowIso();
    const existing = await ctx.db.selectFrom('coverage').selectAll().where('area', '=', c.area).executeTakeFirst();
    const patch =
      c.kind === 'discovery'
        ? { last_discovery_at: t, last_discovery_run_id: runId }
        : { last_verification_at: t, last_verification_run_id: runId };
    if (existing) {
      await ctx.db.updateTable('coverage').set({ ...patch, last_outcome: outcome, note: c.note ?? existing.note, updated_at: nowIso() }).where('area', '=', c.area).execute();
    } else {
      await ctx.db
        .insertInto('coverage')
        .values({ area: c.area, last_discovery_at: null, last_discovery_run_id: null, last_verification_at: null, last_verification_run_id: null, ...patch, last_outcome: outcome, note: c.note ?? null, updated_at: nowIso() })
        .execute();
    }
  }
  void runType;
}

export async function completeRun(
  ctx: AppContext,
  id: string,
  body: { outcome: 'success' | 'partial'; summary?: string; coverage?: CoverageInput[]; stats?: Record<string, number>; errors?: { item_ref?: string; message: string }[] },
) {
  const run = await requireRunning(ctx, id);
  const t = nowIso();
  for (const e of body.errors ?? []) {
    await ctx.db.insertInto('run_errors').values({ id: newId('rer'), run_id: id, item_ref: e.item_ref ?? null, message: e.message, created_at: t }).execute();
  }
  const stats = { ...parseJson<Record<string, number>>(run.stats, {}), ...(body.stats ?? {}) };
  await ctx.db
    .updateTable('research_runs')
    .set({
      status: 'completed',
      outcome: body.outcome,
      summary: body.summary ?? null,
      coverage: JSON.stringify(body.coverage ?? []),
      stats: JSON.stringify(stats),
      finished_at: t,
      lease_expires_at: null,
      updated_at: t,
    })
    .where('id', '=', id)
    .execute();
  if (body.coverage?.length) await recordCoverage(ctx, id, run.type, body.coverage, body.outcome);
  if (run.type === 'discovery' || run.type === 'adhoc') await setSetting(ctx, 'last_successful_discovery_at', t);
  if (run.type === 'verification') await setSetting(ctx, 'last_successful_verification_at', t);
  if (run.type !== 'connection_test') await setSetting(ctx, 'last_successful_run_at', t);
  return getRun(ctx, id);
}

export async function failRun(ctx: AppContext, id: string, body: { error: string; coverage?: CoverageInput[]; errors?: { item_ref?: string; message: string }[] }) {
  const run = await getRun(ctx, id);
  if (!['queued', 'running'].includes(run.status)) throw new HttpError(409, `Run is ${run.status}`);
  const t = nowIso();
  for (const e of body.errors ?? []) {
    await ctx.db.insertInto('run_errors').values({ id: newId('rer'), run_id: id, item_ref: e.item_ref ?? null, message: e.message, created_at: t }).execute();
  }
  await ctx.db
    .updateTable('research_runs')
    .set({ status: 'failed', outcome: 'failed', error: body.error, coverage: JSON.stringify(body.coverage ?? []), finished_at: t, lease_expires_at: null, updated_at: t })
    .where('id', '=', id)
    .execute();
  if (body.coverage?.length) await recordCoverage(ctx, id, run.type, body.coverage, 'failed');
  await setSetting(ctx, 'last_failed_run_at', t);
  return getRun(ctx, id);
}

export async function cancelRun(ctx: AppContext, id: string) {
  const run = await getRun(ctx, id);
  if (run.status !== 'queued') throw new HttpError(409, 'Only queued runs can be cancelled');
  await ctx.db.updateTable('research_runs').set({ status: 'cancelled', finished_at: nowIso(), updated_at: nowIso() }).where('id', '=', id).execute();
  return getRun(ctx, id);
}

/** Running runs whose executor stopped renewing the lease become failed (interrupted). */
export async function sweepExpiredLeases(ctx: AppContext) {
  const now = ctx.now().toISOString();
  const expired = await ctx.db.selectFrom('research_runs').select(['id']).where('status', '=', 'running').where('lease_expires_at', '<', now).execute();
  for (const r of expired) {
    await ctx.db
      .updateTable('research_runs')
      .set({ status: 'failed', outcome: 'failed', error: 'Interrupted: the executor stopped responding before completing the run (lease expired). Imported results were kept.', finished_at: now, lease_expires_at: null, updated_at: now })
      .where('id', '=', r.id)
      .where('status', '=', 'running')
      .execute();
  }
  return expired.length;
}

async function dispatchWebhook(ctx: AppContext, runId: string) {
  const url = ctx.config.researchWebhookUrl;
  if (!url) return;
  const run = await getRun(ctx, runId);
  const body = JSON.stringify({ event: 'run.queued', run_id: run.id, type: run.type, params: parseJson(run.params, {}), api_base: `${ctx.config.publicUrl ?? ''}/api/research/v1` });
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': `${ctx.config.appName}-webhook` };
  if (ctx.config.researchWebhookSecret) {
    headers['x-quartet-signature'] = `sha256=${crypto.createHmac('sha256', ctx.config.researchWebhookSecret).update(body).digest('hex')}`;
  }
  let status: string;
  try {
    const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
    status = `${res.ok ? 'delivered' : 'rejected'} (HTTP ${res.status}) at ${nowIso()}`;
  } catch (err) {
    status = `failed at ${nowIso()}: ${err instanceof Error ? err.message : String(err)}`;
  }
  await ctx.db.updateTable('research_runs').set({ dispatch_status: status, updated_at: nowIso() }).where('id', '=', runId).execute();
}

// ---------------------------------------------------------------- status

export type ExecutorState = 'awaiting_connection' | 'connected' | 'operational' | 'stale' | 'failing';

export async function researchStatus(ctx: AppContext, userId: string) {
  await sweepExpiredLeases(ctx);
  const [tokens, lastSeen, lastClaim, lastImport, lastDiscovery, lastVerification, lastRun, lastTest, coverage, recentRuns, active] = await Promise.all([
    ctx.db.selectFrom('api_tokens').select(['id', 'last_used_at']).where('revoked_at', 'is', null).execute(),
    getSetting<string | null>(ctx, 'executor_last_seen_at', null),
    getSetting<string | null>(ctx, 'executor_last_claim_at', null),
    getSetting<string | null>(ctx, 'last_successful_import_at', null),
    getSetting<string | null>(ctx, 'last_successful_discovery_at', null),
    getSetting<string | null>(ctx, 'last_successful_verification_at', null),
    getSetting<string | null>(ctx, 'last_successful_run_at', null),
    getSetting<{ at: string; ok: boolean } | null>(ctx, 'last_connection_test', null),
    ctx.db.selectFrom('coverage').selectAll().execute(),
    ctx.db.selectFrom('research_runs').selectAll().orderBy('created_at', 'desc').limit(15).execute(),
    ctx.db.selectFrom('research_runs').select(['id', 'status', 'type', 'created_at']).where('status', 'in', ['queued', 'running']).execute(),
  ]);
  const { data: prefs } = await getPreferences(ctx, userId);
  const now = DateTime.fromJSDate(ctx.now());
  const hoursSince = (iso: string | null) => (iso ? now.diff(DateTime.fromISO(iso), 'hours').hours : Infinity);

  let executor: ExecutorState;
  const lastFailed = recentRuns.find((r) => r.status === 'failed');
  const lastCompleted = recentRuns.find((r) => r.status === 'completed' && r.type !== 'connection_test');
  if (!lastSeen) executor = 'awaiting_connection';
  else if (lastFailed && lastFailed.type !== 'import' && (!lastCompleted || lastFailed.created_at > lastCompleted.created_at)) executor = 'failing';
  else if (!lastDiscovery && !lastVerification) executor = 'connected';
  else if (hoursSince(lastDiscovery) > 36 && prefs.schedule.discoveryEnabled) executor = 'stale';
  else executor = 'operational';

  const oldestQueued = active.filter((a) => a.status === 'queued').sort((a, b) => a.created_at.localeCompare(b.created_at))[0];

  return {
    executor: {
      state: executor,
      last_seen_at: lastSeen,
      last_claim_at: lastClaim,
      active_tokens: tokens.length,
      webhook_configured: !!ctx.config.researchWebhookUrl,
      last_connection_test: lastTest,
    },
    last_successful_update_at: lastRun ?? lastImport,
    last_successful_import_at: lastImport,
    last_successful_discovery_at: lastDiscovery,
    last_successful_verification_at: lastVerification,
    queue: {
      active: active.map((a) => ({ id: a.id, status: a.status, type: a.type, created_at: a.created_at })),
      oldest_queued_hours: oldestQueued ? Math.round(hoursSince(oldestQueued.created_at) * 10) / 10 : null,
    },
    schedule: {
      internal_enabled: ctx.config.schedulerEnabled,
      ...prefs.schedule,
      timezone: prefs.planningTimezone,
      // The schedule only produces results when an executor picks the runs up.
      effective: ctx.config.schedulerEnabled && executor !== 'awaiting_connection' ? (executor === 'operational' ? 'operational' : 'needs_attention') : 'awaiting_executor',
    },
    coverage: COVERAGE_AREAS.map((area) => {
      const c = coverage.find((x) => x.area === area);
      return {
        area,
        last_discovery_at: c?.last_discovery_at ?? null,
        last_verification_at: c?.last_verification_at ?? null,
        last_outcome: c?.last_outcome ?? null,
        note: c?.note ?? null,
      };
    }),
    recent_runs: recentRuns.map((r) => serializeRun(r)),
  };
}

// ---------------------------------------------------------------- scheduler

/** Called every minute: enqueue due scheduled runs, expire leases, archive past events, send digests. */
export async function schedulerTick(ctx: AppContext) {
  await sweepExpiredLeases(ctx);
  await archivePastEvents(ctx);
  const users = await ctx.db.selectFrom('users').select('id').execute();
  if (!users.length) return;
  const owner = users[0].id;
  const { data: prefs } = await getPreferences(ctx, owner);
  const now = DateTime.fromJSDate(ctx.now()).setZone(prefs.planningTimezone);
  const today = now.toISODate()!;

  if (ctx.config.schedulerEnabled) {
    const due = async (type: RunType, time: string, slot: string) => {
      const [h, m] = time.split(':').map(Number);
      if (now < now.set({ hour: h, minute: m, second: 0, millisecond: 0 })) return;
      const key = `schedule_slot_${type}`;
      const last = await getSetting<string | null>(ctx, key, null);
      if (last === slot) return;
      const pending = await ctx.db.selectFrom('research_runs').select('id').where('type', '=', type).where('status', 'in', ['queued', 'running']).executeTakeFirst();
      await setSetting(ctx, key, slot);
      if (pending) return; // never stack duplicate runs
      await createRun(ctx, { type, trigger: 'schedule', params: { slot } });
    };
    if (prefs.schedule.discoveryEnabled) await due('discovery', prefs.schedule.discoveryTime, today);
    if (prefs.schedule.verificationEnabled && now.weekday === prefs.schedule.verificationWeekday) {
      await due('verification', prefs.schedule.verificationTime, `${now.weekYear}-W${now.weekNumber}`);
    }
  }

  for (const u of users) {
    const { data: p } = await getPreferences(ctx, u.id);
    const email = p.notifications.email;
    if (email.enabled && email.mode === 'daily') {
      const [h, m] = email.dailyTime.split(':').map(Number);
      const local = DateTime.fromJSDate(ctx.now()).setZone(p.planningTimezone);
      if (local >= local.set({ hour: h, minute: m, second: 0, millisecond: 0 })) {
        const key = `digest_sent_${u.id}`;
        if ((await getSetting<string | null>(ctx, key, null)) !== local.toISODate()) {
          await setSetting(ctx, key, local.toISODate());
          await sendPendingEmails(ctx, u.id).catch(() => undefined);
        }
      }
    }
  }
}

/** Events that ended more than a day ago are archived (kept, with bookings, in history). */
export async function archivePastEvents(ctx: AppContext) {
  const cutoff = new Date(ctx.now().getTime() - 24 * 3600_000).toISOString();
  const res = await ctx.db.updateTable('events').set({ archived_at: nowIso() }).where('archived_at', 'is', null).where('span_end_utc', '<', cutoff).executeTakeFirst();
  return Number(res.numUpdatedRows ?? 0);
}

export function startScheduler(ctx: AppContext) {
  const tick = () => schedulerTick(ctx).catch((err) => console.error('[scheduler]', err));
  const first = setTimeout(tick, 5_000);
  const timer = setInterval(tick, 60_000);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
