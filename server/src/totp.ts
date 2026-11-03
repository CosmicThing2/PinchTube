/*
 * totp.ts — two-factor sign-in codes (the six-digit codes from an
 * authenticator app) and recovery codes.
 *
 * Self-contained maths with no database access: making a secret, turning it
 * into the QR-code link an app scans, checking a typed code, and making and
 * hashing single-use recovery codes. routes/auth.ts uses these for turning
 * two-factor on and off and for the code step of signing in; auth.ts stores
 * the secret and the last accepted code on the account.
 */

import crypto from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238) — the six-digit codes produced by
 * Google Authenticator, Authy, 1Password, Aegis and the like. SHA-1, 30-second
 * steps and six digits are what every one of those apps assumes by default.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
/** Codes from one step either side are accepted, for clocks that drift a little. */
const WINDOW = 1;

// ---- base32, the text form authenticator apps use for the secret -----------

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Bytes to base32 text, five bits per letter. */
export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 text back to bytes, ignoring spaces and anything else that is not base32. */
export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- codes ------------------------------------------------------------------

/** 160 random bits, the length RFC 4226 recommends for SHA-1. */
export function generateSecret(): string {
  return base32Encode(crypto.randomBytes(20));
}

/** The six-digit code for one 30-second step (the HOTP algorithm of RFC 4226). */
function codeAt(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** Which 30-second step a moment falls in. */
export function currentStep(now = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Checks a code and returns the time step it matched, or null. Callers store
 * that step and refuse anything at or before it next time, so a code that has
 * been seen once — over someone's shoulder, say — cannot be used again.
 */
export function verifyTotp(secretB32: string, code: string, lastStep: number | null): number | null {
  const digits = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(digits)) return null;
  const secret = base32Decode(secretB32);
  const now = currentStep();
  for (let delta = -WINDOW; delta <= WINDOW; delta++) {
    const step = now + delta;
    if (lastStep !== null && step <= lastStep) continue;
    const expected = Buffer.from(codeAt(secret, step));
    if (crypto.timingSafeEqual(expected, Buffer.from(digits))) return step;
  }
  return null;
}

/** The link an authenticator app reads out of the QR code. */
export function otpauthUrl(secretB32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretB32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---- recovery codes ---------------------------------------------------------

/** Recovery codes are stored hashed, ignoring case and dashes. */
export function hashRecoveryCode(code: string): string {
  const normalised = code.toLowerCase().replace(/[^0-9a-z]/g, '');
  return crypto.createHash('sha256').update(normalised).digest('hex');
}

/** Ten single-use codes in the form "a1b2-c3d4-e5f6", for when the phone is lost. */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const hex = crypto.randomBytes(6).toString('hex');
    return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}`;
  });
}
