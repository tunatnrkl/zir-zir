'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app');

// Testler kendi kodunu kullanır; gerçek yönetici kodu repoda düz metin olarak yer almaz.
const TEST_CODE = 'deneme-kodu-ğüş';

async function start() {
  process.env.ADMIN_CODE = TEST_CODE;
  const server = createApp({ dbFile: ':memory:' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body, token } = {}) => {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return { server, call, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

test('yönetici kodu sunucuda doğrulanır', async (t) => {
  const { call, close } = await start();
  t.after(close);

  assert.equal((await call('/api/admin/players', { method: 'POST', body: { name: 'X' } })).status, 401);
  assert.equal((await call('/api/admin/players', { method: 'POST', body: { name: 'Xx' }, token: 'sahte' })).status, 401);
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { code: 'yanlis' } })).status, 401);

  const ok = await call('/api/admin/login', { method: 'POST', body: { code: TEST_CODE } });
  assert.equal(ok.status, 200);
  assert.ok(ok.data.token);
  // Büyük harf / boşluk toleransı (Türkçe yerelleştirme ile)
  assert.equal((await call('/api/admin/login', { method: 'POST', body: { code: ' Deneme-Kodu-ĞÜŞ ' } })).status, 200);

  assert.equal((await call('/api/admin/check', { token: ok.data.token })).status, 200);
  await call('/api/admin/logout', { method: 'POST', token: ok.data.token });
  assert.equal((await call('/api/admin/check', { token: ok.data.token })).status, 401);
});

test('çok fazla yanlış denemede kilitlenir', async (t) => {
  const { call, close } = await start();
  t.after(close);
  for (let i = 0; i < 8; i++) await call('/api/admin/login', { method: 'POST', body: { code: 'x' + i } });
  const r = await call('/api/admin/login', { method: 'POST', body: { code: TEST_CODE } });
  assert.equal(r.status, 429);
});

test('uçtan uca: oyuncu, maç, düzeltme, silme, manuel ELO', async (t) => {
  const { call, close } = await start();
  t.after(close);
  const { data: { token } } = await call('/api/admin/login', { method: 'POST', body: { code: TEST_CODE } });

  const ids = {};
  for (const name of ['Yusuf', 'Ahmet', 'Mehmet']) {
    const r = await call('/api/admin/players', { method: 'POST', body: { name }, token });
    assert.equal(r.status, 201);
    ids[name] = r.data.id;
  }
  assert.equal((await call('/api/admin/players', { method: 'POST', body: { name: 'yusuf' }, token })).status, 409);

  let st = (await call('/api/state')).data;
  assert.ok(st.players.every((p) => p.rating === 1000));

  // Herkes maç girebilir
  const m1 = await call('/api/matches', { method: 'POST', body: { playerA: ids.Yusuf, playerB: ids.Ahmet, scoreA: 4, scoreB: 0, result: 'A' } });
  assert.equal(m1.status, 201);
  assert.ok(m1.data.match.delta_a > 0 && m1.data.match.delta_b < 0);

  // Çift tıklama koruması
  const dup = await call('/api/matches', { method: 'POST', body: { playerA: ids.Yusuf, playerB: ids.Ahmet, result: 'A' } });
  assert.equal(dup.status, 409);

  // Doğrulamalar
  assert.equal((await call('/api/matches', { method: 'POST', body: { playerA: ids.Yusuf, playerB: ids.Yusuf, result: 'A' } })).status, 400);
  assert.equal((await call('/api/matches', { method: 'POST', body: { playerA: ids.Yusuf, playerB: ids.Mehmet, scoreA: 1, scoreB: 2, result: 'A' } })).status, 400);
  assert.equal((await call('/api/matches', { method: 'POST', body: { playerA: ids.Yusuf, playerB: 999, result: 'A' } })).status, 404);

  // Skordan sonuç çıkarımı (beraberlik)
  const m2 = await call('/api/matches', { method: 'POST', body: { playerA: ids.Mehmet, playerB: ids.Ahmet, scoreA: 2, scoreB: 2 } });
  assert.equal(m2.data.match.result, 'D');

  st = (await call('/api/state')).data;
  const y = st.players.find((p) => p.id === ids.Yusuf);
  assert.equal(y.rank, 1);
  assert.equal(y.wins, 1);
  assert.equal(st.matches.length, 2);

  // Düzeltme: maçı Ahmet kazanmış olsun → puanlar yeniden hesaplanır
  const ed = await call(`/api/admin/matches/${m1.data.match.id}`, {
    method: 'PUT', token, body: { playerA: ids.Yusuf, playerB: ids.Ahmet, scoreA: 0, scoreB: 1, result: 'B' },
  });
  assert.equal(ed.status, 200);
  st = (await call('/api/state')).data;
  assert.ok(st.players.find((p) => p.id === ids.Yusuf).rating < 1000);
  assert.equal(st.players.find((p) => p.id === ids.Yusuf).wins, 0);

  // Yönetici olmadan düzeltme/silme yok
  assert.equal((await call(`/api/admin/matches/${m1.data.match.id}`, { method: 'DELETE' })).status, 401);

  // Manuel ELO
  const before = st.players.find((p) => p.id === ids.Mehmet).rating;
  const adj = await call('/api/admin/adjust', { method: 'POST', token, body: { playerId: ids.Mehmet, amount: 50, reason: 'gol krallığı' } });
  assert.equal(adj.data.player.rating, before + 50);
  await call('/api/admin/adjust', { method: 'POST', token, body: { playerId: ids.Mehmet, amount: -100 } });
  st = (await call('/api/state')).data;
  assert.equal(st.players.find((p) => p.id === ids.Mehmet).rating, before - 50);
  assert.equal((await call('/api/admin/adjust', { method: 'POST', token, body: { playerId: ids.Mehmet, amount: 1.5 } })).status, 400);

  // Kayıtlar
  const log = (await call('/api/admin/log', { token })).data;
  assert.equal(log.adjustments.length, 2);
  const actions = log.audit.map((a) => a.action);
  for (const a of ['player_add', 'match_edit', 'elo_adjust', 'admin_login']) assert.ok(actions.includes(a), a);

  // Maç silme
  assert.equal((await call(`/api/admin/matches/${m2.data.match.id}`, { method: 'DELETE', token })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.matches.length, 1);

  // Oyuncu silme maçlarını da kaldırır
  assert.equal((await call(`/api/admin/players/${ids.Ahmet}`, { method: 'DELETE', token })).status, 200);
  st = (await call('/api/state')).data;
  assert.equal(st.players.length, 2);
  assert.equal(st.matches.length, 0);
  assert.equal(st.players.find((p) => p.id === ids.Yusuf).rating, 1000);
});

test('statik dosyalar ve dizin dışına çıkma koruması', async (t) => {
  const { server, close } = await start();
  t.after(close);
  const base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /ZIR ZIR/);
  assert.equal((await fetch(base + '/elo.js')).status, 200);
  assert.notEqual((await fetch(base + '/..%2Fsrc%2Fauth.js')).status, 200);
});
