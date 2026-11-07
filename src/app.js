'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, tx } = require('./db');
const { createAuth } = require('./auth');
const elo = require('./elo');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const ELO_FILE = path.join(__dirname, 'elo.js');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

function nameKey(name) {
  return name.normalize('NFC').toLocaleLowerCase('tr-TR').replace(/\s+/g, ' ').trim();
}

function cleanName(raw) {
  if (typeof raw !== 'string') throw bad('Oyuncu adı gerekli.');
  const name = raw.normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
  if (name.length < 2 || name.length > 20) throw bad('Oyuncu adı 2-20 karakter olmalı.');
  return name;
}

function toId(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw bad('Geçersiz kimlik.');
  return n;
}

/** Maç girdisini doğrular ve normalize eder. */
function parseMatchInput(body) {
  const playerA = toId(body.playerA);
  const playerB = toId(body.playerB);
  if (playerA === playerB) throw bad('Bir oyuncu kendisiyle maç yapamaz.');

  let scoreA = body.scoreA;
  let scoreB = body.scoreB;
  const hasA = scoreA !== undefined && scoreA !== null && scoreA !== '';
  const hasB = scoreB !== undefined && scoreB !== null && scoreB !== '';
  if (hasA !== hasB) throw bad('Skor girilecekse iki taraf da girilmeli.');
  if (hasA) {
    scoreA = Number(scoreA);
    scoreB = Number(scoreB);
    for (const s of [scoreA, scoreB]) {
      if (!Number.isInteger(s) || s < 0 || s > 99) throw bad('Skor 0-99 arası bir tam sayı olmalı.');
    }
  } else {
    scoreA = null;
    scoreB = null;
  }

  let result = body.result;
  const fromScore = hasA ? (scoreA > scoreB ? 'A' : scoreA < scoreB ? 'B' : 'D') : null;
  if (result === undefined || result === null || result === '') {
    if (!fromScore) throw bad('Kazananı seç.');
    result = fromScore;
  }
  if (!['A', 'B', 'D'].includes(result)) throw bad('Geçersiz sonuç.');
  if (fromScore && fromScore !== result) throw bad('Skor ile seçilen sonuç uyuşmuyor.');
  return { playerA, playerB, scoreA, scoreB, result };
}

