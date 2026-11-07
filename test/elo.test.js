'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const elo = require('../elo');

const T = 1_700_000_000_000;
const DAY = 86400000;
const P = (id, t = T) => ({ id, name: `P${id}`, created_at: t });
const pl = (r, rd = 60) => ({ r, rd, last: T });
const one = (a, b, result) => elo.computeGame([a], [b], result, T);

test('herkes 1000 ile başlar; kazanan kazanır, kaybeden kaybeder', () => {
  const s = elo.replay([P(1), P(2)], [{ id: 1, player_a: 1, player_b: 2, result: 'A', played_at: T + 10 }], []);
  const a = s.players.find((p) => p.id === 1);
  const b = s.players.find((p) => p.id === 2);
  assert.ok(a.rating > 1000 && b.rating < 1000);
  assert.equal(a.wins, 1);
  assert.equal(b.losses, 1);
  assert.equal(s.matches[0].a[0].before, 1000);
  assert.equal(s.matches[0].a[0].delta, a.rating - 1000);
});

test('çok güçlü oyuncu çok zayıfı yenince neredeyse puan almaz', () => {
  const r = one(pl(1900), pl(110), 'A');
  assert.ok(r.a[0].delta <= 1, `kazanılan ${r.a[0].delta}`);
  const upset = one(pl(1900), pl(110), 'B');
  assert.ok(upset.b[0].delta >= 15, 'sürpriz galibiyet çok puan getirir');
  assert.ok(upset.a[0].delta <= -15);
});

test('oturmuş eşit oyuncular arasında değişim ~10 ve simetrik', () => {
  const r = one(pl(1500), pl(1500), 'A');
  assert.ok(r.a[0].delta >= 8 && r.a[0].delta <= 12, `değişim ${r.a[0].delta}`);
  assert.equal(r.a[0].delta, -r.b[0].delta);
});

test('favori kazanınca az, sürpriz olunca çok puan', () => {
  const fav = one(pl(1600), pl(1400), 'A');
  const upset = one(pl(1400), pl(1600), 'A');
  assert.ok(upset.a[0].delta > fav.a[0].delta * 2);
});

test('yeni oyuncunun puanı hızlı değişir, oynadıkça oturur', () => {
  const players = [P(1), P(2)];
  const matches = [];
  for (let i = 0; i < 30; i++) {
    matches.push({ id: i + 1, player_a: 1, player_b: 2, result: i % 2 ? 'A' : 'B', played_at: T + (i + 1) * 1000 });
  }
  const s = elo.replay(players, matches, []);
  const first = Math.abs(s.matches[s.matches.length - 1].a[0].delta);
  const last = Math.abs(s.matches[0].a[0].delta);
  assert.ok(first > 60, `ilk maç ${first}`);
  assert.ok(last <= 12, `son maç ${last}`);
});

test('uzun süre oynamayanın belirsizliği artar', () => {
  const p = { r: 1500, rd: 60, last: T };
  assert.equal(Math.round(elo.currentRd(p, T)), 60);
  assert.ok(elo.currentRd(p, T + 365 * DAY) > 150);
  assert.ok(elo.currentRd(p, T + 5000 * DAY) <= 350);
});

test('2v2: beklenen sonuç takım ortalamalarına göre', () => {
  const even = elo.computeGame([pl(1600), pl(1400)], [pl(1500), pl(1500)], 'A', T);
  assert.ok(even.a.every((x) => x.delta >= 8 && x.delta <= 12));
  assert.ok(even.b.every((x) => x.delta <= -8));
  const lopsided = elo.computeGame([pl(1800), pl(1700)], [pl(1100), pl(1200)], 'A', T);
  assert.ok(lopsided.a.every((x) => x.delta <= 2), 'güçlü takım zayıfı yenince neredeyse puan almaz');
});

test('2v2 maçlar replay içinde dört oyuncuyu da günceller', () => {
  const s = elo.replay(
    [P(1), P(2), P(3), P(4)],
    [{ id: 1, player_a: 1, player_a2: 2, player_b: 3, player_b2: 4, result: 'B', played_at: T + 5 }],
    []
  );
  const by = (id) => s.players.find((p) => p.id === id);
  assert.ok(by(1).rating < 1000 && by(2).rating < 1000);
  assert.ok(by(3).rating > 1000 && by(4).rating > 1000);
  assert.equal(by(3).wins, 1);
  assert.equal(s.matches[0].team, true);
});

test('manuel düzeltmeler uygulanır ve taban puanın altına inilmez', () => {
  const s = elo.replay(
    [P(1)],
    [],
    [
      { id: 1, player_id: 1, amount: 50, reason: 'ödül', created_at: T + 1 },
      { id: 2, player_id: 1, amount: -2000, reason: 'ceza', created_at: T + 2 },
    ]
  );
  assert.equal(s.players[0].rating, elo.RATING_FLOOR);
  assert.equal(s.players[0].peak, 1050);
});

test('eski beraberlik kayıtları ve geçersiz maçlar yok sayılır', () => {
  const s = elo.replay(
    [P(1), P(2)],
    [
      { id: 1, player_a: 1, player_b: 2, result: 'D', played_at: T + 1 },
      { id: 2, player_a: 1, player_b: 1, result: 'A', played_at: T + 2 },
    ],
    []
  );
  assert.equal(s.matches.length, 0);
  assert.ok(s.players.every((p) => p.rating === 1000));
});

test('tekrar oynatma deterministik (sıra bağımsız)', () => {
  const players = [P(1), P(2), P(3)];
  const ms = [
    { id: 1, player_a: 1, player_b: 2, result: 'A', played_at: T + 10 },
    { id: 2, player_a: 2, player_b: 3, result: 'B', played_at: T + 11 },
    { id: 3, player_a: 3, player_b: 1, result: 'A', played_at: T + 12 },
  ];
  assert.deepEqual(elo.replay(players, ms, []).players, elo.replay(players, [...ms].reverse(), []).players);
});
