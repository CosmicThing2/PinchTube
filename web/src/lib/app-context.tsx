/*
 * app-context.tsx — app-wide state: who is signed in, their settings, the theme.
 *
 * A React "context" makes values available to every component without
 * passing them down by hand. AppProvider (wrapped around the whole app in
 * main.tsx) holds:
 *   - status: still loading, first-run setup needed, signed out, or ready
 *   - the signed-in user and their settings, and functions to sign in
 *     (including the two-factor step), set up, sign out and save settings
 *   - the theme (system/dark/light) and colours, applied to the page
 *   - two per-device switches kept in this browser only: theater mode and
 *     data saver
 * Any component reads these with useApp(). Talks to the server through
 * lib/api.ts; the sign-in screens are pages/AuthPage.tsx.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, UNAUTHORIZED_EVENT, type AppSettings, type CurrentUser } from './api';
import { applyColours, rememberColours } from './accent';

export type Theme = 'system' | 'dark' | 'light';

// Browser storage (localStorage) keys for things remembered on this device.
const THEME_KEY = 'ytm-theme';
const THEATER_KEY = 'ytm-theater';
const DATA_SAVER_KEY = 'ytm-data-saver';

/** The theme last used in this browser, so main.tsx can paint it before sign-in. */
export function readCachedTheme(): Theme {
  const stored = localStorage.getItem(THEME_KEY);
  return stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'system';
}

/** Switches the page's theme (styles/app.css reads the data-theme attribute) and remembers it. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  localStorage.setItem(THEME_KEY, theme);
}

type Status = 'loading' | 'setup' | 'login' | 'ready';

/** Everything useApp() gives a component. */
interface AppValue {
  status: Status;
  /** Lives here rather than in the watch page so the shell can collapse its nav. */
  theater: boolean;
  toggleTheater: () => void;
  /**
   * Deliberately per-device and stored in this browser only: a phone on a
   * limited plan should not put the desktop into data saver too.
   */
  dataSaver: boolean;
  setDataSaver: (value: boolean) => void;
  user: CurrentUser | null;
  settings: AppSettings | null;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  /**
   * Resolves to a ticket when the account has two-factor sign-in, in which
   * case nothing is signed in until verifyTwoFactor() succeeds with it.
   */
  login: (username: string, password: string) => Promise<string | null>;
  verifyTwoFactor: (ticket: string, code: string) => Promise<void>;
  completeSetup: (username: string, password: string, setupCode: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Re-reads who is signed in, after something like turning on two-factor. */
  refreshUser: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  saveSettings: (patch: any) => Promise<AppSettings>;
}

const AppContext = createContext<AppValue | null>(null);

/** Reads the app-wide state from inside any component. */
export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

/** Holds the app-wide state and makes it available to everything inside it. */
export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [theme, setThemeState] = useState<Theme>(() => readCachedTheme());
  const [theater, setTheater] = useState(() => {
    try {
      return localStorage.getItem(THEATER_KEY) === '1';
    } catch {
      return false;
    }
  });

  // The one connection signal browsers do expose reliably. It can force data
  // saver on, but the in-app switch cannot turn the browser's own setting off.
  const [browserSaveData] = useState(() => {
    try {
      return Boolean((navigator as any).connection?.saveData);
    } catch {
      return false;
    }
  });

  const [dataSaverHere, setDataSaverHere] = useState(() => {
    try {
      return localStorage.getItem(DATA_SAVER_KEY) === '1';
    } catch {
      return false;
    }
  });

  // The two per-device switches, saved in this browser as they change.
  const setDataSaver = useCallback((value: boolean) => {
    setDataSaverHere(value);
    try {
      localStorage.setItem(DATA_SAVER_KEY, value ? '1' : '0');
    } catch {
      /* private browsing */
    }
  }, []);

  const toggleTheater = useCallback(() => {
    setTheater((value) => {
      const next = !value;
      try {
        localStorage.setItem(THEATER_KEY, next ? '1' : '0');
      } catch {
        /* private browsing */
      }
      return next;
    });
  }, []);

  /** Fetches the user's settings and applies their theme. */
  const loadSettings = useCallback(async () => {
    const data = await api.get<{ settings: AppSettings }>('/api/settings');
    setSettings(data.settings);
    const serverTheme = data.settings.appearance.theme;
    setThemeState(serverTheme);
    applyTheme(serverTheme);
  }, []);