function createApp({ dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'zirzir.db') } = {}) {
  const db = openDb(dbFile);
  const auth = createAuth(db);
  const trustProxy = process.env.TRUST_PROXY === '1';

  const q = {
    players: db.prepare('SELECT id, name, created_at FROM players'),
    matches: db.prepare('SELECT id, player_a, player_b, score_a, score_b, result, played_at FROM matches'),
    adjustments: db.prepare('SELECT id, player_id, amount, reason, created_at FROM adjustments'),
    playerById: db.prepare('SELECT id, name FROM players WHERE id = ?'),
    playerByKey: db.prepare('SELECT id FROM players WHERE name_key = ?'),
    insertPlayer: db.prepare('INSERT INTO players(name, name_key, created_at) VALUES(?, ?, ?)'),
    renamePlayer: db.prepare('UPDATE players SET name = ?, name_key = ? WHERE id = ?'),
    deletePlayer: db.prepare('DELETE FROM players WHERE id = ?'),
    matchById: db.prepare('SELECT * FROM matches WHERE id = ?'),
    recentDuplicate: db.prepare(
      'SELECT id FROM matches WHERE player_a = ? AND player_b = ? AND result = ? AND played_at > ? LIMIT 1'
    ),
    insertMatch: db.prepare(
      'INSERT INTO matches(player_a, player_b, score_a, score_b, result, played_at) VALUES(?, ?, ?, ?, ?, ?)'
    ),
    updateMatch: db.prepare(
      'UPDATE matches SET player_a = ?, player_b = ?, score_a = ?, score_b = ?, result = ? WHERE id = ?'
    ),
    deleteMatch: db.prepare('DELETE FROM matches WHERE id = ?'),
    countPlayerMatches: db.prepare('SELECT COUNT(*) AS n FROM matches WHERE player_a = ? OR player_b = ?'),
    insertAdjustment: db.prepare('INSERT INTO adjustments(player_id, amount, reason, created_at) VALUES(?, ?, ?, ?)'),
    insertAudit: db.prepare('INSERT INTO audit_log(action, details, created_at) VALUES(?, ?, ?)'),
    auditLog: db.prepare('SELECT id, action, details, created_at FROM audit_log ORDER BY id DESC LIMIT 300'),
  };

  // Aynı milisaniyede iki olay olmasın diye zaman damgası daima artan olur.
  let lastTs = 0;
  const now = () => (lastTs = Math.max(Date.now(), lastTs + 1));

  // ---- Durum (sıralama) önbelleği ----
  let version = 0;
  let stateJson = '';
  let state = null;
  function recompute() {
    state = elo.replay(q.players.all(), q.matches.all(), q.adjustments.all());
    version++;
    stateJson = JSON.stringify({
      version,
      target: elo.TARGET_AVERAGE,
      start: elo.START_RATING,
      average: state.average,
      players: state.players,
      matches: state.matches,
    });
    for (const res of clients) res.write(`event: update\ndata: ${version}\n\n`);
  }

  const audit = (action, details) => q.insertAudit.run(action, JSON.stringify(details), now());

  // ---- SSE istemcileri ----
  const clients = new Set();
  const heartbeat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 25000);
  heartbeat.unref();

  recompute();

  // ---- Yardımcılar ----
  function send(res, status, data, extraHeaders = {}) {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...extraHeaders,
    });
    res.end(body);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > 16 * 1024) {
          reject(new HttpError(413, 'İstek çok büyük.'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => {
        if (!chunks.length) return resolve({});
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
        } catch {
          reject(bad('Geçersiz JSON.'));
        }
      });
      req.on('error', reject);
    });
  }

  function clientIp(req) {
    if (trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress || 'unknown';
  }

  function bearer(req) {
    const h = req.headers.authorization;
    return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
  }

  function requireAdmin(req) {
    if (!auth.isAdmin(bearer(req))) throw new HttpError(401, 'Yönetici yetkisi gerekli.');
  }

  function requirePlayer(id) {
    const p = q.playerById.get(id);
    if (!p) throw new HttpError(404, 'Oyuncu bulunamadı.');
    return p;
  }

  function matchSummary(id) {
    return state.matches.find((m) => m.id === id) || null;
  }

  // ---- API ----
  async function api(req, res, url) {
    const method = req.method;
    const p = url.pathname;
    let m;

    if (method === 'GET' && p === '/api/state') return send(res, 200, stateJson);

    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(`retry: 3000\nevent: update\ndata: ${version}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (method === 'POST' && p === '/api/matches') {
      const input = parseMatchInput(await readBody(req));
      const id = tx(db, () => {
        requirePlayer(input.playerA);
        requirePlayer(input.playerB);
        const t = now();
        if (q.recentDuplicate.get(input.playerA, input.playerB, input.result, t - 15000)) {
          throw new HttpError(409, 'Bu maç az önce kaydedildi. İki kere basmış olabilirsin.');
        }
        return Number(
          q.insertMatch.run(input.playerA, input.playerB, input.scoreA, input.scoreB, input.result, t).lastInsertRowid
        );
      });
      recompute();
      return send(res, 201, { match: matchSummary(id), version });
    }

    if (method === 'POST' && p === '/api/admin/login') {
      const body = await readBody(req);
      const r = auth.login(body.code, clientIp(req));
      if (!r.ok) return send(res, r.status, { error: r.error });
      tx(db, () => audit('admin_login', { ip: clientIp(req) }));
      return send(res, 200, { token: r.token, expiresAt: r.expiresAt });
    }

    if (method === 'POST' && p === '/api/admin/logout') {
      auth.logout(bearer(req));
      return send(res, 200, { ok: true });
    }

    if (!p.startsWith('/api/admin/')) throw new HttpError(404, 'Bulunamadı.');

    // ---- Bundan sonrası yalnızca yönetici ----
    requireAdmin(req);

    if (method === 'GET' && p === '/api/admin/check') return send(res, 200, { ok: true });

    if (method === 'GET' && p === '/api/admin/log') {
      return send(res, 200, {
        adjustments: state.adjustments,
        audit: q.auditLog.all().map((r) => ({ ...r, details: JSON.parse(r.details) })),
      });
    }

    if (method === 'POST' && p === '/api/admin/players') {
      const name = cleanName((await readBody(req)).name);
      const id = tx(db, () => {
        if (q.playerByKey.get(nameKey(name))) throw new HttpError(409, 'Bu isimde bir oyuncu zaten var.');
        const id = Number(q.insertPlayer.run(name, nameKey(name), now()).lastInsertRowid);
        audit('player_add', { playerId: id, name });
        return id;
      });
      recompute();
      return send(res, 201, { id });
    }

    if ((m = p.match(/^\/api\/admin\/players\/(\d+)$/))) {
      const id = toId(m[1]);
      if (method === 'PATCH') {
        const name = cleanName((await readBody(req)).name);
        tx(db, () => {
          const old = requirePlayer(id);
          const other = q.playerByKey.get(nameKey(name));
          if (other && other.id !== id) throw new HttpError(409, 'Bu isimde bir oyuncu zaten var.');
          q.renamePlayer.run(name, nameKey(name), id);
          audit('player_rename', { playerId: id, from: old.name, to: name });
        });
        recompute();
        return send(res, 200, { ok: true });
      }
      if (method === 'DELETE') {
        tx(db, () => {
          const old = requirePlayer(id);
          const { n } = q.countPlayerMatches.get(id, id);
          const snapshot = state.players.find((s) => s.id === id);
          q.deletePlayer.run(id); // maçlar ve düzeltmeler CASCADE ile silinir
          audit('player_delete', { playerId: id, name: old.name, rating: snapshot?.rating, matchesRemoved: n });
        });
        recompute();
        return send(res, 200, { ok: true });
      }
    }

    if (method === 'POST' && p === '/api/admin/adjust') {
      const body = await readBody(req);
      const playerId = toId(body.playerId);
      const amount = Number(body.amount);
      if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) {
        throw bad('Miktar -1000 ile +1000 arasında, sıfırdan farklı bir tam sayı olmalı.');
      }
      const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 120) : '';
      tx(db, () => {
        const pl = requirePlayer(playerId);
        const before = state.players.find((s) => s.id === playerId)?.rating;
        const adjId = Number(q.insertAdjustment.run(playerId, amount, reason, now()).lastInsertRowid);
        audit('elo_adjust', { adjustmentId: adjId, playerId, name: pl.name, amount, reason, before });
      });
      recompute();
      return send(res, 200, { ok: true, player: state.players.find((s) => s.id === playerId) });
    }

    if ((m = p.match(/^\/api\/admin\/matches\/(\d+)$/))) {
      const id = toId(m[1]);
      if (method === 'PUT') {
        const input = parseMatchInput(await readBody(req));
        tx(db, () => {
          const old = q.matchById.get(id);
          if (!old) throw new HttpError(404, 'Maç bulunamadı.');
          requirePlayer(input.playerA);
          requirePlayer(input.playerB);
          q.updateMatch.run(input.playerA, input.playerB, input.scoreA, input.scoreB, input.result, id);
          audit('match_edit', {
            matchId: id,
            before: { ...matchSummary(id) },
            after: input,
          });
        });
        recompute();
        return send(res, 200, { match: matchSummary(id) });
      }
      if (method === 'DELETE') {
        tx(db, () => {
          if (!q.matchById.get(id)) throw new HttpError(404, 'Maç bulunamadı.');
          const snap = matchSummary(id);
          q.deleteMatch.run(id);
          audit('match_delete', { matchId: id, match: snap });
        });
        recompute();
        return send(res, 200, { ok: true });
      }
    }

    throw new HttpError(404, 'Bulunamadı.');
  }

  // ---- Statik dosyalar ----
  function serveStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Desteklenmiyor.' });
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return send(res, 400, { error: 'Geçersiz adres.' });
    }
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    // Tarayıcıdaki maç önizlemesi sunucuyla aynı ELO kodunu kullanır.
    const file = rel === '/elo.js' ? ELO_FILE : path.normalize(path.join(PUBLIC_DIR, rel));
    if (file !== ELO_FILE && !file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'Yasak.' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, { error: 'Bulunamadı.' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : data);
    });
  }

  const server = http.createServer(async (req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'Geçersiz adres.' });
    }
    if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url);
    try {
      await api(req, res, url);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'Sunucu hatası.' });
    }
  });

  server.on('close', () => {
    clearInterval(heartbeat);
    for (const r of clients) r.end();
    db.close();
  });

  return server;
}

module.exports = { createApp, parseMatchInput };
