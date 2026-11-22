import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Download, KeyRound, RefreshCw, Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { CATEGORY_GROUPS, FEED_TYPE_LABELS, FEED_TYPES, GENRES, WEEKDAYS } from '../../shared/taxonomy';
import { SearchNowButton } from '../components/Layout';
import { EventCard } from '../components/EventCard';
import { Badge, Empty, ErrorNote, Field, PageHeader, Spinner, Toggle } from '../components/ui';
import { api, download, errorMessage, get } from '../lib/api';
import { relative, stamp } from '../lib/format';
import { useMeta, useStatus, useToast } from '../lib/hooks';

const SECTIONS = [
  ['interests', 'Interests'],
  ['places', 'Places and time'],
  ['notifications', 'Notifications'],
  ['research', 'Research and updates'],
  ['data', 'Your data'],
  ['account', 'Account'],
] as const;

const WEIGHT_LABELS: Record<string, string> = { '-3': 'Never', '-2': 'Rarely', '-1': 'Less', '0': 'Neutral', '1': 'Like', '2': 'Love', '3': 'Top priority' };

function usePrefs() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['preferences'], queryFn: () => get('/api/preferences') });
  const save = async (data: any) => {
    try {
      await api('PUT', '/api/preferences', { data, version: q.data.version });
      toast('Saved');
      qc.invalidateQueries();
    } catch (e) {
      toast(errorMessage(e), 'error');
      qc.invalidateQueries({ queryKey: ['preferences'] });
    }
  };
  return { q, save };
}

function WeightSelect({ value, onChange, label }: { value: number | undefined; onChange: (v: number) => void; label: string }) {
  return (
    <label className="weight">
      <span>{label}</span>
      <select value={String(value ?? 0)} onChange={(e) => onChange(Number(e.target.value))} className={`w${value ?? 0}`}>
        {[3, 2, 1, 0, -1, -2, -3].map((w) => (
          <option key={w} value={w}>
            {WEIGHT_LABELS[String(w)]}
          </option>
        ))}
      </select>
    </label>
  );
}

function Interests() {
  const { q, save } = usePrefs();
  const [d, setD] = useState<any>(null);
  const qc = useQueryClient();
  const toast = useToast();
  useEffect(() => setD(q.data?.data ?? null), [q.data]);
  if (!d) return <Spinner />;
  const setW = (k: 'categoryWeights' | 'genreWeights', slug: string, w: number) => setD({ ...d, [k]: { ...d[k], [slug]: w } });
  return (
    <div className="settings-sec">
      <p className="muted">Highlights favour what you rate highly. “Never” keeps a category out of Highlights; it still appears under All events.</p>
      {CATEGORY_GROUPS.map((g) => (
        <fieldset key={g.slug} className="card weights">
          <legend>
            <WeightSelect label={g.label} value={d.categoryWeights[g.slug]} onChange={(w) => setW('categoryWeights', g.slug, w)} />
          </legend>
          <div className="weight-grid">
            {g.children.map(([s, l]) => (
              <WeightSelect key={s} label={l} value={d.categoryWeights[s]} onChange={(w) => setW('categoryWeights', s, w)} />
            ))}
          </div>
        </fieldset>
      ))}
      <fieldset className="card weights">
        <legend>Genres</legend>
        <div className="weight-grid">
          {GENRES.map((g) => (
            <WeightSelect key={g.slug} label={g.parent ? `— ${g.label}` : g.label} value={d.genreWeights[g.slug]} onChange={(w) => setW('genreWeights', g.slug, w)} />
          ))}
        </div>
      </fieldset>
      <fieldset className="card">
        <legend>Highlights</legend>
        <Field label={`Highlight threshold: ${d.highlightThreshold}`} hint="Lower shows more events as highlights">
          <input type="range" min={20} max={90} step={5} value={d.highlightThreshold} onChange={(e) => setD({ ...d, highlightThreshold: Number(e.target.value) })} />
        </Field>
        <Toggle checked={d.preferEnglishFriendly} onChange={(v) => setD({ ...d, preferEnglishFriendly: v })} label="Prefer events I can follow in English" hint="Events where another language is essential rank lower" />
        <Field label="Languages you understand" hint="Comma-separated codes, e.g. en, sk">
          <input value={d.spokenLanguages.join(', ')} onChange={(e) => setD({ ...d, spokenLanguages: e.target.value.split(',').map((x: string) => x.trim()).filter(Boolean) })} />
        </Field>
      </fieldset>
      <div className="form-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={async () => {
            await api('DELETE', '/api/feedback');
            toast('“Fewer like this” feedback cleared');
            qc.invalidateQueries();
          }}
        >
          Clear “fewer like this” feedback
        </button>
        <button type="button" className="btn btn-primary" onClick={() => save(d)}>
          Save interests
        </button>
      </div>
    </div>
  );
}

