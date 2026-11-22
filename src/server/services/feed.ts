// In-app update feed. Items are generated from research changes and
// de-duplicated by a key that encodes the new information, so repeated checks
// of unchanged data never produce repeated alerts.
import type { FeedType } from '../../shared/taxonomy';
import { formatLocal } from '../../shared/dates';
import type { AppContext } from '../context';
import { newId, nowIso, sha256 } from '../util';
import { hydrate, type EventSummary } from './events';
import { loadPersonalContext } from './preferences';
import { sendPendingEmails } from './notify';

export interface EventChangeSummary {
  eventId: string;
  created: boolean;
  lineupAdded: { artist_id: string; name: string; billing: string; format: string; date: string | null }[];
  fieldChanges: { field: string; old: unknown; new: unknown }[];
}

interface Draft {
  type: FeedType;
  event_id: string;
  artist_id?: string;
  title: string;
  body: string;
  dedupe: string;
}

function placeOf(e: EventSummary) {
  return [e.venue?.name ?? e.location_text, e.town ?? e.city].filter(Boolean).join(', ');
}

export async function generateFeedForChanges(ctx: AppContext, summaries: EventChangeSummary[]): Promise<number> {
  if (!summaries.length) return 0;
  const users = await ctx.db.selectFrom('users').select('id').execute();
  let created = 0;
  const ids = [...new Set(summaries.map((s) => s.eventId))];
  const rows = await ctx.db.selectFrom('events').selectAll().where('id', 'in', ids).execute();
  for (const u of users) {
    const p = await loadPersonalContext(ctx, u.id);
    const events = new Map((await hydrate(ctx, rows, p)).map((e) => [e.id, e]));
    const drafts: Draft[] = [];
    const nowIso2 = ctx.now().toISOString();
    for (const s of summaries) {
      const e = events.get(s.eventId);
      if (!e || e.archived) continue;
      if (e.end_utc < nowIso2) continue;
      if (e.state.hidden) continue;
      const saved = e.state.favourite || e.state.plan_status !== 'none';
      const followed = e.artists.some((a) => a.followed);
      // A cancelled event loses its highlight score, so judge relevance as it was before.
      const relevant = saved || followed || (e.status === 'cancelled' ? e.score + 100 >= p.prefs.highlightThreshold : e.highlight);
      const when = formatLocal(e.next_occurrence?.start_local ?? e.start_local);

      // Followed-artist appearances (new event or newly added to a lineup).
      const followedAdded = (s.created ? e.artists.map((a) => ({ artist_id: a.artist_id, name: a.name, format: a.format })) : s.lineupAdded).filter(
        (a) => p.watch.get(a.artist_id) === 'active',
      );
      for (const a of followedAdded) {
        drafts.push({
          type: 'new_appearance',
          event_id: e.id,
          artist_id: a.artist_id,
          title: `${a.name} — ${e.title}`,
          body: `${when} · ${placeOf(e)}${a.format && a.format !== 'unknown' ? ` · ${a.format === 'dj_set' ? 'DJ set' : a.format === 'live' ? 'Live show' : a.format}` : ''}`,
          dedupe: `appearance:${e.id}:${a.artist_id}`,
        });
      }
      if (s.created && !followedAdded.length && e.highlight) {
        drafts.push({ type: 'new_event', event_id: e.id, title: e.title, body: `${when} · ${placeOf(e)}`, dedupe: `new:${e.id}` });
      }
      if (!s.created && relevant) {
        const nonFollowedAdds = s.lineupAdded.filter((a) => p.watch.get(a.artist_id) !== 'active' && ['headliner', 'special_guest'].includes(a.billing));
        if (nonFollowedAdds.length) {
          drafts.push({
            type: 'lineup_addition',
            event_id: e.id,
            title: `Lineup update: ${e.title}`,
            body: `Added: ${nonFollowedAdds.map((a) => a.name).join(', ')}`,
            dedupe: `lineup:${e.id}:${nonFollowedAdds.map((a) => a.artist_id).sort().join(',')}`,
          });
        }
        for (const c of s.fieldChanges) {
          if (c.field === 'start_local') {
            drafts.push({ type: 'date_change', event_id: e.id, title: `Date changed: ${e.title}`, body: `Now ${formatLocal(String(c.new))} (was ${formatLocal(String(c.old))})`, dedupe: `date:${e.id}:${c.new}` });
          }
          if (c.field === 'venue_id') {
            drafts.push({ type: 'venue_change', event_id: e.id, title: `Venue changed: ${e.title}`, body: `Now at ${placeOf(e)}`, dedupe: `venue:${e.id}:${c.new}` });
          }
          if (c.field === 'status' && (c.new === 'cancelled' || c.new === 'postponed')) {
            drafts.push({
              type: c.new === 'cancelled' ? 'cancellation' : 'postponement',
              event_id: e.id,
              title: `${c.new === 'cancelled' ? 'Cancelled' : 'Postponed'}: ${e.title}`,
              body: e.status_note ?? when,
              dedupe: `status:${e.id}:${c.new}`,
            });
          }
          if (c.field === 'status' && c.new === 'rescheduled') {
            drafts.push({ type: 'date_change', event_id: e.id, title: `Rescheduled: ${e.title}`, body: `New date: ${when}`, dedupe: `date:${e.id}:${e.start_local}` });
          }
        }
      }
      const saleChange = s.fieldChanges.filter((c) => c.field === 'presale_at' || c.field === 'onsale_at');
      if ((relevant || followedAdded.length) && (saleChange.length || (s.created && (e.presale_at || e.onsale_at)))) {
        if ((e.presale_at && e.presale_at > nowIso2.slice(0, 16)) || (e.onsale_at && e.onsale_at > nowIso2.slice(0, 16)) || saleChange.length) {
          const parts = [e.presale_at && `Presale ${formatLocal(e.presale_at)}`, e.onsale_at && `General sale ${formatLocal(e.onsale_at)}`].filter(Boolean);
          drafts.push({
            type: 'ticket_sale',
            event_id: e.id,
            title: `Tickets: ${e.title}`,
            body: `${parts.join(' · ')}${e.sale_timezone ? ` (${e.sale_timezone})` : ''}`,
            dedupe: `sale:${e.id}:${sha256(`${e.presale_at}|${e.onsale_at}`).slice(0, 12)}`,
          });
        }
      }
    }
    const enabled = p.prefs.notifications.inApp;
    for (const d of drafts) {
      if (enabled[d.type] === false) continue;
      const email = p.prefs.notifications.email;
      const ev = events.get(d.event_id);
      const emailWanted =
        email.enabled && email.types.includes(d.type) && (!email.savedOnly || (ev && (ev.state.favourite || ev.state.plan_status !== 'none')));
      const res = await ctx.db
        .insertInto('feed_items')
        .values({
          id: newId('fd'),
          user_id: u.id,
          type: d.type,
          event_id: d.event_id,
          artist_id: d.artist_id ?? null,
          title: d.title,
          body: d.body,
          dedupe_key: d.dedupe,
          email_status: emailWanted ? 'pending' : 'not_applicable',
          created_at: nowIso(),
          read_at: null,
        })
        .onConflict((oc) => oc.columns(['user_id', 'dedupe_key']).doNothing())
        .executeTakeFirst();
      if (Number(res.numInsertedOrUpdatedRows ?? 0) > 0) created++;
    }
    if (p.prefs.notifications.email.enabled && p.prefs.notifications.email.mode === 'immediate') {
      await sendPendingEmails(ctx, u.id).catch(() => undefined);
    }
  }
  return created;
}

export async function listFeed(ctx: AppContext, userId: string, limit = 100) {
  const items = await ctx.db.selectFrom('feed_items').selectAll().where('user_id', '=', userId).orderBy('created_at', 'desc').limit(limit).execute();
  const unread = await ctx.db
    .selectFrom('feed_items')
    .select(ctx.db.fn.countAll<number>().as('n'))
    .where('user_id', '=', userId)
    .where('read_at', 'is', null)
    .executeTakeFirst();
  return { items, unread: Number(unread?.n ?? 0) };
}

export async function markFeedRead(ctx: AppContext, userId: string, ids: string[] | 'all') {
  let q = ctx.db.updateTable('feed_items').set({ read_at: nowIso() }).where('user_id', '=', userId).where('read_at', 'is', null);
  if (ids !== 'all') q = q.where('id', 'in', ids.length ? ids : ['-']);
  await q.execute();
}
