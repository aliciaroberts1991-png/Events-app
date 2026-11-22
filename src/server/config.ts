// Runtime configuration from environment variables. See .env.example.
import path from 'node:path';

function bool(v: string | undefined, dflt = false) {
  if (v === undefined || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export interface Config {
  appName: string;
  env: string;
  port: number;
  host: string;
  publicUrl: string | null;
  databaseUrl: string;
  sessionDays: number;
  cookieSecure: boolean;
  ownerEmail: string | null;
  ownerPassword: string | null;
  researchWebhookUrl: string | null;
  researchWebhookSecret: string | null;
  runLeaseMinutes: number;
  smtpUrl: string | null;
  emailFrom: string | null;
  schedulerEnabled: boolean;
  seedDemo: boolean;
  trustProxy: boolean;
  allowLinkExtraction: boolean;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const e = process.env;
  const env = e.NODE_ENV ?? 'development';
  const smtpUrl =
    e.SMTP_URL ||
    (e.SMTP_HOST
      ? `smtp${bool(e.SMTP_SECURE) ? 's' : ''}://${encodeURIComponent(e.SMTP_USER ?? '')}:${encodeURIComponent(e.SMTP_PASSWORD ?? '')}@${e.SMTP_HOST}:${e.SMTP_PORT ?? '587'}`
      : null);
  return {
    appName: e.APP_NAME || 'Quartet',
    env,
    port: Number(e.PORT ?? 3000),
    host: e.HOST ?? '0.0.0.0',
    publicUrl: e.PUBLIC_URL || null,
    databaseUrl: e.DATABASE_URL || `sqlite:${path.resolve('data/quartet.db')}`,
    sessionDays: Number(e.SESSION_DAYS ?? 90),
    cookieSecure: bool(e.COOKIE_SECURE, env === 'production'),
    ownerEmail: e.OWNER_EMAIL || null,
    ownerPassword: e.OWNER_PASSWORD || null,
    researchWebhookUrl: e.RESEARCH_WEBHOOK_URL || null,
    researchWebhookSecret: e.RESEARCH_WEBHOOK_SECRET || null,
    runLeaseMinutes: Number(e.RUN_LEASE_MINUTES ?? 45),
    smtpUrl,
    emailFrom: e.EMAIL_FROM || null,
    schedulerEnabled: bool(e.SCHEDULER_ENABLED, true),
    seedDemo: bool(e.SEED_DEMO, false),
    trustProxy: bool(e.TRUST_PROXY, true),
    allowLinkExtraction: bool(e.ALLOW_LINK_EXTRACTION, true),
    ...overrides,
  };
}
