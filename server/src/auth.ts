/*
 * auth.ts — accounts, passwords and login sessions.
 *
 * The building blocks of signing in, used by routes/auth.ts (sign in, sign
 * out, setup, two-factor) and routes/users.ts (managing accounts):
 *   - passwords: hashed with scrypt, never stored as typed
 *   - users: looking up and creating accounts in the users table
 *   - sessions: a random token stored in a signed, HTTP-only cookie; only a
 *     hash of it is kept in the database, so a copied database cannot be
 *     used to sign in. index.ts calls sessionUser() on every request.
 *   - the first-run setup code that protects creating the first admin
 *   - short-lived "tickets" between the password step and the 2FA code step
 *     (the codes themselves are checked by totp.ts)
 *   - throttles that lock out repeated wrong guesses
 */

import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';

// ---- passwords --------------------------------------------------------------

export const SESSION_COOKIE = 'ytm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is mostly a phone app
// "Last active" is only rewritten once this much time has passed, rather than
// on every request.
const ACTIVITY_RESOLUTION_MS = 60 * 1000;

// scrypt parameters: ~16 MB of memory per hash, comfortably above the OWASP floor.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

/** A salted scrypt hash, stored as "scrypt$N$r$p$salt$key" so the settings travel with it. */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Whether a typed password matches a stored hash, compared in constant time. */
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const [scheme, n, r, p, saltB64, keyB64] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash: string | null = null;

/**
 * Runs a full password check against a throwaway hash, so that a username that
 * does not exist takes as long to reject as a wrong password — otherwise the
 * response time alone would tell someone which usernames are real.
 */
export function burnPasswordCheck(password: string): void {
  dummyHash ??= hashPassword(crypto.randomBytes(16).toString('hex'));
  verifyPassword(password, dummyHash);
}

// ---- users ------------------------------------------------------------------

/** A signed-in user as the rest of the server sees them. */
export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
  /** False when the user is limited to a hand-picked list of channels. */
  allChannels: boolean;
  totpEnabled: boolean;
}

/** A row of the users table as SQLite returns it. */
interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  is_admin: number;
  all_channels: number;
  totp_enabled: number;
  totp_secret: string | null;
  totp_recovery: string | null;
  totp_last_step: number | null;
  created_at: number;
  last_active: number | null;
}

/** Turns a database row into a User, leaving out the password and 2FA secrets. */
function toUser(row: UserRow): User {
  return {
    id: row.id,
    username: row.username,
    isAdmin: row.is_admin === 1,
    allChannels: row.all_channels === 1,
    totpEnabled: row.totp_enabled === 1,
  };
}

export function userCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  return row.n;
}

export function adminCount(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').get() as { n: number };
  return row.n;
}

/** True until the first account is created. */
export function setupRequired(): boolean {
  return userCount() === 0;
}

/** Adds an account. The caller checks the username is free and the password long enough. */
export function createUser(username: string, password: string, isAdmin: boolean): User {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), Date.now(), isAdmin ? 1 : 0);
  return getUser(Number(info.lastInsertRowid))!;
}

/** Looks an account up by name (ignoring case), including its secrets. */
export function findUserRow(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username) as UserRow | undefined;
}

export function getUserRow(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
}

export function getUser(id: number): User | null {
  const row = getUserRow(id);
  return row ? toUser(row) : null;
}

export function changePassword(userId: number, password: string): void {
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), userId);
  // Force every device to sign in again after a password change.
  destroyUserSessions(userId);
}

// ---- sessions ---------------------------------------------------------------

/** Sessions and tickets are stored only as this hash of the token. */
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Starts a login session and returns the token to put in the cookie. */
export function createSession(userId: number, userAgent: string | undefined): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + SESSION_TTL_MS, userAgent?.slice(0, 300) ?? null);
  db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(now, userId);
  return token;
}

/** Signs one device out. */
export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

