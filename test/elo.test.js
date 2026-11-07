'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const elo = require('../src/elo');

const P = (id, t = 0) => ({ id, name: `P${id}`, created_at: t });

test('beklenen skor standart Elo formülü', () => {
  assert.equal(elo.expectedScore(1500, 1500), 0.5);
  assert.ok(Math.abs(elo.expectedScore(1600, 1200) - 0.909) < 0.001);
  assert.ok(Math.abs(elo.expectedScore(1200, 1600) + elo.expectedScore(1600, 1200) - 1) < 1e-12);
});

test('K faktörü yükseldikçe küçülür', () => {
  assert.equal(elo.kFactor(1000, 0), 40); // ilk maçlar
  assert.ok(elo.kFactor(1300, 20) > elo.kFactor(1600, 20));
  assert.ok(elo.kFactor(1600, 20) > elo.kFactor(1900, 20));
  assert.ok(elo.kFactor(1900, 20) > elo.kFactor(2200, 20));
});

test('kazanan kazanır, kaybeden kaybeder, herkes 1000 ile başlar', () => {
  const s = elo.replay([P(1), P(2)], [{ id: 1, player_a: 1, player_b: 2, result: 'A', played_at: 10 }], []);
  const [a, b] = [s.players.find((p) => p.id === 1), s.players.find((p) => p.id === 2)];
  assert.ok(a.rating > 1000);
  assert.ok(b.rating < 1000);
  assert.equal(a.wins, 1);
  assert.equal(b.losses, 1);
  assert.equal(s.matches[0].before_a, 1000);
  assert.equal(s.matches[0].delta_a, a.rating - 1000);
});

test('beraberlikte iki oyuncu da güncellenir; güçlü olan puan kaybeder', () => {
  const s = elo.replay(
    [P(1), P(2)],
    [{ id: 1, player_a: 1, player_b: 2, result: 'D', played_at: 10 }],
    [{ id: 1, player_id: 1, amount: 400, reason: '', created_at: 5 }]
  );
  const m = s.matches[0];
  assert.ok(m.delta_a < 0, 'güçlü oyuncu beraberlikte puan kaybeder');
  assert.ok(m.delta_b > 0, 'zayıf oyuncu beraberlikte puan kazanır');
  assert.equal(s.players.find((p) => p.id === 1).draws, 1);
});

test('yüksek seviyede aynı galibiyet daha az puan getirir', () => {
  const low = elo.computeMatch({ rating: 1300, games: 30 }, { rating: 1300, games: 30 }, 'A', 1600);
  const high = elo.computeMatch({ rating: 2100, games: 30 }, { rating: 2100, games: 30 }, 'A', 1600);
  assert.ok(low.deltaA > high.deltaA);
});

test('sürpriz galibiyet beklenen galibiyetten daha çok puan getirir', () => {
  const upset = elo.computeMatch({ rating: 1200, games: 30 }, { rating: 1700, games: 30 }, 'A', 1600);
  const fav = elo.computeMatch({ rating: 1700, games: 30 }, { rating: 1200, games: 30 }, 'A', 1600);
  assert.ok(upset.deltaA > fav.deltaA);
});

test('ortalama hedefteyken bonus yok; sistem sıfır toplamlıya yakın', () => {
  assert.equal(elo.balanceBonus(1600), 0);
  const r = elo.computeMatch({ rating: 1600, games: 30 }, { rating: 1600, games: 30 }, 'A', 1600);
  assert.equal(r.deltaA, -r.deltaB);
});

test('manuel düzeltmeler uygulanır ve taban puanın altına inilmez', () => {
  const s = elo.replay(
    [P(1)],
    [],
    [
      { id: 1, player_id: 1, amount: 50, reason: 'ödül', created_at: 1 },
      { id: 2, player_id: 1, amount: -1000, reason: 'ceza', created_at: 2 },
    ]
  );
  assert.equal(s.players[0].rating, elo.RATING_FLOOR);
  assert.equal(s.players[0].peak, 1050);
  assert.equal(s.adjustments.length, 2);
});

test('uzun vadede grup ortalaması ~1600 civarında dengelenir', () => {
  for (const n of [4, 6, 10]) {
    let seed = 42 + n;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const skill = Array.from({ length: n }, () => rnd() * 600);
    const players = skill.map((_, i) => P(i + 1));
    const matches = [];
    for (let k = 1; matches.length < 2500; k++) {
      const a = Math.floor(rnd() * n);
      const b = Math.floor(rnd() * n);
      if (a === b) continue;
      const e = 1 / (1 + 10 ** ((skill[b] - skill[a]) / 400));
      const r = rnd();
      const result = r < e * 0.85 ? 'A' : r < e * 0.85 + 0.15 ? 'D' : 'B';
      matches.push({ id: k, player_a: a + 1, player_b: b + 1, result, played_at: k });
    }
    const s = elo.replay(players, matches, []);
    assert.ok(Math.abs(s.average - 1600) <= 60, `n=${n} ortalama ${s.average}`);
    // Sıralama yeteneği yansıtmalı: en yetenekli oyuncu en alttakilerden yüksek
    const best = skill.indexOf(Math.max(...skill)) + 1;
    const worst = skill.indexOf(Math.min(...skill)) + 1;
    const rating = (id) => s.players.find((p) => p.id === id).rating;
    assert.ok(rating(best) > rating(worst));
  }
});

test('maç düzeltme/silme sonrası tekrar oynatma deterministik', () => {
  const players = [P(1), P(2), P(3)];
  const ms = [
    { id: 1, player_a: 1, player_b: 2, result: 'A', played_at: 10 },
    { id: 2, player_a: 2, player_b: 3, result: 'B', played_at: 11 },
    { id: 3, player_a: 3, player_b: 1, result: 'D', played_at: 12 },
  ];
  const a = elo.replay(players, ms, []);
  const b = elo.replay(players, [...ms].reverse(), []);
  assert.deepEqual(a.players, b.players);
  const without = elo.replay(players, ms.filter((m) => m.id !== 2), []);
  assert.equal(without.matches.length, 2);
});
