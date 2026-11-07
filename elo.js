/**
 * ZIR ZIR puan motoru – chess.com ile aynı mantık (Glicko).
 *
 * Her oyuncunun bir puanı (rating) ve bir "belirsizlik" değeri (RD) vardır:
 *  - Yeni oyuncunun RD'si yüksektir → ilk maçlarda puanı hızlı değişir.
 *  - Oynadıkça RD düşer → puan oturur, maç başına değişim küçülür (~8-10).
 *  - Uzun süre oynamayanın RD'si yeniden yükselir.
 *  - Beklenen sonuç iki puan arasındaki farka göre hesaplanır; çok güçlü
 *    oyuncu çok zayıfı yenerse neredeyse hiç puan kazanmaz, kaybederse çok kaybeder.
 *
 * 2v2 takım maçlarında beklenen sonuç iki takımın puan ortalamalarına göre
 * hesaplanır; her oyuncunun değişimi kendi RD'sine göre ölçeklenir.
 *
 * Puanlar saklanmaz: oyuncu katılımları, maçlar ve manuel düzeltmeler zaman
 * sırasıyla baştan oynatılır. Bir maç düzeltilince/silinince her şey tutarlı kalır.
 */
(function (root) {
  'use strict';

  const START_RATING = 1000;
  const START_RD = 200; // yeni oyuncunun belirsizliği
  const MIN_RD = 50; // en oturmuş hal
  const MAX_RD = 350;
  const RD_GROWTH_PER_DAY = 10; // oynamayınca RD'nin günlük artışı (≈1 yıl ara → neredeyse yeni oyuncu)
  const RATING_FLOOR = 100;
  const DAY = 86400000;
  const Q = Math.LN10 / 400;

  const g = (rd) => 1 / Math.sqrt(1 + (3 * Q * Q * rd * rd) / (Math.PI * Math.PI));
  const expected = (r, rOpp, rdOpp) => 1 / (1 + Math.pow(10, (-g(rdOpp) * (r - rOpp)) / 400));

  /** Maç anındaki RD (oynamadığı süre kadar artmış hali). */
  function currentRd(p, t) {
    const days = p.last != null && t != null ? Math.max(0, (t - p.last) / DAY) : 0;
    return Math.min(MAX_RD, Math.sqrt(p.rd * p.rd + RD_GROWTH_PER_DAY * RD_GROWTH_PER_DAY * days));
  }

  /**
   * Tek oyuncunun Glicko güncellemesi.
   * @param r   oyuncunun puanı      @param rd  oyuncunun RD'si
   * @param rOpp rakip puanı         @param rdOpp rakip RD'si
   * @param s   1 kazandı, 0 kaybetti
   * @param rForE beklenen sonuç için kullanılacak puan (takımda takım ortalaması)
   */
  function step(r, rd, rOpp, rdOpp, s, rForE = r) {
    const gj = g(rdOpp);
    const e = expected(rForE, rOpp, rdOpp);
    const d2inv = Q * Q * gj * gj * e * (1 - e);
    const denom = 1 / (rd * rd) + d2inv;
    let newR = r + (Q / denom) * gj * (s - e);
    newR = Math.max(RATING_FLOOR, newR);
    const newRd = Math.max(MIN_RD, Math.sqrt(1 / denom));
    return { r: newR, rd: newRd, e };
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rms = (xs) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);

  /**
   * Bir maçın sonucunu hesaplar (1v1 veya 2v2).
   * @param {Array<{r:number, rd:number, last:?number}>} teamA
   * @param {Array<{r:number, rd:number, last:?number}>} teamB
   * @param {'A'|'B'} result
   * @param {number} t maç zamanı (ms)
   * @returns {{a: Array<{r,rd,delta}>, b: Array<{r,rd,delta}>}}
   */
  function computeGame(teamA, teamB, result, t) {
    const rdA = teamA.map((p) => currentRd(p, t));
    const rdB = teamB.map((p) => currentRd(p, t));
    const avgA = avg(teamA.map((p) => p.r));
    const avgB = avg(teamB.map((p) => p.r));
    const sA = result === 'A' ? 1 : 0;
    const side = (team, rds, ownAvg, oppAvg, oppRd, s) =>
      team.map((p, i) => {
        const n = step(p.r, rds[i], oppAvg, oppRd, s, ownAvg);
        return { r: n.r, rd: n.rd, delta: Math.round(n.r) - Math.round(p.r) };
      });
    return {
      a: side(teamA, rdA, avgA, avgB, rms(rdB), sA),
      b: side(teamB, rdB, avgB, avgA, rms(rdA), 1 - sA),
    };
  }

  /**
   * Bütün geçmişi baştan oynatır.
   * matches: {id, player_a, player_b, player_a2?, player_b2?, result, played_at}
   */
  function replay(players, matches, adjustments) {
    const events = [];
    for (const p of players) events.push({ t: p.created_at, order: 0, id: p.id, kind: 'join', p });
    for (const a of adjustments) events.push({ t: a.created_at, order: 1, id: a.id, kind: 'adjust', a });
    for (const m of matches) events.push({ t: m.played_at, order: 2, id: m.id, kind: 'match', m });
    events.sort((x, y) => x.t - y.t || x.order - y.order || x.id - y.id);

    const stats = new Map();
    const outMatches = [];
    const outAdjustments = [];
    const setRating = (s, r) => {
      s.r = r;
      s.rating = Math.round(r);
      s.peak = Math.max(s.peak, s.rating);
    };

    for (const ev of events) {
      if (ev.kind === 'join') {
        const p = ev.p;
        stats.set(p.id, {
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          r: START_RATING,
          rd: START_RD,
          last: null,
          rating: START_RATING,
          peak: START_RATING,
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          form: [],
        });
      } else if (ev.kind === 'adjust') {
        const a = ev.a;
        const s = stats.get(a.player_id);
        if (!s) continue;
        const before = s.rating;
        setRating(s, Math.max(RATING_FLOOR, s.r + a.amount));
        outAdjustments.push({ ...a, before, after: s.rating, player_name: s.name });
      } else {
        const m = ev.m;
        const idsA = [m.player_a, m.player_a2].filter((x) => x != null);
        const idsB = [m.player_b, m.player_b2].filter((x) => x != null);
        const all = [...idsA, ...idsB];
        if (new Set(all).size !== all.length || !all.every((id) => stats.has(id))) continue;
        if (m.result !== 'A' && m.result !== 'B') continue; // eski beraberlikler sayılmaz
        const A = idsA.map((id) => stats.get(id));
        const B = idsB.map((id) => stats.get(id));
        const before = [...A, ...B].map((s) => s.rating);
        const res = computeGame(A, B, m.result, m.played_at);

        const apply = (team, out, won) =>
          team.forEach((s, i) => {
            setRating(s, out[i].r);
            s.rd = out[i].rd;
            s.last = m.played_at;
            s.games++;
            if (won) s.wins++;
            else s.losses++;
            s.form.push(won ? 'W' : 'L');
            if (s.form.length > 5) s.form.shift();
          });
        apply(A, res.a, m.result === 'A');
        apply(B, res.b, m.result === 'B');

        outMatches.push({
          id: m.id,
          team: A.length > 1 || B.length > 1,
          result: m.result,
          played_at: m.played_at,
          player_a: m.player_a,
          player_b: m.player_b,
          a: A.map((s, i) => ({ id: s.id, name: s.name, before: before[i], delta: res.a[i].delta })),
          b: B.map((s, i) => ({ id: s.id, name: s.name, before: before[A.length + i], delta: res.b[i].delta })),
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
      average: list.length ? Math.round(list.reduce((a, s) => a + s.r, 0) / list.length) : 0,
    };
  }

  const api = { START_RATING, START_RD, MIN_RD, RATING_FLOOR, g, expected, currentRd, computeGame, replay };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZirElo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