  /** On first load: is setup needed, is anyone signed in, and if so load their settings. */
  const bootstrap = useCallback(async () => {
    try {
      const info = await api.get<{ setupRequired: boolean; authenticated: boolean; user: CurrentUser | null }>(
        '/api/auth/status',
      );
      if (info.setupRequired) {
        setStatus('setup');
        setUser(null);
        return;
      }
      if (!info.authenticated) {
        setStatus('login');
        setUser(null);
        return;
      }
      setUser(info.user);
      await loadSettings();
      setStatus('ready');
    } catch {
      setStatus('login');
    }
  }, [loadSettings]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  // A 401 from any call means the session expired — drop straight back to login.
  useEffect(() => {
    const onUnauthorized = () => {
      setUser(null);
      setStatus('login');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  // Covers loading, saving and switching account alike.
  const accent = settings?.appearance.accent;
  const sponsor = settings?.appearance.sponsorColor;
  useEffect(() => {
    if (!settings) return;
    applyColours({ accent, sponsor });
    rememberColours({ accent, sponsor });
  }, [settings, accent, sponsor]);

  /** The theme switch in the header: applied at once, saved in the background. */
  const setTheme = useCallback(
    (next: Theme) => {
      setThemeState(next);
      applyTheme(next);
      setSettings((prev) => (prev ? { ...prev, appearance: { ...prev.appearance, theme: next } } : prev));
      void api.put('/api/settings', { appearance: { theme: next } }).catch(() => {});
    },
    [],
  );

  // ---- signing in and out ----
  const refreshUser = useCallback(async () => {
    const info = await api.get<{ authenticated: boolean; user: CurrentUser | null }>('/api/auth/status');
    if (!info.authenticated || !info.user) {
      setUser(null);
      setStatus('login');
      return;
    }
    setUser(info.user);
  }, []);

  /** Everything that has to happen once a session exists. */
  const enter = useCallback(async () => {
    await refreshUser();
    await loadSettings();
    setStatus('ready');
  }, [loadSettings, refreshUser]);

  const login = useCallback(
    async (username: string, password: string) => {
      const result = await api.post<{ twoFactorRequired?: boolean; ticket?: string }>('/api/auth/login', {
        username,
        password,
      });
      if (result.twoFactorRequired && result.ticket) return result.ticket;
      await enter();
      return null;
    },
    [enter],
  );

  const verifyTwoFactor = useCallback(
    async (ticket: string, code: string) => {
      await api.post('/api/auth/login/2fa', { ticket, code });
      await enter();
    },
    [enter],
  );

  const completeSetup = useCallback(
    async (username: string, password: string, setupCode: string) => {
      await api.post('/api/auth/setup', { username, password, setupCode });
      await enter();
    },
    [enter],
  );

  const logout = useCallback(async () => {
    await api.post('/api/auth/logout').catch(() => {});
    setUser(null);
    setStatus('login');
  }, []);

  /** Saves changed settings and keeps the server's cleaned-up result. */
  const saveSettings = useCallback(async (patch: any) => {
    const result = await api.put<{ settings: AppSettings }>('/api/settings', patch);
    setSettings(result.settings);
    if (patch?.appearance?.theme) {
      setThemeState(result.settings.appearance.theme);
      applyTheme(result.settings.appearance.theme);
    }
    return result.settings;
  }, []);

  // Rebuilt only when something in it changes, so components do not redraw needlessly.
  const value = useMemo<AppValue>(
    () => ({
      status,
      theater,
      toggleTheater,
      dataSaver: dataSaverHere || browserSaveData,
      setDataSaver,
      user,
      settings,
      theme,
      setTheme,
      login,
      verifyTwoFactor,
      completeSetup,
      logout,
      refreshUser,
      refreshSettings: loadSettings,
      saveSettings,
    }),
    [
      status,
      theater,
      toggleTheater,
      browserSaveData,
      dataSaverHere,
      setDataSaver,
      user,
      settings,
      theme,
      setTheme,
      login,
      verifyTwoFactor,
      completeSetup,
      logout,
      refreshUser,
      loadSettings,
      saveSettings,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
