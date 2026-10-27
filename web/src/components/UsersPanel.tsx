import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type ManagedUser } from '../lib/api';
import { useApp } from '../lib/app-context';
import { Dialog, Spinner } from './Common';
import { IconPlus, IconShield } from './Icons';
import { formatRelative } from '../lib/format';

interface ChannelName {
  id: string;
  title: string;
}

interface UsersResponse {
  items: ManagedUser[];
  channels?: ChannelName[];
}

/** Ticks for which channels a restricted user may see, with a filter for long lists. */
function ChannelPicker({
  channels,
  selected,
  onChange,
}: {
  channels: ChannelName[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
}) {
  const [filter, setFilter] = useState('');
  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? channels.filter((c) => c.title.toLowerCase().includes(needle)) : channels;
  }, [channels, filter]);

  const setAll = (on: boolean) => {
    const next = new Set(selected);
    for (const channel of shown) {
      if (on) next.add(channel.id);
      else next.delete(channel.id);
    }
    onChange(next);
  };

  return (
    <div className="channel-picker">
      <div style={{ display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input
          className="input"
          placeholder="Filter channels"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          style={{ flex: 1, minWidth: 140, height: 36 }}
          aria-label="Filter channels"
        />
        <button type="button" className="chip" onClick={() => setAll(true)}>
          Select all
        </button>
        <button type="button" className="chip" onClick={() => setAll(false)}>
          Select none
        </button>
      </div>
      <div className="channel-picker-list">
        {shown.length === 0 ? <p className="muted" style={{ fontSize: 13 }}>No channels match.</p> : null}
        {shown.map((channel) => (
          <label key={channel.id} className="save-row">
            <input
              type="checkbox"
              checked={selected.has(channel.id)}
              onChange={(event) => {
                const next = new Set(selected);
                if (event.target.checked) next.add(channel.id);
                else next.delete(channel.id);
                onChange(next);
              }}
            />
            <span className="save-name">{channel.title}</span>
          </label>
        ))}
      </div>
      <div className="hint" style={{ marginTop: 6 }}>
        {selected.size} of {channels.length} channels selected.
      </div>
    </div>
  );
}

function Switch({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={disabled ? 'switch is-disabled' : 'switch'}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </label>
  );
}

/** The add / edit form; `user` is null when adding. */
function UserEditor({
  user,
  channels,
  isSelf,
  onSaved,
  onClose,
}: {
  user: ManagedUser | null;
  channels: ChannelName[];
  isSelf: boolean;
  onSaved: (data: UsersResponse) => void;
  onClose: () => void;
}) {
  const [username, setUsername] = useState(user?.username ?? '');
  const [password, setPassword] = useState('');
  const [isAdmin, setIsAdmin] = useState(user?.isAdmin ?? false);
  const [allChannels, setAllChannels] = useState(user?.allChannels ?? true);
  const [selected, setSelected] = useState<Set<string>>(new Set(user?.channels ?? []));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const send = async (work: () => Promise<UsersResponse>, close = true) => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await work());
      if (close) onClose();
    } catch (err: any) {
      setError(err?.message ?? 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const body: Record<string, unknown> = {
      username: username.trim(),
      isAdmin,
      allChannels,
      channels: Array.from(selected),
    };
    if (password) body.password = password;
    void send(() =>
      user ? api.patch<UsersResponse>(`/api/users/${user.id}`, body) : api.post<UsersResponse>('/api/users', body),
    );
  };

  return (
    <Dialog title={user ? `Edit ${user.username}` : 'Add a user'} onClose={onClose} width={520}>
      {error ? <div className="notice error">{error}</div> : null}
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="u-name">Username</label>
          <input
            id="u-name"
            className="input"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="u-pass">{user ? 'New password' : 'Password'}</label>
          <input
            id="u-pass"
            className="input"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="new-password"
            placeholder={user ? 'Leave empty to keep the current one' : undefined}
            required={!user}
          />
          <div className="hint">
            At least 8 characters.{user ? ' Setting a new one signs this user out on every device.' : ''}
          </div>
        </div>

        <div className="settings-row">
          <div className="grow">
            <div className="label">Administrator</div>
            <div className="hint">
              Can change library and transcoding settings, manage users and see the system overview.
            </div>
          </div>
          <Switch checked={isAdmin} onChange={setIsAdmin} />
        </div>

        <div className={isAdmin ? 'settings-row is-disabled' : 'settings-row'}>
          <div className="grow">
            <div className="label">All channels</div>
            <div className="hint">
              {isAdmin
                ? 'Administrators always see every channel.'
                : 'Includes channels added in the future. Turn off to pick channels one by one.'}
            </div>
          </div>
          <Switch checked={isAdmin || allChannels} onChange={setAllChannels} disabled={isAdmin} />
        </div>

        {!isAdmin && !allChannels ? (
          <ChannelPicker channels={channels} selected={selected} onChange={setSelected} />
        ) : null}

        <div style={{ display: 'flex', gap: 8, marginTop: 16, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? 'Saving…' : user ? 'Save' : 'Add user'}
          </button>
        </div>
      </form>

      {user ? (
        <div className="danger-zone">
          {user.twoFactor ? (
            <div className="settings-row">
              <div className="grow">
                <div className="label">Reset two-factor sign-in</div>
                <div className="hint">For a user who has lost their phone and their recovery codes.</div>
              </div>
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  void send(() => api.patch<UsersResponse>(`/api/users/${user.id}`, { resetTwoFactor: true }), false)
                }
              >
                Reset
              </button>
            </div>
          ) : null}
          <div className="settings-row">
            <div className="grow">
              <div className="label">Sign out everywhere</div>
              <div className="hint">Ends every session this user has open.</div>
            </div>
            <button
              className="btn"
              disabled={busy}
              onClick={() => void send(() => api.patch<UsersResponse>(`/api/users/${user.id}`, { signOut: true }))}
            >
              Sign out
            </button>
          </div>
          {!isSelf ? (
            <div className="settings-row">
              <div className="grow">
                <div className="label">Delete user</div>
                <div className="hint">Removes their watch history, queue and playlists too.</div>
              </div>
              {confirmDelete ? (
                <span style={{ display: 'inline-flex', gap: 8 }}>
                  <button className="btn" onClick={() => setConfirmDelete(false)}>
                    Cancel
                  </button>
                  <button
                    className="btn danger"
                    disabled={busy}
                    onClick={() => void send(() => api.del<UsersResponse>(`/api/users/${user.id}`))}
                  >
                    Delete
                  </button>
                </span>
              ) : (
                <button className="btn" onClick={() => setConfirmDelete(true)}>
                  Delete
                </button>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** Administrators only: everyone who can sign in, and what they may see. */
export function UsersPanel() {
  const { user: me, refreshUser } = useApp();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [channels, setChannels] = useState<ChannelName[]>([]);
  const [editing, setEditing] = useState<ManagedUser | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apply = (data: UsersResponse) => {
    setUsers(data.items);
    if (data.channels) setChannels(data.channels);
  };

  useEffect(() => {
    api
      .get<UsersResponse>('/api/users')
      .then(apply)
      .catch((err) => setError(err?.message ?? 'Could not load users'));
  }, []);

  const saved = (data: UsersResponse) => {
    apply(data);
    // Editing yourself (say, handing admin to someone else) changes what this
    // page should show.
    if (editing !== 'new' && editing?.id === me?.id) void refreshUser();
  };

  return (
    <section className="panel">
      <h2>Users</h2>
      <p className="panel-sub">
        Everyone has their own watch history, queue, playlists and personal settings. There is always at least one
        administrator.
      </p>

      {error ? <div className="notice error">{error}</div> : null}

      {!users ? (
        <Spinner />
      ) : (
        <div className="user-list">
          {users.map((user) => (
            <button key={user.id} className="user-row" onClick={() => setEditing(user)}>
              <span className="user-avatar" aria-hidden="true">
                {user.username.slice(0, 1).toUpperCase()}
              </span>
              <span className="user-text">
                <span className="user-name">
                  {user.username}
                  {user.id === me?.id ? <span className="muted"> (you)</span> : null}
                </span>
                <span className="user-meta">
                  {user.isAdmin
                    ? 'Administrator'
                    : user.allChannels
                      ? 'All channels'
                      : `${user.channels.length} of ${channels.length} channels`}
                  {user.lastActive ? ` · last activity ${formatRelative(user.lastActive)}` : ' · no activity yet'}
                </span>
              </span>
              {user.twoFactor ? (
                <IconShield className="user-2fa" aria-label="Two-factor sign-in is on" />
              ) : null}
            </button>
          ))}
        </div>
      )}

      <button className="btn" style={{ marginTop: 12 }} onClick={() => setEditing('new')}>
        <IconPlus />
        Add user
      </button>

      {editing ? (
        <UserEditor
          key={editing === 'new' ? 'new' : editing.id}
          user={editing === 'new' ? null : editing}
          channels={channels}
          isSelf={editing !== 'new' && editing.id === me?.id}
          onSaved={saved}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </section>
  );
}
