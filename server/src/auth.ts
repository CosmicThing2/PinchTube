import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from './db.js';
import { config } from './config.js';

export const SESSION_COOKIE = 'ytm_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days — this is mostly a phone app
// "Last active" is only rewritten once this much time has passed, rather than
// on every request.
const ACTIVITY_RESOLUTION_MS = 60 * 1000;

// scrypt parameters: ~16 MB of memory per hash, comfortably above the OWASP floor.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 };

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

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

export interface User {
  id: number;
  username: string;
  isAdmin: boolean;
  /** False when the user is limited to a hand-picked list of channels. */
  allChannels: boolean;
  totpEnabled: boolean;
}

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

export function setupRequired(): boolean {
  return userCount() === 0;
}

export function createUser(username: string, password: string, isAdmin: boolean): User {
  const info = db
    .prepare('INSERT INTO users (username, password_hash, created_at, is_admin) VALUES (?, ?, ?, ?)')
    .run(username, hashPassword(password), Date.now(), isAdmin ? 1 : 0);
  return getUser(Number(info.lastInsertRowid))!;
}

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

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function createSession(userId: number, userAgent: string | undefined): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(
    'INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
  ).run(hashToken(token), userId, now, now + SESSION_TTL_MS, userAgent?.slice(0, 300) ?? null);
  db.prepare('UPDATE users SET last_active = ? WHERE id = ?').run(now, userId);
  return token;
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
}

export function destroyUserSessions(userId: number): void {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

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

  succeed(key: string): void {
    this.attempts.delete(key);
  }
}

const MINUTE = 60 * 1000;
export const ipThrottle = new Throttle(10, 15 * MINUTE, 15 * MINUTE);
export const userThrottle = new Throttle(10, 15 * MINUTE, 15 * MINUTE);