function Places() {
  const { q, save } = usePrefs();
  const meta = useMeta();
  const [d, setD] = useState<any>(null);
  useEffect(() => setD(q.data?.data ?? null), [q.data]);
  if (!d) return <Spinner />;
  return (
    <div className="settings-sec">
      <fieldset className="card">
        <legend>Cities and nearby areas</legend>
        <div className="picker-children">
          {(meta.data?.hubs ?? []).map((h) => (
            <label key={h.slug} className="inline-check">
              <input
                type="checkbox"
                checked={d.defaultHubs.includes(h.slug)}
                onChange={(e) => setD({ ...d, defaultHubs: e.target.checked ? [...d.defaultHubs, h.slug] : d.defaultHubs.filter((x: string) => x !== h.slug) })}
              />
              {h.name}
            </label>
          ))}
        </div>
        <Toggle checked={d.includeNearby} onChange={(v) => setD({ ...d, includeNearby: v })} label="Include nearby areas by default" />
        <Field label={`Nearby means within ${d.nearbyRadiusKm} km of a city centre`}>
          <input type="range" min={5} max={120} step={5} value={d.nearbyRadiusKm} onChange={(e) => setD({ ...d, nearbyRadiusKm: Number(e.target.value) })} />
        </Field>
        <Field label={`“Nearby” festivals: within ${d.festivalNearbyRadiusKm} km of any of the four cities`}>
          <input type="range" min={50} max={600} step={25} value={d.festivalNearbyRadiusKm} onChange={(e) => setD({ ...d, festivalNearbyRadiusKm: Number(e.target.value) })} />
        </Field>
      </fieldset>
      <fieldset className="card">
        <legend>Time</legend>
        <Field label="Planning time zone" hint="Used for date filters, the calendar and clash checks. Events always show their own local time too.">
          <select value={d.planningTimezone} onChange={(e) => setD({ ...d, planningTimezone: e.target.value })}>
            {['Europe/Bratislava', 'Europe/Vienna', 'Europe/Prague', 'Europe/Budapest', 'Europe/London', 'Europe/Madrid'].map((z) => (
              <option key={z}>{z}</option>
            ))}
          </select>
        </Field>
      </fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => save(d)}>
          Save
        </button>
      </div>
    </div>
  );
}

