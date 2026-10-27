import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Spinner } from './Common';
import { IconShield } from './Icons';

interface Status {
  enabled: boolean;
  recoveryCodesLeft: number;
}

interface Enrolment {
  secret: string;
  url: string;
  qr: string;
}

/** Shows freshly made recovery codes once, with a way to copy them. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="notice info" style={{ display: 'block' }}>
      <p style={{ margin: '0 0 8px' }}>
        <strong>Save these recovery codes somewhere safe.</strong> Each one signs you in once if you lose your phone.
        They will not be shown again.
      </p>
      <div className="recovery-codes">
        {codes.map((code) => (
          <code key={code}>{code}</code>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          className="btn"
          type="button"
          onClick={() => {
            const text = codes.join('\n');
            if (navigator.clipboard) {
              void navigator.clipboard
                .writeText(text)
                .then(() => setCopied(true))
                .catch(() => {});
              return;
            }
            // Over plain HTTP the clipboard API does not exist, but the old
            // select-and-copy route still works.
            const area = document.createElement('textarea');
            area.value = text;
            area.style.position = 'fixed';
            area.style.opacity = '0';
            document.body.appendChild(area);
            area.select();
            try {
              if (document.execCommand('copy')) setCopied(true);
            } finally {
              area.remove();
            }
          }}
        >
          {copied ? 'Copied' : 'Copy codes'}
        </button>
        <button className="btn primary" type="button" onClick={onDone}>
          I have saved them
        </button>
      </div>
    </div>
  );
}

/**
 * Optional two-factor sign-in with an authenticator app (Google Authenticator,
 * Authy, 1Password, Aegis and so on). Off until the user turns it on.
 */
export function TwoFactorPanel() {
  const { refreshUser } = useApp();
  const [status, setStatus] = useState<Status | null>(null);
  const [enrolment, setEnrolment] = useState<Enrolment | null>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'idle' | 'disable' | 'regenerate'>('idle');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () =>
    api
      .get<Status>('/api/auth/2fa')
      .then(setStatus)
      .catch(() => {});

  useEffect(() => {
    void load();
  }, []);

  const attempt = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    attempt(async () => {
      setEnrolment(await api.post<Enrolment>('/api/auth/2fa/setup'));
      setCode('');
    });

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      const result = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/enable', { code: code.trim() });
      setEnrolment(null);
      setCodes(result.recoveryCodes);
      await load();
      await refreshUser();
    });
  };

  const withPassword = (event: FormEvent) => {
    event.preventDefault();
    void attempt(async () => {
      if (mode === 'disable') {
        await api.post('/api/auth/2fa/disable', { password });
      } else {
        const result = await api.post<{ recoveryCodes: string[] }>('/api/auth/2fa/recovery', { password });
        setCodes(result.recoveryCodes);
      }
      setPassword('');
      setMode('idle');
      await load();
      await refreshUser();
    });
  };

  return (
    <section className="panel">
      <h2>Two-factor sign-in</h2>
      <p className="panel-sub">
        Optional. Asks for a code from an authenticator app such as Google Authenticator, Authy or 1Password after
        your password.
      </p>

      {error ? <div className="notice error">{error}</div> : null}
      {codes ? <RecoveryCodes codes={codes} onDone={() => setCodes(null)} /> : null}

      {!status ? (
        <Spinner />
      ) : enrolment ? (
        <div className="twofa-setup">
          <img src={enrolment.qr} alt="QR code for your authenticator app" width={200} height={200} />
          <div style={{ minWidth: 0, flex: 1 }}>
            <ol className="twofa-steps">
              <li>Open your authenticator app and add an account by scanning this code.</li>
              <li>
                Can’t scan? Enter this key instead:
                <code className="twofa-secret">{enrolment.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </li>
              <li>Type the 6-digit code the app shows to finish.</li>
            </ol>
            <form onSubmit={confirm} style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                className="input"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="123456"
                maxLength={7}
                style={{ width: 140 }}
                aria-label="Code from the app"
                required
              />
              <button className="btn primary" type="submit" disabled={busy}>
                Turn on
              </button>
              <button className="btn" type="button" onClick={() => setEnrolment(null)}>
                Cancel
              </button>
            </form>
          </div>
        </div>
      ) : status.enabled ? (
        <>
          <div className="settings-row">
            <div className="grow">
              <div className="label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <IconShield style={{ width: 18, height: 18, fill: 'var(--accent)' }} />
                On
              </div>
              <div className="hint">
                {status.recoveryCodesLeft} recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left.
              </div>
            </div>
          </div>
          {mode === 'idle' ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
              <button className="btn" onClick={() => setMode('regenerate')}>
                New recovery codes
              </button>
              <button className="btn" onClick={() => setMode('disable')}>
                Turn off
              </button>
            </div>
          ) : (
            <form onSubmit={withPassword} style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 16 }}>
              <input
                className="input"
                type="password"
                autoComplete="current-password"
                placeholder="Your password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                style={{ width: 220 }}
                aria-label="Your password"
                required
              />
              <button className={mode === 'disable' ? 'btn danger' : 'btn primary'} type="submit" disabled={busy}>
                {mode === 'disable' ? 'Turn off two-factor' : 'Make new codes'}
              </button>
              <button className="btn" type="button" onClick={() => setMode('idle')}>
                Cancel
              </button>
            </form>
          )}
        </>
      ) : (
        <button className="btn primary" onClick={() => void start()} disabled={busy}>
          <IconShield />
          Set up two-factor sign-in
        </button>
      )}
    </section>
  );
}
