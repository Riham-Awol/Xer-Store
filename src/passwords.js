// Password hashing with Web Crypto PBKDF2 — works in both Node.js and Cloudflare Workers.
// 20,000 rounds keeps a login inside the Workers free plan's 10 ms CPU budget.
// The round count is stored in each hash, so it can be raised later without breaking old logins.
import * as nodeCrypto from 'node:crypto';

const ROUNDS = 20000;
const enc = new TextEncoder();

const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((h) => parseInt(h, 16)));

async function derive(password, salt, rounds) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: rounds }, key, 256);
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ROUNDS}$${toHex(salt)}$${toHex(await derive(password, salt, ROUNDS))}`;
}

/** Returns { ok, rehash } — rehash is true when the stored hash uses an older format. */
export async function verifyPassword(password, stored) {
  const s = String(stored || '');
  if (s.startsWith('pbkdf2$')) {
    const [, rounds, salt, hash] = s.split('$');
    const test = new Uint8Array(await derive(password, fromHex(salt), Number(rounds)));
    return { ok: equal(test, fromHex(hash)), rehash: Number(rounds) !== ROUNDS };
  }
  // Older "salt:hash" scrypt format from the first version of the app (Node.js only).
  const [salt, hash] = s.split(':');
  if (salt && hash && typeof nodeCrypto.scryptSync === 'function') {
    const test = new Uint8Array(nodeCrypto.scryptSync(password, salt, 64));
    return { ok: equal(test, fromHex(hash)), rehash: true };
  }
  return { ok: false, rehash: false };
}

export function randomToken(bytes = 32) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
