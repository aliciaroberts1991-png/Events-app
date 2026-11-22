// Unlocking editing of shared data (artist list, settings, imports, shared listings).
import { useQueryClient } from '@tanstack/react-query';
import { Lock, LockOpen } from 'lucide-react';
import { createContext, useContext, useState, type ReactNode } from 'react';
import { api, errorMessage } from '../lib/api';
import { useEditor, useToast } from '../lib/hooks';
import { Dialog, Field } from './ui';

const UnlockCtx = createContext<() => void>(() => undefined);
export const useUnlock = () => useContext(UnlockCtx);

export function UnlockProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const toast = useToast();
  const editor = useEditor();
  return (
    <UnlockCtx.Provider value={() => setOpen(true)}>
      {children}
      <Dialog open={open} onClose={() => setOpen(false)} title="Unlock editing">
        {!editor.configured ? (
          <p>
            Editing has not been set up on this server yet. Set <code>EDITOR_PASSWORD</code> and restart, or run <code>npm run editor:password</code>.
          </p>
        ) : (
          <form
            className="form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setErr(null);
              try {
                await api('POST', '/api/auth/unlock', { password: pw });
                setPw('');
                setOpen(false);
                toast('Editing unlocked on this device');
                await qc.invalidateQueries();
              } catch (x) {
                setErr(errorMessage(x));
              } finally {
                setBusy(false);
              }
            }}
          >
            <p className="small muted">Browsing never needs this. The passphrase lets this device change the shared artist list and settings. It stays unlocked for 90 days of use.</p>
            <Field label="Editor passphrase">
              <input type="password" autoComplete="current-password" required value={pw} onChange={(e) => setPw(e.target.value)} />
            </Field>
            {err && (
              <p className="error-note" role="alert">
                {err}
              </p>
            )}
            <div className="dialog-actions">
              <button className="btn btn-primary" disabled={busy}>
                {busy ? 'Unlocking…' : 'Unlock'}
              </button>
            </div>
          </form>
        )}
      </Dialog>
    </UnlockCtx.Provider>
  );
}

export function LockButton({ compact }: { compact?: boolean }) {
  const editor = useEditor();
  const unlock = useUnlock();
  const qc = useQueryClient();
  const toast = useToast();
  if (editor.loading) return null;
  if (editor.unlocked)
    return (
      <button
        type="button"
        className={compact ? 'icon-btn editor-on' : 'btn btn-ghost btn-sm editor-on'}
        aria-label="Editing unlocked — lock editing on this device"
        title="Editing unlocked on this device"
        onClick={async () => {
          await api('POST', '/api/auth/lock', {});
          toast('Editing locked on this device');
          qc.invalidateQueries();
        }}
      >
        <LockOpen size={compact ? 20 : 15} aria-hidden />
        {!compact && 'Editing on'}
      </button>
    );
  return (
    <button type="button" className={compact ? 'icon-btn' : 'btn btn-ghost btn-sm'} aria-label="Unlock editing" title="Unlock editing of shared settings" onClick={unlock}>
      <Lock size={compact ? 20 : 15} aria-hidden />
      {!compact && 'Unlock editing'}
    </button>
  );
}

export function EditingRequired({ what }: { what: string }) {
  const unlock = useUnlock();
  return (
    <div className="editing-required" role="note">
      <Lock size={16} aria-hidden />
      <span>
        Unlock editing to {what}.{' '}
        <button type="button" className="btn btn-link" onClick={unlock}>
          Unlock
        </button>
      </span>
    </div>
  );
}