function Notifications() {
  const { q, save } = usePrefs();
  const toast = useToast();
  const st = useQuery({ queryKey: ['notif-status'], queryFn: () => get('/api/notifications/status') });
  const [d, setD] = useState<any>(null);
  useEffect(() => setD(q.data?.data ?? null), [q.data]);
  if (!d) return <Spinner />;
  const s = st.data;
  const n = d.notifications;
  const setN = (patch: any) => setD({ ...d, notifications: { ...n, ...patch } });
  const stateLabel: Record<string, [string, string]> = {
    not_configured: ['Not configured', 'neutral'],
    configured_untested: ['Configured — not yet tested', 'info'],
    working: ['Working', 'ok'],
    failing: ['Last delivery failed', 'danger'],
  };
  return (
    <div className="settings-sec">
      <fieldset className="card">
        <legend>In-app updates</legend>
        <p className="muted small">Choose what appears in Updates. Repeated checks never repeat an update unless something actually changed.</p>
        {FEED_TYPES.map((t) => (
          <Toggle key={t} checked={n.inApp[t] !== false} onChange={(v) => setN({ inApp: { ...n.inApp, [t]: v } })} label={FEED_TYPE_LABELS[t]} />
        ))}
      </fieldset>
      <fieldset className="card">
        <legend>Email</legend>
        <p>
          Delivery status: {s ? <Badge tone={stateLabel[s.state][1]}>{stateLabel[s.state][0]}</Badge> : '…'} {s?.provider && <span className="muted small">{s.provider}</span>}
        </p>
        {s?.state === 'not_configured' && <p className="small">The server needs {s.missing.join(' and ')} before email can be sent. See the deployment guide.</p>}
        <Toggle checked={n.email.enabled} onChange={(v) => setN({ email: { ...n.email, enabled: v } })} label="Send email updates" />
        <Field label="Email address">
          <input type="email" value={n.email.address ?? ''} onChange={(e) => setN({ email: { ...n.email, address: e.target.value || null } })} />
        </Field>
        <div className="form-row">
          <Field label="How often">
            <select value={n.email.mode} onChange={(e) => setN({ email: { ...n.email, mode: e.target.value } })}>
              <option value="daily">Daily summary</option>
              <option value="immediate">After each research run</option>
            </select>
          </Field>
          {n.email.mode === 'daily' && (
            <Field label="Daily summary time">
              <input type="time" value={n.email.dailyTime} onChange={(e) => setN({ email: { ...n.email, dailyTime: e.target.value } })} />
            </Field>
          )}
        </div>
        <Toggle checked={n.email.savedOnly} onChange={(v) => setN({ email: { ...n.email, savedOnly: v } })} label="Only for events I’ve saved or planned" />
        <div className="picker-children">
          {FEED_TYPES.map((t) => (
            <label key={t} className="inline-check">
              <input type="checkbox" checked={n.email.types.includes(t)} onChange={(e) => setN({ email: { ...n.email, types: e.target.checked ? [...n.email.types, t] : n.email.types.filter((x: string) => x !== t) } })} />
              {FEED_TYPE_LABELS[t]}
            </label>
          ))}
        </div>
        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={s?.state === 'not_configured'}
            onClick={async () => {
              const r = await api('POST', '/api/notifications/test', {});
              toast(r.ok ? 'Test email accepted by the provider' : `Test failed: ${r.error}`, r.ok ? 'ok' : 'error');
              st.refetch();
            }}
          >
            Send a test email
          </button>
        </div>
        {s?.recent.length > 0 && (
          <details>
            <summary>Recent deliveries</summary>
            <ul className="plain-list small">
              {s.recent.map((r: any) => (
                <li key={r.id}>
                  {stamp(r.attempted_at)} · {r.status === 'sent' ? 'Sent' : 'Failed'} · {r.item_count} update{r.item_count === 1 ? '' : 's'} {r.error && <span className="muted">— {r.error}</span>}
                </li>
              ))}
            </ul>
          </details>
        )}
        <p className="muted small">Push notifications are not set up; email covers alerts away from the app.</p>
      </fieldset>
      <div className="form-actions">
        <button type="button" className="btn btn-primary" onClick={() => save(d)}>
          Save notification settings
        </button>
      </div>
    </div>
  );
}

const EXECUTOR_TEXT: Record<string, [string, string, string]> = {
  awaiting_connection: ['Awaiting connection', 'neutral', 'No research service has authenticated yet. Create a token below and connect ChatGPT or another executor, or use manual import.'],
  connected: ['Connected — no research run completed yet', 'info', 'An executor has authenticated, but no discovery or verification run has completed.'],
  operational: ['Operational', 'ok', 'Research runs are completing on schedule.'],
  stale: ['Stale', 'warn', 'No discovery run has completed in the last 36 hours.'],
  failing: ['Failing', 'danger', 'The most recent run failed. Existing listings are kept.'],
};