/** Signs a user out everywhere. */
export function destroyUserSessions(userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/**
 * The user a session token belongs to, or null if it is unknown or expired.
 * Also records the account as active (at most once a minute).
 */
export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT s.token_hash AS th, s.expires_at AS exp, u.*
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`,
    )
    .get(hashToken(token)) as (UserRow & { th: string; exp: number }) | undefined;
  if (!row) return null;
  const now = Date.now();
  if (row.exp < now) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(row.th);
    return null;
  }
  if (row.last_active === null || now - row.last_active >= ACTIVITY_RESOLUTION_MS) {
    db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(now, row.id);
  }
  return toUser(row);
}

/** Deletes expired sessions; run at startup and daily. */
export function pruneSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

/**
 * Secure (HTTPS-only) cookies when the request arrived over HTTPS, or always /
 * never if SECURE_COOKIES says so. Behind a reverse proxy, "arrived over HTTPS"
 * relies on TRUST_PROXY so that X-Forwarded-Proto is believed.
 */
function secureCookie(request: FastifyRequest): boolean {
  if (config.secureCookies === 'true') return true;
  if (config.secureCookies === 'false') return false;
  return request.protocol === 'https';
}

/** Sends the session cookie: signed, hidden from page scripts, and kept for 30 days. */
export function setSessionCookie(request: FastifyRequest, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(request),
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    signed: true,
  });
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}

/** The session token from the request's cookie, if its signature checks out. */
export function readSessionToken(request: FastifyRequest): string | undefined {
  const raw = request.cookies?.[SESSION_COOKIE];
  if (!raw) return undefined;
  const unsigned = request.unsignCookie(raw);
  return unsigned.valid && unsigned.value ? unsigned.value : undefined;
}

// ---- first-run setup code ---------------------------------------------------

let setupCode: string | null = null;

/**
 * Until the first account exists, anyone who can reach the server could claim
 * it. To stop a stranger beating the owner to it, creating that account needs
 * a one-off code that is only ever printed to the container's log.
 */
export function currentSetupCode(): string | null {
  if (!setupRequired()) {
    setupCode = null;
    return null;
  }
  setupCode ??= crypto.randomBytes(5).toString('hex').toUpperCase();
  return setupCode;
}

/** Whether a typed setup code matches, forgiving case and spaces. */
export function checkSetupCode(candidate: unknown): boolean {
  const code = currentSetupCode();
  if (!code || typeof candidate !== 'string') return false;
  const given = Buffer.from(candidate.trim().toUpperCase().replace(/[^0-9A-F]/g, ''));
  const expected = Buffer.from(code);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// ---- two-factor sign-in tickets --------------------------------------------

/**
 * Proof that the password was right, held while the user types their
 * authenticator code. Short-lived, and only a handful of guesses each.
 */
const tickets = new Map<string, { userId: number; expires: number; attempts: number }>();
const TICKET_TTL_MS = 5 * 60 * 1000;
const TICKET_ATTEMPTS = 5;

/** Hands out a ticket after a correct password, clearing out expired ones first. */
export function issueTwoFactorTicket(userId: number): string {
  const now = Date.now();
  for (const [key, entry] of tickets) if (entry.expires < now) tickets.delete(key);
  const ticket = crypto.randomBytes(32).toString('hex');
  tickets.set(hashToken(ticket), { userId, expires: now + TICKET_TTL_MS, attempts: 0 });
  return ticket;
}

/** The user a ticket belongs to, counting this as one attempt; null once spent or expired. */
export function useTwoFactorTicket(ticket: unknown): number | null {
  if (typeof ticket !== 'string' || !ticket) return null;
  const key = hashToken(ticket);
  const entry = tickets.get(key);
  if (!entry) return null;
  if (entry.expires < Date.now() || entry.attempts >= TICKET_ATTEMPTS) {
    tickets.delete(key);
    return null;
  }
  entry.attempts += 1;
  return entry.userId;
}

/** Retires a ticket once the 2FA code was accepted. */
export function spendTwoFactorTicket(ticket: string): void {
  tickets.delete(hashToken(ticket));
}

// ---- brute-force throttling -------------------------------------------------

/**
 * Counts failures per key (an IP address, or a username) and locks the key out
 * for a while once it has failed too often. Tracking usernames as well as
 * addresses stops a password being guessed slowly from many machines.
 */
class Throttle {
  private attempts = new Map<string, { count: number; first: number; lockedUntil: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly lockoutMs: number,
  ) {}

  /** Seconds left on a lockout, or 0. */
  blockedFor(key: string): number {
    const entry = this.attempts.get(key);
    if (!entry) return 0;
    const now = Date.now();
    if (entry.lockedUntil > now) return Math.ceil((entry.lockedUntil - now) / 1000);
    if (now - entry.first > this.windowMs) this.attempts.delete(key);
    return 0;
  }

  /** Records a failure; enough of them within the window starts a lockout. */
  fail(key: string): void {
    const now = Date.now();
    // Keep the map from growing without bound under a flood of junk keys.
    if (this.attempts.size > 10000) {
      for (const [k, e] of this.attempts) {
        if (e.lockedUntil < now && now - e.first > this.windowMs) this.attempts.delete(k);
      }
    }
    const entry = this.attempts.get(key);
    if (!entry || now - entry.first > this.windowMs) {
      this.attempts.set(key, { count: 1, first: now, lockedUntil: 0 });
      return;
    }
    entry.count += 1;
    if (entry.count >= this.max) {
      entry.lockedUntil = now + this.lockoutMs;
      entry.count = 0;
      entry.first = now;
    }
  }

  /** Clears the count after a success. */
  succeed(key: string): void {
    this.attempts.delete(key);
  }
}

// 10 failures within 15 minutes locks that address or account out for 15 minutes.
const MINUTE = 60 * 1000;
export const ipThrottle = new Throttle(10, 15 * MINUTE, 15 * MINUTE);
export const userThrottle = new Throttle(10, 15 * MINUTE, 15 * MINUTE);
