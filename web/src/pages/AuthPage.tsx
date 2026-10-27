import { useState, type FormEvent } from 'react';
import { useApp } from '../lib/app-context';
import { ApiError } from '../lib/api';
import { LogoMark } from '../components/Logo';

export function AuthPage({ mode }: { mode: 'login' | 'setup' }) {
  const { login, verifyTwoFactor, completeSetup } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupCode, setSetupCode] = useState('');
  /** Set once the password was right on an account with two-factor sign-in. */
  const [ticket, setTicket] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isSetup = mode === 'setup';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    if (isSetup && password !== confirm) {
      setError('The two passwords do not match');
      return;
    }

    setBusy(true);
    try {
      if (ticket) {
        await verifyTwoFactor(ticket, code.trim());
      } else if (isSetup) {
        await completeSetup(username.trim(), password, setupCode.trim());
      } else {
        const next = await login(username.trim(), password);
        if (next) {
          setTicket(next);
          setCode('');
        }
      }
    } catch (err: any) {
      // A spent or expired ticket means starting over from the password.
      if (ticket && err instanceof ApiError && /start again/i.test(err.message)) {
        setTicket(null);
        setPassword('');
      }
      setError(err?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const brand = (
    <div className="brand">
      <LogoMark className="brand-mark" />
      <span>PinchTube</span>
    </div>
  );

  if (ticket) {
    return (
      <div className="auth-screen">
        <form className="auth-card" onSubmit={submit}>
          {brand}
          <h1>Two-factor sign-in</h1>
          <p className="sub">
            {useRecovery
              ? 'Enter one of the recovery codes you saved when you turned this on. Each works once.'
              : 'Enter the 6-digit code from your authenticator app.'}
          </p>

          {error ? <div className="notice error">{error}</div> : null}

          <div className="field">
            <label htmlFor="otp">{useRecovery ? 'Recovery code' : 'Code'}</label>
            <input
              id="otp"
              className="input"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              pattern={useRecovery ? undefined : '[0-9 ]*'}
              maxLength={useRecovery ? 20 : 7}
              autoCapitalize="none"
              autoCorrect="off"
              autoFocus
              required
            />
          </div>

          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
            {busy ? 'Please wait…' : 'Verify'}
          </button>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 14, fontSize: 13 }}>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setUseRecovery((value) => !value);
                setCode('');
                setError(null);
              }}
            >
              {useRecovery ? 'Use the authenticator app' : 'Use a recovery code'}
            </button>
            <button
              type="button"
              className="link-button"
              onClick={() => {
                setTicket(null);
                setPassword('');
                setError(null);
              }}
            >
              Back
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        {brand}

        <h1>{isSetup ? 'Create the administrator account' : 'Sign in'}</h1>
        <p className="sub">
          {isSetup
            ? 'This account can manage the library, settings and other users. It is stored only on your server.'
            : 'Your library is private to you.'}
        </p>

        {error ? <div className="notice error">{error}</div> : null}

        {isSetup ? (
          <div className="field">
            <label htmlFor="setup-code">Setup code</label>
            <input
              id="setup-code"
              className="input"
              value={setupCode}
              onChange={(event) => setSetupCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              required
            />
            <div className="hint">
              Printed in the server log when PinchTube starts, so only someone with access to the server can create
              the first account. Show it with <code>docker logs pinchtube</code>.
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="username">Username</label>
          <input
            id="username"
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            required
          />
        </div>

        <div className="field">
          <label htmlFor="password">Password</label>
          <input
            id="password"
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={isSetup ? 'new-password' : 'current-password'}
            required
          />
          {isSetup ? <div className="hint">At least 8 characters.</div> : null}
        </div>

        {isSetup ? (
          <div className="field">
            <label htmlFor="confirm">Confirm password</label>
            <input
              id="confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              autoComplete="new-password"
              required
            />
          </div>
        ) : null}

        <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%', marginTop: 6 }}>
          {busy ? 'Please wait…' : isSetup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