function Research() {
  const qc = useQueryClient();
  const toast = useToast();
  const status = useStatus();
  const tokens = useQuery({ queryKey: ['tokens'], queryFn: () => get('/api/research-tokens') });
  const server = useQuery({ queryKey: ['server'], queryFn: () => get('/api/settings/server') });
  const meta = useMeta();
  const { q: prefs, save } = usePrefs();
  const [newToken, setNewToken] = useState<string | null>(null);
  const [tokenName, setTokenName] = useState('ChatGPT research');
  const [importText, setImportText] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  const s = status.data;
  if (!s) return <Spinner />;
  const ex = EXECUTOR_TEXT[s.executor.state];
  const sched = prefs.data?.data.schedule;
  const names: Record<string, string> = { 'europe-artists': 'Followed artists across Europe', 'festivals-nearby': 'Festivals nearby', 'festivals-europe': 'Festivals across Europe', ibiza: 'Ibiza' };
  for (const h of meta.data?.hubs ?? []) names[h.slug] = h.name;
  const origin = window.location.origin;
  return (
    <div className="settings-sec">
      <section className="card">
        <h2 className="side-title">Status</h2>
        <dl className="kv">
          <div className="kv-row">
            <dt>Research service</dt>
            <dd>
              <Badge tone={ex[1]}>{ex[0]}</Badge> <span className="muted small">{ex[2]}</span>
            </dd>
          </div>
          <div className="kv-row">
            <dt>Last successful update</dt>
            <dd>{s.last_successful_update_at ? `${stamp(s.last_successful_update_at)} (${relative(s.last_successful_update_at)})` : 'Never'}</dd>
          </div>
          <div className="kv-row">
            <dt>Last discovery / verification</dt>
            <dd>
              {stamp(s.last_successful_discovery_at)} / {stamp(s.last_successful_verification_at)}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Executor last seen</dt>
            <dd>{s.executor.last_seen_at ? relative(s.executor.last_seen_at) : 'Never'}</dd>
          </div>
          <div className="kv-row">
            <dt>Scheduling</dt>
            <dd>
              {s.schedule.effective === 'operational' ? (
                <Badge tone="ok">Operational</Badge>
              ) : s.schedule.effective === 'awaiting_executor' ? (
                <Badge tone="neutral">Runs are queued on schedule, awaiting an executor to process them</Badge>
              ) : (
                <Badge tone="warn">Needs attention</Badge>
              )}
              {!s.schedule.internal_enabled && <span className="muted small"> Internal scheduler is turned off on the server.</span>}
            </dd>
          </div>
          <div className="kv-row">
            <dt>Webhook push</dt>
            <dd>{s.executor.webhook_configured ? 'Configured (RESEARCH_WEBHOOK_URL)' : 'Not configured — executors poll for queued runs'}</dd>
          </div>
          <div className="kv-row">
            <dt>Database</dt>
            <dd>{server.data?.database === 'postgres' ? 'PostgreSQL' : 'SQLite'}</dd>
          </div>
        </dl>
        <div className="btn-row">
          <SearchNowButton />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => status.refetch()}>
            <RefreshCw size={15} aria-hidden /> Refresh status
          </button>
        </div>
      </section>

      <section className="card">
        <h2 className="side-title">Coverage and freshness</h2>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Area</th>
                <th scope="col">Last discovery</th>
                <th scope="col">Last verification</th>
                <th scope="col">Outcome</th>
              </tr>
            </thead>
            <tbody>
              {s.coverage.map((c: any) => (
                <tr key={c.area}>
                  <th scope="row">{names[c.area] ?? c.area}</th>
                  <td>{c.last_discovery_at ? relative(c.last_discovery_at) : <span className="muted">Never</span>}</td>
                  <td>{c.last_verification_at ? relative(c.last_verification_at) : <span className="muted">Never</span>}</td>
                  <td>{c.last_outcome ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2 className="side-title">Recent runs</h2>
        {s.recent_runs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Requested</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {s.recent_runs.map((r: any) => (
                  <tr key={r.id}>
                    <td>
                      {stamp(r.created_at)}
                      <div className="muted small">{r.trigger === 'schedule' ? 'Scheduled' : r.trigger === 'user' ? 'Search now' : r.trigger === 'manual_import' ? 'Manual import' : 'Executor'}</div>
                    </td>
                    <td>{r.type.replace('_', ' ')}</td>
                    <td>
                      <Badge tone={r.status === 'completed' ? 'ok' : r.status === 'failed' ? 'danger' : r.status === 'running' ? 'info' : 'neutral'}>{r.status}</Badge>
                      {r.status === 'queued' && (
                        <button
                          type="button"
                          className="btn btn-link small"
                          onClick={async () => {
                            await api('POST', `/api/runs/${r.id}/cancel`, {});
                            qc.invalidateQueries({ queryKey: ['status'] });
                          }}
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                    <td className="small">
                      {r.error ?? r.summary ?? ''}
                      {r.stats && Object.keys(r.stats).length > 0 && <div className="muted">{['created', 'updated', 'unchanged', 'error'].filter((k) => r.stats[k] !== undefined).map((k) => `${r.stats[k]} ${k}`).join(' · ')}</div>}
                      {r.dispatch_status && <div className="muted">Webhook: {r.dispatch_status}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No runs yet.</p>
        )}
      </section>

      {sched && (
        <section className="card">
          <h2 className="side-title">Schedule</h2>
          <p className="muted small">The app queues these runs itself; a connected executor picks them up. Times are in {prefs.data.data.planningTimezone}.</p>
          <div className="form-row">
            <Toggle checked={sched.discoveryEnabled} onChange={(v) => save({ ...prefs.data.data, schedule: { ...sched, discoveryEnabled: v } })} label="Daily discovery" />
            <Field label="Time">
              <input type="time" value={sched.discoveryTime} onChange={(e) => save({ ...prefs.data.data, schedule: { ...sched, discoveryTime: e.target.value } })} />
            </Field>
          </div>
          <div className="form-row">
            <Toggle checked={sched.verificationEnabled} onChange={(v) => save({ ...prefs.data.data, schedule: { ...sched, verificationEnabled: v } })} label="Weekly verification" />
            <Field label="Day">
              <select value={sched.verificationWeekday} onChange={(e) => save({ ...prefs.data.data, schedule: { ...sched, verificationWeekday: Number(e.target.value) } })}>
                {WEEKDAYS.map((w, i) => (
                  <option key={w} value={i + 1}>
                    {w}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Time">
              <input type="time" value={sched.verificationTime} onChange={(e) => save({ ...prefs.data.data, schedule: { ...sched, verificationTime: e.target.value } })} />
            </Field>
          </div>
        </section>
      )}

      <section className="card">
        <h2 className="side-title">Connect a research service</h2>
        <p className="small">
          The research API lives at <code>{origin}/api/research/v1</code>. Its OpenAPI description (for ChatGPT Actions and other clients) is at{' '}
          <a href="/api/research/v1/openapi.json" target="_blank" rel="noreferrer">
            /api/research/v1/openapi.json
          </a>
          . See <code>docs/RESEARCH_API.md</code> for the protocol.
        </p>
        <div className="inline-form">
          <label className="grow">
            <span className="sr-only">Token name</span>
            <input value={tokenName} onChange={(e) => setTokenName(e.target.value)} />
          </label>
          <button
            type="button"
            className="btn btn-primary"
            onClick={async () => {
              try {
                const r = await api('POST', '/api/research-tokens', { name: tokenName });
                setNewToken(r.token);
                tokens.refetch();
              } catch (e) {
                toast(errorMessage(e), 'error');
              }
            }}
          >
            <KeyRound size={16} aria-hidden /> Create token
          </button>
        </div>
        {newToken && (
          <div className="token-box" role="status">
            <p className="small">
              <strong>Copy this token now</strong> — it is shown only once. Store it as a secret in the research service.
            </p>
            <code className="token">{newToken}</code>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => {
                navigator.clipboard.writeText(newToken).then(() => toast('Copied'));
              }}
            >
              <Copy size={15} aria-hidden /> Copy
            </button>
          </div>
        )}
        {(tokens.data?.tokens ?? []).length > 0 && (
          <ul className="plain-list">
            {tokens.data.tokens.map((t: any) => (
              <li key={t.id} className={t.revoked_at ? 'muted' : ''}>
                <strong>{t.name}</strong> <code>{t.token_prefix}…</code> · created {stamp(t.created_at)} · {t.last_used_at ? `last used ${relative(t.last_used_at)}` : 'never used'}
                {t.revoked_at ? (
                  ' · revoked'
                ) : (
                  <button
                    type="button"
                    className="btn btn-link small"
                    onClick={async () => {
                      if (!confirm(`Revoke “${t.name}”? Anything using it will stop working.`)) return;
                      await api('DELETE', `/api/research-tokens/${t.id}`);
                      tokens.refetch();
                    }}
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card">
        <h2 className="side-title">Manual import</h2>
        <p className="small">Paste research results as JSON (the same format as the research API’s import). Existing listings are matched, not duplicated, and your personal data is never changed.</p>
        <textarea rows={8} className="mono" value={importText} onChange={(e) => setImportText(e.target.value)} placeholder='{"events": [ … ]}' aria-label="Import JSON" />
        <div className="btn-row">
          <label className="btn btn-ghost btn-sm file-btn">
            <Upload size={15} aria-hidden /> Load a file
            <input type="file" accept="application/json,.json" className="sr-only" onChange={async (e) => setImportText(await e.target.files![0].text())} />
          </label>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={!importText.trim()}
            onClick={async () => {
              setImportResult(null);
              try {
                const body = JSON.parse(importText);
                const r = await api('POST', '/api/import', body);
                setImportResult(r);
                qc.invalidateQueries();
              } catch (e) {
                setImportResult({ error: e instanceof SyntaxError ? `Not valid JSON: ${e.message}` : errorMessage(e) });
              }
            }}
          >
            Import
          </button>
        </div>
        {importResult && (
          <div className="import-result" role="status">
            {importResult.error ? (
              <p className="error-note">{importResult.error}</p>
            ) : (
              <>
                <p>
                  {importResult.counts.created} created · {importResult.counts.updated} updated · {importResult.counts.unchanged} unchanged · {importResult.counts.error} errors
                </p>
                {importResult.items
                  .filter((i: any) => i.status === 'error' || i.warnings)
                  .slice(0, 20)
                  .map((i: any) => (
                    <p key={`${i.type}${i.index}`} className="small">
                      {i.type} {i.ref ?? i.index}: {i.error ?? i.warnings.join('; ')}
                    </p>
                  ))}
              </>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function Data() {
  const qc = useQueryClient();
  const toast = useToast();
  const meta = useMeta();
  const hidden = useQuery({ queryKey: ['events', 'hidden'], queryFn: () => get('/api/events?mode=all&scope=any&saved=hidden&include_past=0&limit=100') });
  const [report, setReport] = useState<any>(null);
  const [file, setFile] = useState<any>(null);
  return (
    <div className="settings-sec">
      <section className="card">
        <h2 className="side-title">Export and import</h2>
        <p className="small">Your export contains preferences, watchlist, statuses, notes, bookings, your own events and plans. Keep it somewhere safe; see docs/BACKUP.md for full backups.</p>
        <div className="btn-row">
          <button type="button" className="btn btn-primary" onClick={() => download('/api/export', `personal-data-${new Date().toISOString().slice(0, 10)}.json`).catch((e) => toast(errorMessage(e), 'error'))}>
            <Download size={16} aria-hidden /> Export my data
          </button>
          <label className="btn btn-ghost file-btn">
            <Upload size={16} aria-hidden /> Choose export file
            <input
              type="file"
              accept="application/json,.json"
              className="sr-only"
              onChange={async (e) => {
                try {
                  const data = JSON.parse(await e.target.files![0].text());
                  setFile(data);
                  setReport(await api('POST', '/api/import-personal?dry_run=1', data));
                } catch (x) {
                  toast(x instanceof SyntaxError ? 'That file is not valid JSON' : errorMessage(x), 'error');
                }
              }}
            />
          </label>
        </div>
        {report && (
          <div className="import-result" role="status">
            <p>
              <strong>{report.dry_run ? 'Preview — nothing changed yet' : 'Imported'}</strong>
            </p>
            <ul className="plain-list small">
              <li>Watchlist: {report.watchlist.added} to add, {report.watchlist.existing} already present</li>
              <li>Your events: {report.manual_events.created} to add, {report.manual_events.existing} already present</li>
              <li>
                Saved statuses and notes: {report.event_states.applied} to apply, {report.event_states.kept_newer} unchanged, {report.event_states.unmatched} could not be matched
              </li>
              <li>
                Bookings: {report.bookings.added} to add, {report.bookings.duplicates} duplicates skipped, {report.bookings.unmatched} unmatched
              </li>
              <li>
                Plans: {report.plans.added} to add, {report.plans.duplicates} duplicates
              </li>
            </ul>
            {report.dry_run && (
              <div className="btn-row">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={async () => {
                    setReport(await api('POST', '/api/import-personal', file));
                    qc.invalidateQueries();
                  }}
                >
                  Import (merge, keeping current data)
                </button>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={async () => {
                    setReport(await api('POST', '/api/import-personal?replace_preferences=1', file));
                    qc.invalidateQueries();
                  }}
                >
                  Import and replace preferences
                </button>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="card">
        <h2 className="side-title">Demo data</h2>
        <p className="small">Fictional examples so you can try every view. They are labelled “Demo” and can be removed in one step; your own records are not affected.</p>
        {meta.data?.demo.loaded ? (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={async () => {
              if (!confirm('Remove all demo data? Statuses and bookings you added to demo events go with them.')) return;
              await api('DELETE', '/api/demo');
              toast('Demo data removed');
              qc.invalidateQueries();
            }}
          >
            Remove demo data ({meta.data.demo.events} events)
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={async () => {
              await api('POST', '/api/demo', {});
              toast('Demo data loaded');
              qc.invalidateQueries();
            }}
          >
            Load demo data
          </button>
        )}
      </section>

      <section>
        <h2 className="section-title">Hidden events</h2>
        {hidden.data?.items.length ? (
          <div className="card-grid">
            {hidden.data.items.map((e: any) => (
              <EventCard key={e.id} e={e} />
            ))}
          </div>
        ) : (
          <Empty title="No hidden events" />
        )}
      </section>
    </div>
  );
}

function Account() {
  const toast = useToast();
  const nav = useNavigate();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get('/api/auth/sessions') });
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  return (
    <div className="settings-sec">
      <section className="card">
        <h2 className="side-title">Signed-in devices</h2>
        <ul className="plain-list">
          {(sessions.data?.sessions ?? []).map((s: any) => (
            <li key={s.id}>
              {s.current && <Badge tone="ok">This device</Badge>} <span className="small">{(s.user_agent ?? 'Unknown device').slice(0, 80)}</span>
              <div className="muted small">
                Last active {relative(s.last_seen_at)} · expires {stamp(s.expires_at)}
                {!s.current && (
                  <button
                    type="button"
                    className="btn btn-link small"
                    onClick={async () => {
                      await api('DELETE', `/api/auth/sessions/${s.id}`);
                      sessions.refetch();
                    }}
                  >
                    Sign out
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
      <section className="card">
        <h2 className="side-title">Change password</h2>
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api('POST', '/api/auth/password', { current: cur, next });
              toast('Password changed; other devices were signed out');
              setCur('');
              setNext('');
              sessions.refetch();
            } catch (x) {
              toast(errorMessage(x), 'error');
            }
          }}
        >
          <Field label="Current password">
            <input type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} required />
          </Field>
          <Field label="New password" hint="At least 10 characters">
            <input type="password" autoComplete="new-password" minLength={10} value={next} onChange={(e) => setNext(e.target.value)} required />
          </Field>
          <button className="btn btn-primary">Change password</button>
        </form>
      </section>
      <button
        type="button"
        className="btn btn-ghost"
        onClick={async () => {
          await api('POST', '/api/auth/logout', {});
          window.dispatchEvent(new Event('quartet:signed-out'));
          nav('/');
        }}
      >
        Sign out
      </button>
    </div>
  );
}

export function SettingsPage() {
  const { section = 'interests' } = useParams();
  return (
    <div className="page">
      <PageHeader title="Settings" />
      <div className="settings">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map(([k, l]) => (
            <NavLink key={k} to={`/settings/${k}`} className={({ isActive }) => (isActive || (k === 'interests' && section === 'interests') ? 'active' : '')}>
              {l}
            </NavLink>
          ))}
        </nav>
        <div className="settings-body">
          <h2 className="settings-title">{SECTIONS.find(([k]) => k === section)?.[1]}</h2>
          {section === 'interests' && <Interests />}
          {section === 'places' && <Places />}
          {section === 'notifications' && <Notifications />}
          {section === 'research' && <Research />}
          {section === 'data' && <Data />}
          {section === 'account' && <Account />}
          <ErrorNote error={null} />
        </div>
      </div>
    </div>
  );
}
