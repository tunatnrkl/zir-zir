/**
 * ZIR ZIR ELO motoru.
 *
 * Puanlar veritabanında saklanmaz; oyuncu katılımları, maçlar ve manuel
 * düzeltmeler zaman sırasına göre baştan oynatılarak hesaplanır. Böylece bir
 * maç düzeltildiğinde/silindiğinde bütün sıralama her zaman tutarlı kalır.
 *
 * Kurallar:
 *  - Herkes START_RATING (1000) ile başlar.
 *  - Beklenen skor standart Elo: E = 1 / (1 + 10^((Rb - Ra) / 400)).
 *  - Değişim: K * (S - E). K, oyuncunun seviyesine göre küçülür
 *    (yükseldikçe puan kazanmak zorlaşır), ilk maçlarda daha büyüktür.
 *  - Lig dengesi bonusu: Grubun ortalaması TARGET_AVERAGE (1600) altındayken
 *    kazanana (beraberlikte iki tarafa yarım) küçük bir bonus verilir; ortalama
 *    hedefin üzerine çıkarsa bonus negatife döner. Bonus farkla orantılı
 *    olduğundan ortalama zamanla ~1600 civarında dengelenir.
 */

(function (root) {
'use strict';

const START_RATING = 1000;
const TARGET_AVERAGE = 1600;
const RATING_FLOOR = 100;
const PROVISIONAL_GAMES = 10;
const BONUS_DIVISOR = 20; // her 20 puanlık açık için 1 bonus puan
const BONUS_MIN = -8;
const BONUS_MAX = 25;

function kFactor(rating, gamesPlayed) {
  if (gamesPlayed < PROVISIONAL_GAMES) return 40;
  if (rating < 1400) return 32;
  if (rating < 1800) return 24;
  if (rating < 2100) return 20;
  return 16;
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** Grubun ortalamasına göre maç başına lig dengesi bonusu. */
function balanceBonus(average) {
  return clamp(Math.round((TARGET_AVERAGE - average) / BONUS_DIVISOR), BONUS_MIN, BONUS_MAX);
}

/**
 * Tek bir maçın puan değişimlerini hesaplar.
 * @param {{rating:number, games:number}} a
 * @param {{rating:number, games:number}} b
 * @param {'A'|'B'|'D'} result
 * @param {number} average  maç anındaki grup ortalaması
 */
function computeMatch(a, b, result, average) {
  const ea = expectedScore(a.rating, b.rating);
  const eb = 1 - ea;
  const sa = result === 'A' ? 1 : result === 'D' ? 0.5 : 0;
  const sb = 1 - sa;
  const ka = kFactor(a.rating, a.games);
  const kb = kFactor(b.rating, b.games);
  const bonus = balanceBonus(average);

  let da = ka * (sa - ea);
  let db = kb * (sb - eb);

  // Bonus, oyuncunun K'sı ile ölçeklenir: üst seviyede bonus da küçülür.
  if (result === 'A') da += (bonus * ka) / 32;
  else if (result === 'B') db += (bonus * kb) / 32;
  else {
    da += (bonus * ka) / 64;
    db += (bonus * kb) / 64;
  }

  da = Math.round(da);
  db = Math.round(db);

  // Kazanan her zaman puan kazanır, kaybeden her zaman puan kaybeder.
  if (result === 'A') { da = Math.max(1, da); db = Math.min(-1, db); }
  if (result === 'B') { db = Math.max(1, db); da = Math.min(-1, da); }

  // Taban puanın altına düşülmez.
  da = Math.max(RATING_FLOOR - a.rating, da);
  db = Math.max(RATING_FLOOR - b.rating, db);

  return { deltaA: da, deltaB: db, expectedA: ea, kA: ka, kB: kb, bonus };
}

/**
 * Bütün geçmişi baştan oynatır.
 * @param {Array<{id:number,name:string,created_at:number}>} players
 * @param {Array<{id:number,player_a:number,player_b:number,score_a:?number,score_b:?number,result:string,played_at:number}>} matches
 * @param {Array<{id:number,player_id:number,amount:number,reason:string,created_at:number}>} adjustments
 */
function replay(players, matches, adjustments) {
  const events = [];
  for (const p of players) events.push({ t: p.created_at, order: 0, id: p.id, kind: 'join', p });
  for (const a of adjustments) events.push({ t: a.created_at, order: 1, id: a.id, kind: 'adjust', a });
  for (const m of matches) events.push({ t: m.played_at, order: 2, id: m.id, kind: 'match', m });
  events.sort((x, y) => x.t - y.t || x.order - y.order || x.id - y.id);

  const stats = new Map();
  let sum = 0;
  const outMatches = [];
  const outAdjustments = [];

  for (const ev of events) {
    if (ev.kind === 'join') {
      const p = ev.p;
      stats.set(p.id, {
        id: p.id,
        name: p.name,
        created_at: p.created_at,
        rating: START_RATING,
        peak: START_RATING,
        games: 0,
        wins: 0,
        draws: 0,
        losses: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        form: [],
        history: [{ t: p.created_at, rating: START_RATING }],
      });
      sum += START_RATING;
    } else if (ev.kind === 'adjust') {
      const a = ev.a;
      const s = stats.get(a.player_id);
      if (!s) continue;
      const applied = Math.max(RATING_FLOOR - s.rating, a.amount);
      const before = s.rating;
      s.rating += applied;
      sum += applied;
      s.peak = Math.max(s.peak, s.rating);
      s.history.push({ t: a.created_at, rating: s.rating });
      outAdjustments.push({ ...a, applied, before, after: s.rating, player_name: s.name });
    } else {
      const m = ev.m;
      const A = stats.get(m.player_a);
      const B = stats.get(m.player_b);
      if (!A || !B || A === B) continue;
      const average = sum / stats.size;
      const r = computeMatch(A, B, m.result, average);
      const beforeA = A.rating;
      const beforeB = B.rating;
      A.rating += r.deltaA;
      B.rating += r.deltaB;
      sum += r.deltaA + r.deltaB;
      for (const [s, res, gf, ga] of [
        [A, m.result === 'A' ? 'W' : m.result === 'D' ? 'D' : 'L', m.score_a, m.score_b],
        [B, m.result === 'B' ? 'W' : m.result === 'D' ? 'D' : 'L', m.score_b, m.score_a],
      ]) {
        s.games++;
        if (res === 'W') s.wins++;
        else if (res === 'D') s.draws++;
        else s.losses++;
        if (gf != null && ga != null) { s.goalsFor += gf; s.goalsAgainst += ga; }
        s.form.push(res);
        if (s.form.length > 5) s.form.shift();
        s.peak = Math.max(s.peak, s.rating);
        s.history.push({ t: m.played_at, rating: s.rating });
      }
      outMatches.push({
        id: m.id,
        player_a: m.player_a,
        player_b: m.player_b,
        name_a: A.name,
        name_b: B.name,
        score_a: m.score_a,
        score_b: m.score_b,
        result: m.result,
        played_at: m.played_at,
        before_a: beforeA,
        before_b: beforeB,
        delta_a: r.deltaA,
        delta_b: r.deltaB,
      });
    }
  }

  const list = [...stats.values()].sort(
    (x, y) => y.rating - x.rating || y.wins - x.wins || x.games - y.games || x.id - y.id
  );
  list.forEach((s, i) => {
    s.rank = i + 1;
    s.winRate = s.games ? Math.round((s.wins / s.games) * 1000) / 10 : 0;
  });

  return {
    players: list,
    matches: outMatches.reverse(), // en yeni en üstte
    adjustments: outAdjustments.reverse(),
    average: list.length ? Math.round(sum / list.length) : 0,
  };
}

const api = {
  START_RATING,
  TARGET_AVERAGE,
  RATING_FLOOR,
  kFactor,
  expectedScore,
  balanceBonus,
  computeMatch,
  replay,
};

// Hem Node (sunucu) hem tarayıcı (maç önizlemesi) aynı kodu kullanır.
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.ZirElo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
