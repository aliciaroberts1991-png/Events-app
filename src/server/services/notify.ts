// Email delivery through any SMTP provider (configured with SMTP_URL or SMTP_HOST…).
// The status shown in the app is derived from real outcomes: it only reads
// "Working" after an email has actually been accepted by the provider.
import nodemailer, { type Transporter } from 'nodemailer';
import { FEED_TYPE_LABELS, type FeedType } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import { newId, nowIso } from '../util';
import { getPreferences } from './preferences';

export type EmailState = 'not_configured' | 'configured_untested' | 'working' | 'failing';

let transporterCache: { url: string; t: Transporter } | null = null;
function transporter(ctx: AppContext) {
  if (!ctx.config.smtpUrl) return null;
  if (!transporterCache || transporterCache.url !== ctx.config.smtpUrl) {
    transporterCache = { url: ctx.config.smtpUrl, t: nodemailer.createTransport(ctx.config.smtpUrl) };
  }
  return transporterCache.t;
}

export async function emailStatus(ctx: AppContext, userId: string) {
  const configured = !!(ctx.config.smtpUrl && ctx.config.emailFrom);
  const last = await ctx.db
    .selectFrom('notification_deliveries')
    .selectAll()
    .where('user_id', '=', userId)
    .where('channel', '=', 'email')
    .orderBy('attempted_at', 'desc')
    .limit(10)
    .execute();
  let state: EmailState = 'not_configured';
  if (configured) {
    if (!last.length) state = 'configured_untested';
    else state = last[0].status === 'sent' ? 'working' : 'failing';
  }
  return {
    state,
    provider: configured ? describeProvider(ctx.config.smtpUrl!) : null,
    from: ctx.config.emailFrom,
    missing: [!ctx.config.smtpUrl && 'SMTP_URL (or SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD)', !ctx.config.emailFrom && 'EMAIL_FROM'].filter(Boolean),
    recent: last.map((d) => ({ id: d.id, status: d.status, item_count: d.item_count, error: d.error, provider_response: d.provider_response, attempted_at: d.attempted_at })),
  };
}

function describeProvider(url: string) {
  try {
    const u = new URL(url);
    return `${u.protocol.replace(':', '').toUpperCase()} via ${u.hostname}:${u.port || (u.protocol === 'smtps:' ? 465 : 587)}`;
  } catch {
    return 'SMTP';
  }
}

async function send(ctx: AppContext, userId: string, to: string, subject: string, text: string, itemCount: number) {
  const t = transporter(ctx);
  if (!t || !ctx.config.emailFrom) throw new Error('Email is not configured on the server');
  try {
    const info = await t.sendMail({ from: ctx.config.emailFrom, to, subject, text });
    await ctx.db
      .insertInto('notification_deliveries')
      .values({ id: newId('dlv'), user_id: userId, channel: 'email', status: 'sent', item_count: itemCount, provider_response: String(info.response ?? info.messageId ?? 'accepted').slice(0, 500), error: null, attempted_at: nowIso() })
      .execute();
    return { ok: true as const, response: info.response };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await ctx.db
      .insertInto('notification_deliveries')
      .values({ id: newId('dlv'), user_id: userId, channel: 'email', status: 'failed', item_count: itemCount, provider_response: null, error: message.slice(0, 1000), attempted_at: nowIso() })
      .execute();
    return { ok: false as const, error: message };
  }
}

export async function sendTestEmail(ctx: AppContext, userId: string, to: string) {
  if (!ctx.config.smtpUrl || !ctx.config.emailFrom) return { ok: false as const, error: 'Email is not configured on the server (set SMTP_URL and EMAIL_FROM).' };
  return send(ctx, userId, to, `${ctx.config.appName}: test email`, `This is a test from ${ctx.config.appName}. Email notifications are working.`, 0);
}

/** Send one summary email containing all pending feed items. */
export async function sendPendingEmails(ctx: AppContext, userId: string) {
  const { data: prefs } = await getPreferences(ctx, userId);
  const email = prefs.notifications.email;
  if (!email.enabled || !email.address) return { sent: false, reason: 'Email notifications are off' };
  if (!ctx.config.smtpUrl || !ctx.config.emailFrom) return { sent: false, reason: 'Email is not configured on the server' };
  const items = await ctx.db.selectFrom('feed_items').selectAll().where('user_id', '=', userId).where('email_status', '=', 'pending').orderBy('created_at').execute();
  if (!items.length) return { sent: false, reason: 'Nothing new' };
  const base = ctx.config.publicUrl?.replace(/\/$/, '') ?? '';
  const lines = items.map((i) => `• [${FEED_TYPE_LABELS[i.type as FeedType] ?? i.type}] ${i.title}\n  ${i.body ?? ''}${i.event_id && base ? `\n  ${base}/events/${i.event_id}` : ''}`);
  const res = await send(ctx, userId, email.address, `${ctx.config.appName}: ${items.length} update${items.length === 1 ? '' : 's'}`, lines.join('\n\n'), items.length);
  await ctx.db
    .updateTable('feed_items')
    .set({ email_status: res.ok ? 'sent' : 'failed' })
    .where('id', 'in', items.map((i) => i.id))
    .execute();
  return { sent: res.ok, reason: res.ok ? undefined : res.error };
}
