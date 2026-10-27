import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import QRCode from 'qrcode';
import { db } from '../db.js';
import {
  burnPasswordCheck,
  changePassword,
  checkSetupCode,
  clearSessionCookie,
  createSession,
  createUser,
  destroySession,
  findUserRow,
  getUserRow,
  ipThrottle,
  issueTwoFactorTicket,
  readSessionToken,
  setSessionCookie,
  setupRequired,
  spendTwoFactorTicket,
  userThrottle,
  useTwoFactorTicket,
  verifyPassword,
  type User,
} from '../auth.js';
import {
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  otpauthUrl,
  verifyTotp,
} from '../totp.js';

export const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const ISSUER = 'PinchTube';

export function usernameProblem(username: unknown): string | null {
  if (typeof username !== 'string' || username.trim().length < 3) {
    return 'Username must be at least 3 characters';
  }
  if (username.trim().length > 64) return 'Username must be at most 64 characters';
  if (!/^[\w.@-]+$/.test(username.trim())) {
    return 'Username may only contain letters, numbers and . _ - @';
  }
  return null;
}

export function passwordProblem(password: unknown): string | null {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  // scrypt over a huge input is a cheap way to make the server work hard.
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`;
  return null;
}

export function publicUser(user: User) {
  return {
    id: user.id,
    username: user.username,
    isAdmin: user.isAdmin,
    twoFactor: user.totpEnabled,
  };
}

function signIn(request: FastifyRequest, reply: FastifyReply, userId: number): void {
  const token = createSession(userId, request.headers['user-agent']);
  setSessionCookie(request, reply, token);
}

/**
 * Checks the password of someone already signed in, before something sensitive.
 * Shares the sign-in throttle, so a stolen session cannot be used to guess the
 * password behind it. Returns a reply when the request should stop there.
 */
function confirmPassword(
  reply: FastifyReply,
  row: { username: string; password_hash: string },
  raw: unknown,
  wrong = 'Password is incorrect',
) {
  const key = row.username.toLowerCase();
  const blockedFor = userThrottle.blockedFor(key);
  if (blockedFor > 0) return tooMany(reply, blockedFor);
  const password = typeof raw === 'string' ? raw.slice(0, MAX_PASSWORD_LENGTH) : '';
  if (!verifyPassword(password, row.password_hash)) {
    userThrottle.fail(key);
    return reply.code(400).send({ error: wrong });
  }
  userThrottle.succeed(key);
  return null;
}

function tooMany(reply: FastifyReply, seconds: number) {
  return reply
    .code(429)
    .send({ error: `Too many failed attempts. Try again in ${Math.max(1, Math.ceil(seconds / 60))} minute(s).` });
}

/**
 * Checks an authenticator code, or failing that a recovery code (which is then
 * used up). Records the step of an accepted code so it cannot be replayed.
 */
function checkSecondFactor(userId: number, code: string): boolean {
  const row = getUserRow(userId);
  if (!row || !row.totp_enabled || !row.totp_secret) return false;

  const step = verifyTotp(row.totp_secret, code, row.totp_last_step);
  if (step !== null) {
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, userId);
    return true;
  }

  let hashes: string[] = [];
  try {
    hashes = JSON.parse(row.totp_recovery ?? '[]');
  } catch {
    hashes = [];
  }
  const hash = hashRecoveryCode(code);
  if (code.replace(/[^0-9a-z]/gi, '').length === 12 && hashes.includes(hash)) {
    db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(
      JSON.stringify(hashes.filter((h) => h !== hash)),
      userId,
    );
    return true;
  }
  return false;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  app.get('/api/auth/status', { config: { public: true } }, async (request) => ({
    setupRequired: setupRequired(),
    authenticated: Boolean(request.user),
    user: request.user ? publicUser(request.user) : null,
  }));

  app.post('/api/auth/setup', { config: { public: true } }, async (request, reply) => {
    if (!setupRequired()) {
      return reply.code(409).send({ error: 'An account already exists' });
    }
    const throttleKey = `setup:${request.ip || 'unknown'}`;
    const blockedFor = ipThrottle.blockedFor(throttleKey);
    if (blockedFor > 0) return tooMany(reply, blockedFor);

    const body = (request.body ?? {}) as any;
    if (!checkSetupCode(body.setupCode)) {
      ipThrottle.fail(throttleKey);
      return reply.code(403).send({
        error: 'That setup code is not right. It is printed in the server log when the app starts.',
      });
    }
    const problem = usernameProblem(body.username) ?? passwordProblem(body.password);
    if (problem) return reply.code(400).send({ error: problem });

    const user = createUser(String(body.username).trim(), String(body.password), true);
    signIn(request, reply, user.id);
    request.log.info(`Created the first account, "${user.username}", as an administrator`);
    return { user: publicUser(user) };
  });

  app.post('/api/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const username = typeof body.username === 'string' ? body.username.trim().slice(0, 64) : '';
    const password = typeof body.password === 'string' ? body.password.slice(0, MAX_PASSWORD_LENGTH) : '';

    const ipKey = request.ip || 'unknown';
    const userKey = username.toLowerCase();
    const blockedFor = Math.max(ipThrottle.blockedFor(ipKey), userKey ? userThrottle.blockedFor(userKey) : 0);
    if (blockedFor > 0) return tooMany(reply, blockedFor);

    const row = username ? findUserRow(username) : undefined;
    let ok = false;
    if (row) ok = verifyPassword(password, row.password_hash);
    else burnPasswordCheck(password);

    if (!row || !ok) {
      ipThrottle.fail(ipKey);
      if (userKey) userThrottle.fail(userKey);
      return reply.code(401).send({ error: 'Incorrect username or password' });
    }

    if (row.totp_enabled) {
      // The password was right, but nothing is signed in until the code is too.
      return { twoFactorRequired: true, ticket: issueTwoFactorTicket(row.id) };
    }

    ipThrottle.succeed(ipKey);
    userThrottle.succeed(userKey);
    signIn(request, reply, row.id);
    return { user: { username: row.username } };
  });

  app.post('/api/auth/login/2fa', { config: { public: true } }, async (request, reply) => {
    const body = (request.body ?? {}) as any;
    const ipKey = request.ip || 'unknown';
    const blockedFor = ipThrottle.blockedFor(ipKey);
    if (blockedFor > 0) return tooMany(reply, blockedFor);

    const userId = useTwoFactorTicket(body.ticket);
    if (!userId) {
      return reply.code(401).send({ error: 'That sign-in took too long or had too many tries. Start again.', restart: true });
    }
    const row = getUserRow(userId);
    const userKey = row?.username.toLowerCase() ?? '';
    if (userKey && userThrottle.blockedFor(userKey) > 0) return tooMany(reply, userThrottle.blockedFor(userKey));

    const code = typeof body.code === 'string' ? body.code.trim().slice(0, 32) : '';
    if (!row || !checkSecondFactor(userId, code)) {
      ipThrottle.fail(ipKey);
      if (userKey) userThrottle.fail(userKey);
      return reply.code(401).send({ error: 'That code is not right' });
    }

    spendTwoFactorTicket(body.ticket);
    ipThrottle.succeed(ipKey);
    userThrottle.succeed(userKey);
    signIn(request, reply, userId);
    return { user: { username: row.username } };
  });

  app.post('/api/auth/logout', { config: { public: true } }, async (request, reply) => {
    const token = readSessionToken(request);
    if (token) destroySession(token);
    clearSessionCookie(reply);
    return { ok: true };
  });

  app.post('/api/auth/password', async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as any;
    const next = body.next;

    const existing = getUserRow(user.id);
    if (!existing) return reply.code(401).send({ error: 'Authentication required' });
    const refused = confirmPassword(reply, existing, body.current, 'Current password is incorrect');
    if (refused) return refused;
    const problem = passwordProblem(next);
    if (problem) return reply.code(400).send({ error: problem });

    changePassword(existing.id, String(next));
    // changePassword drops every session, so issue a fresh one for this device.
    signIn(request, reply, existing.id);
    return { ok: true };
  });

  // ---- two-factor enrolment ------------------------------------------------

  /**
   * Starts enrolment: a fresh secret, shown as a QR code (drawn here, so the
   * secret never goes to a third-party QR service) and as text for typing in.
   * Nothing changes until /enable confirms a code from the app.
   */
  app.post('/api/auth/2fa/setup', async (request, reply) => {
    const user = request.user!;
    const row = getUserRow(user.id)!;
    if (row.totp_enabled) return reply.code(409).send({ error: 'Two-factor sign-in is already on' });

    const secret = generateSecret();
    db.prepare('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?').run(secret, user.id);
    const url = otpauthUrl(secret, user.username, ISSUER);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    return { secret, url, qr };
  });

  app.post('/api/auth/2fa/enable', async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as any;
    const row = getUserRow(user.id)!;
    if (row.totp_enabled) return reply.code(409).send({ error: 'Two-factor sign-in is already on' });
    if (!row.totp_secret) return reply.code(400).send({ error: 'Start the set-up first' });

    const step = verifyTotp(row.totp_secret, String(body.code ?? ''), null);
    if (step === null) {
      return reply.code(400).send({ error: 'That code is not right — check the phone’s clock is set automatically' });
    }

    const codes = generateRecoveryCodes();
    db.prepare(
      'UPDATE users SET totp_enabled = 1, totp_last_step = ?, totp_recovery = ? WHERE id = ?',
    ).run(step, JSON.stringify(codes.map(hashRecoveryCode)), user.id);
    request.log.info(`"${user.username}" turned on two-factor sign-in`);
    return { ok: true, recoveryCodes: codes };
  });

  /** Turning it off needs the password, so a borrowed unlocked phone is not enough. */
  app.post('/api/auth/2fa/disable', async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as any;
    const row = getUserRow(user.id)!;
    const refused = confirmPassword(reply, row, body.password);
    if (refused) return refused;
    db.prepare(
      'UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_recovery = NULL, totp_last_step = NULL WHERE id = ?',
    ).run(user.id);
    request.log.info(`"${user.username}" turned off two-factor sign-in`);
    return { ok: true };
  });

  app.post('/api/auth/2fa/recovery', async (request, reply) => {
    const user = request.user!;
    const body = (request.body ?? {}) as any;
    const row = getUserRow(user.id)!;
    if (!row.totp_enabled) return reply.code(400).send({ error: 'Two-factor sign-in is off' });
    const refused = confirmPassword(reply, row, body.password);
    if (refused) return refused;
    const codes = generateRecoveryCodes();
    db.prepare('UPDATE users SET totp_recovery = ? WHERE id = ?').run(
      JSON.stringify(codes.map(hashRecoveryCode)),
      user.id,
    );
    return { recoveryCodes: codes };
  });

  app.get('/api/auth/2fa', async (request) => {
    const row = getUserRow(request.user!.id)!;
    let remaining = 0;
    try {
      remaining = (JSON.parse(row.totp_recovery ?? '[]') as string[]).length;
    } catch {
      remaining = 0;
    }
    return { enabled: row.totp_enabled === 1, recoveryCodesLeft: row.totp_enabled ? remaining : 0 };
  });
}
