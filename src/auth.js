'use strict';

const crypto = require('node:crypto');

// Varsayılan yönetici kodunun scrypt özeti (kodun kendisi kaynakta yer almaz).
// ADMIN_CODE ortam değişkeni verilirse onun özeti kullanılır.
const DEFAULT_CODE_HASH =
  'scrypt$3a1ab8d2f7e12fdd2191451e24630c20$b3de2d7b369318117bcc0015fa4fe53040fb6c483dff2721804416d88e82ce2fada41064e78948e122ca5b17ddb0052df154b401528343f6e123871f829e0873';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function normalizeCode(code) {
  return String(code ?? '').normalize('NFC').trim().toLocaleLowerCase('tr-TR');
}

function hashCode(code) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(normalizeCode(code), salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyCode(code, stored) {
  const [alg, saltHex, hashHex] = String(stored).split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(normalizeCode(code), Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createAuth(db) {
  // Kod özetini veritabanına yaz (ilk açılışta veya ADMIN_CODE değiştiğinde).
  const getSetting = db.prepare('SELECT value FROM settings WHERE key = ?');
  const setSetting = db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  const envCode = process.env.ADMIN_CODE;
  const current = getSetting.get('admin_code_hash')?.value;
  if (envCode) {
    if (!current || !verifyCode(envCode, current)) setSetting.run('admin_code_hash', hashCode(envCode));
  } else if (!current) {
    setSetting.run('admin_code_hash', DEFAULT_CODE_HASH);
  }

  // Kaba kuvvet denemelerine karşı IP başına deneme sınırı.
  const attempts = new Map();
  const WINDOW_MS = 15 * 60 * 1000;
  const MAX_ATTEMPTS = 8;

  function rateLimited(ip) {
    const rec = attempts.get(ip);
    if (!rec || Date.now() - rec.first > WINDOW_MS) return false;
    return rec.count >= MAX_ATTEMPTS;
  }
  function recordFailure(ip) {
    const now = Date.now();
    const rec = attempts.get(ip);
    if (!rec || now - rec.first > WINDOW_MS) attempts.set(ip, { first: now, count: 1 });
    else rec.count++;
  }

  const insertSession = db.prepare('INSERT INTO admin_sessions(token_hash, expires_at) VALUES(?, ?)');
  const findSession = db.prepare('SELECT expires_at FROM admin_sessions WHERE token_hash = ?');
  const deleteSession = db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?');
  const purge = db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?');

  return {
    login(code, ip) {
      if (rateLimited(ip)) return { ok: false, status: 429, error: 'Çok fazla deneme. 15 dakika sonra tekrar dene.' };
      const stored = getSetting.get('admin_code_hash')?.value;
      if (typeof code !== 'string' || code.length > 200 || !stored || !verifyCode(code, stored)) {
        recordFailure(ip);
        return { ok: false, status: 401, error: 'Yanlış kod. ZIR ZIR AĞLAMA.' };
      }
      attempts.delete(ip);
      purge.run(Date.now());
      const token = crypto.randomBytes(32).toString('base64url');
      const expiresAt = Date.now() + SESSION_TTL_MS;
      insertSession.run(sha256(token), expiresAt);
      return { ok: true, token, expiresAt };
    },
    isAdmin(token) {
      if (!token || typeof token !== 'string' || token.length > 200) return false;
      const row = findSession.get(sha256(token));
      return !!row && row.expires_at > Date.now();
    },
    logout(token) {
      if (token && typeof token === 'string') deleteSession.run(sha256(token));
    },
  };
}

module.exports = { createAuth, hashCode, verifyCode, normalizeCode };
