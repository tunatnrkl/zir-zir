/*
 * ZIR ZIR veri katmanı.
 *  - Supabase ayarlıysa: ortak veritabanı (bütün yazmalar sunucu fonksiyonlarından geçer).
 *  - Ayarlı değilse: veriler yalnızca bu tarayıcının localStorage'ında.
 * İki mod da aynı arayüzü sunar; puan hesabı her iki durumda elo.js ile yapılır.
 *
 * Maç: { a, b, a2?, b2?, result: 'A'|'B' }  (a2/b2 sadece 2v2'de)
 */
(function () {
  'use strict';

  const cfg = window.ZIR_CONFIG || {};
  const normCode = (c) => String(c ?? '').normalize('NFC').trim().toLocaleLowerCase('tr-TR');

  class StoreError extends Error {
    constructor(message, auth = false) {
      super(message);
      this.auth = auth; // yönetici oturumu geçersiz
    }
  }

  // ===================================================================
  // Supabase (ortak veritabanı)
  // ===================================================================
  function createRemote(url, key) {
    const base = url.replace(/\/+$/, '') + '/rest/v1/';
    // Yeni anahtarlar (sb_publishable_ / sb_secret_) JWT değildir; yalnızca apikey başlığı yeterli.
    // Eski anon anahtarı (eyJ...) için Authorization başlığı da gönderilir.
    const headers = { apikey: key, 'Content-Type': 'application/json' };
    if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;

    async function req(path, opts = {}) {
      let res;
      try {
        res = await fetch(base + path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
      } catch {
        throw new StoreError('Sunucuya ulaşılamıyor. İnternet bağlantını kontrol et.');
      }
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {}
      if (!res.ok) {
        const msg = (data && (data.message || data.error)) || `Sunucu hatası (${res.status}).`;
        throw new StoreError(msg, data && data.code === '28000');
      }
      return data;
    }
    const rpc = (fn, args = {}) => req(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });

    // PostgREST tek seferde en fazla 1000 satır döndürür; sayfa sayfa çek.
    async function all(table, cols) {
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const rows = await req(`${table}?select=${cols}&order=id.asc&limit=1000&offset=${offset}`);
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    }
    const num = (v) => (v == null ? null : Number(v));

    return {
      mode: 'remote',
      async version() {
        return Number(await rpc('zz_version'));
      },
      async load() {
        const [players, matches, adjustments] = await Promise.all([
          all('players', 'id,name,created_at'),
          all('matches', 'id,player_a,player_b,player_a2,player_b2,result,played_at'),
          all('adjustments', 'id,player_id,amount,reason,created_at'),
        ]);
        return {
          players: players.map((p) => ({ ...p, id: num(p.id), created_at: num(p.created_at) })),
          matches: matches.map((m) => ({
            ...m,
            id: num(m.id),
            player_a: num(m.player_a),
            player_b: num(m.player_b),
            player_a2: num(m.player_a2),
            player_b2: num(m.player_b2),
            played_at: num(m.played_at),
          })),
          adjustments: adjustments.map((a) => ({
            ...a,
            id: num(a.id),
            player_id: num(a.player_id),
            created_at: num(a.created_at),
          })),
        };
      },
      async addMatch(m) {
        const id = m.a2
          ? await rpc('zz_add_team_match', { p_a: m.a, p_a2: m.a2, p_b: m.b, p_b2: m.b2, p_result: m.result })
          : await rpc('zz_add_match', { p_a: m.a, p_b: m.b, p_result: m.result });
        return Number(id);
      },
      addPlayer: (name) => rpc('zz_add_player', { p_name: name }),
      async login(code) {
        const r = await rpc('zz_admin_login', { p_code: normCode(code) });
        if (!r || !r.ok) throw new StoreError((r && r.error) || 'Giriş başarısız.');
        return r.token;
      },
      check: (t) => rpc('zz_admin_check', { p_token: t }),
      logout: (t) => rpc('zz_admin_logout', { p_token: t }),
      async log(t) {
        const rows = await rpc('zz_admin_log', { p_token: t });
        return rows.map((r) => ({ ...r, created_at: num(r.created_at) }));
      },
      renamePlayer: (t, id, name) => rpc('zz_admin_rename_player', { p_token: t, p_id: id, p_name: name }),
      deletePlayer: (t, id, rating) => rpc('zz_admin_delete_player', { p_token: t, p_id: id, p_rating: rating }),
      adjust: (t, id, amount, reason, before) =>
        rpc('zz_admin_adjust', { p_token: t, p_player: id, p_amount: amount, p_reason: reason, p_before: before }),
      flipMatch: (t, id) => rpc('zz_admin_flip_match', { p_token: t, p_id: id }),
      deleteMatch: (t, id) => rpc('zz_admin_delete_match', { p_token: t, p_id: id }),
      subscribe() {}, // yoklama (polling) app.js'de
    };
  }

  // ===================================================================
  // Yerel mod (yalnızca bu tarayıcı)
  // ===================================================================
  function createLocal() {
    const KEY = 'zirzir_demo_v1';
    // Yönetici kodunun PBKDF2-SHA256 özeti (kodun kendisi burada yok)
    const SALT = '71824b501fe05bc7cc9e83834684d023';
    const HASH = 'f6af8cda17be4c63386335061d7f354daf3b5b816974f47f6bcfe12474758a71';

    const empty = () => ({ seq: 0, version: 0, players: [], matches: [], adjustments: [], audit: [], sessions: [] });
    function read() {
      try {
        return { ...empty(), ...JSON.parse(localStorage.getItem(KEY) || '{}') };
      } catch {
        return empty();
      }
    }
    function write(db) {
      db.version++;
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
      } catch {
        throw new StoreError('Tarayıcı hafızasına yazılamadı.');
      }
    }
    let last = 0;
    const now = () => (last = Math.max(Date.now(), last + 1));
    const nextId = (db) => ++db.seq;
    const audit = (db, action, details) => db.audit.push({ id: nextId(db), action, details, created_at: now() });
    const names = (db, ids) =>
      ids
        .filter((x) => x != null)
        .map((id) => db.players.find((p) => p.id === id)?.name)
        .join(' & ');

    function cleanName(raw) {
      const n = String(raw ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
      if (n.length < 2 || n.length > 20) throw new StoreError('Oyuncu adı 2-20 karakter olmalı.');
      return n;
    }
    const key = (n) => n.toLocaleLowerCase('tr-TR');
    function requireAdmin(db, token) {
      if (!db.sessions.some((s) => s.token === token && s.expires > Date.now())) throw new StoreError('Yönetici yetkisi gerekli.', true);
    }
    function player(db, id) {
      const p = db.players.find((x) => x.id === id);
      if (!p) throw new StoreError('Oyuncu bulunamadı.');
      return p;
    }
    const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    const unhex = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

    async function verify(code) {
      if (!window.crypto || !crypto.subtle) throw new StoreError('Bu tarayıcı güvenli giriş desteklemiyor (https gerekli).');
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(normCode(code)), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unhex(SALT), iterations: 150000 }, k, 256);
      return hex(bits) === HASH;
    }
    let fails = [];

    // Her işlem: oku → değiştir → yaz
    const tx = (fn) => {
      const db = read();
      const r = fn(db);
      write(db);
      return r;
    };

    return {
      mode: 'local',
      async version() {
        return read().version;
      },
      async load() {
        const db = read();
        return { players: db.players, matches: db.matches, adjustments: db.adjustments };
      },
      async addMatch(m) {
        return tx((db) => {
          const a2 = m.a2 ?? null;
          const b2 = m.b2 ?? null;
          if ((a2 == null) !== (b2 == null)) throw new StoreError("Takımlar 2'şer kişi olmalı.");
          const ids = [m.a, a2, m.b, b2].filter((x) => x != null);
          if (!m.a || !m.b) throw new StoreError('Oyuncuları seç.');
          if (new Set(ids).size !== ids.length) throw new StoreError('Aynı oyuncu iki kere seçilemez.');
          ids.forEach((id) => player(db, id));
          if (m.result !== 'A' && m.result !== 'B') throw new StoreError('Kazananı seç.');
          const t = now();
          if (
            db.matches.some(
              (x) =>
                x.player_a === m.a && x.player_b === m.b && x.player_a2 === a2 && x.player_b2 === b2 &&
                x.result === m.result && x.played_at > t - 15000
            )
          ) {
            throw new StoreError('Bu maç az önce kaydedildi. İki kere basmış olabilirsin.');
          }
          const id = nextId(db);
          db.matches.push({ id, player_a: m.a, player_a2: a2, player_b: m.b, player_b2: b2, result: m.result, played_at: t });
          return id;
        });
      },
      async addPlayer(name) {
        return tx((db) => {
          const n = cleanName(name);
          if (db.players.some((p) => key(p.name) === key(n))) throw new StoreError('Bu isimde bir oyuncu zaten var.');
          const id = nextId(db);
          db.players.push({ id, name: n, created_at: now() });
          audit(db, 'player_add', { playerId: id, name: n });
          return id;
        });
      },
      async login(code) {
        fails = fails.filter((t) => Date.now() - t < 900000);
        if (fails.length >= 8) throw new StoreError('Çok fazla deneme. 15 dakika sonra tekrar dene.');
        if (typeof code !== 'string' || code.length > 200 || !(await verify(code))) {
          fails.push(Date.now());
          throw new StoreError('Yanlış kod. ZIR ZIR AĞLAMA.');
        }
        const token = hex(crypto.getRandomValues(new Uint8Array(32)));
        tx((db) => {
          db.sessions = db.sessions.filter((s) => s.expires > Date.now());
          db.sessions.push({ token, expires: Date.now() + 12 * 3600e3 });
          audit(db, 'admin_login', {});
        });
        return token;
      },
      async check(t) {
        requireAdmin(read(), t);
        return true;
      },
      async logout(t) {
        tx((db) => {
          db.sessions = db.sessions.filter((s) => s.token !== t);
        });
      },
      async log(t) {
        const db = read();
        requireAdmin(db, t);
        return [...db.audit].reverse().slice(0, 300);
      },
      async renamePlayer(t, id, name) {
        tx((db) => {
          requireAdmin(db, t);
          const n = cleanName(name);
          const p = player(db, id);
          if (db.players.some((x) => x.id !== id && key(x.name) === key(n))) throw new StoreError('Bu isimde bir oyuncu zaten var.');
          audit(db, 'player_rename', { playerId: id, from: p.name, to: n });
          p.name = n;
        });
      },
      async deletePlayer(t, id, rating) {
        tx((db) => {
          requireAdmin(db, t);
          const p = player(db, id);
          const before = db.matches.length;
          db.matches = db.matches.filter((m) => ![m.player_a, m.player_b, m.player_a2, m.player_b2].includes(id));
          db.adjustments = db.adjustments.filter((a) => a.player_id !== id);
          db.players = db.players.filter((x) => x.id !== id);
          audit(db, 'player_delete', { playerId: id, name: p.name, rating, matchesRemoved: before - db.matches.length });
        });
      },
      async adjust(t, id, amount, reason, before) {
        tx((db) => {
          requireAdmin(db, t);
          if (!Number.isInteger(amount) || amount === 0 || Math.abs(amount) > 1000) {
            throw new StoreError('Miktar -1000 ile +1000 arasında, sıfırdan farklı bir tam sayı olmalı.');
          }
          const p = player(db, id);
          const r = String(reason || '').trim().slice(0, 120);
          const adjId = nextId(db);
          db.adjustments.push({ id: adjId, player_id: id, amount, reason: r, created_at: now() });
          audit(db, 'elo_adjust', { adjustmentId: adjId, playerId: id, name: p.name, amount, reason: r, before });
        });
      },
      async flipMatch(t, id) {
        tx((db) => {
          requireAdmin(db, t);
          const m = db.matches.find((x) => x.id === id);
          if (!m) throw new StoreError('Maç bulunamadı.');
          m.result = m.result === 'A' ? 'B' : 'A';
          audit(db, 'match_flip', {
            matchId: id,
            teamA: names(db, [m.player_a, m.player_a2]),
            teamB: names(db, [m.player_b, m.player_b2]),
            newWinner: m.result,
          });
        });
      },
      async deleteMatch(t, id) {
        tx((db) => {
          requireAdmin(db, t);
          const m = db.matches.find((x) => x.id === id);
          if (!m) throw new StoreError('Maç bulunamadı.');
          db.matches = db.matches.filter((x) => x.id !== id);
          audit(db, 'match_delete', {
            matchId: id,
            teamA: names(db, [m.player_a, m.player_a2]),
            teamB: names(db, [m.player_b, m.player_b2]),
            result: m.result,
          });
        });
      },
      // Diğer sekmelerdeki değişiklikleri anında yakala
      subscribe(cb) {
        window.addEventListener('storage', (e) => e.key === KEY && cb());
      },
    };
  }

  window.ZirStore =
    cfg.supabaseUrl && cfg.supabaseAnonKey ? createRemote(cfg.supabaseUrl, cfg.supabaseAnonKey) : createLocal();
})();
