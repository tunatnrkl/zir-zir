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
 * v2 kuralları (V2_FROM'dan sonraki maçlar; önceki puanlar aynen korunur):
 *  - Ölçek 2,5 kat geniş: oturmuş eşit maçta ≈ ±25, iyi oyuncu çok daha yükseğe çıkar.
 *  - Sıralamadaki oyuncuların ortalaması 1600'ün altındayken kazanana lig bonusu
 *    (açığın her 25 puanına +1, en fazla +15); ortalama 1600'e yaklaştıkça biter.
 *  - 2400'den sonra kazanılan puan azalır, 3000'de %30'a iner: zirvede tutunmak zor.
 *
 * Puanlar saklanmaz: oyuncu katılımları, maçlar ve manuel düzeltmeler zaman
 * sırasıyla baştan oynatılır. Bir maç düzeltilince/silinince her şey tutarlı kalır.
 */
(function (root) {
  'use strict';

  const START_RATING = 1000;
  const RATING_FLOOR = 100;
  const DAY = 86400000;

  /*
   * Kural sürümleri. Bu tarihten önceki maçlar v1 ile, sonrakiler v2 ile
   * hesaplanır; böylece geçiş anındaki puanlar olduğu gibi korunur.
   * (2026-11-24 20:09 UTC)
   */
  const V2_FROM = 1795550940000;

  // v1: klasik Glicko ölçeği (oturmuş eşit maç ≈ ±10).
  const V1 = { scale: 400, startRd: 200, minRd: 50, maxRd: 350, growth: 10 };
  // v2: aynı Glicko, 2,5 kat geniş ölçek (oturmuş eşit maç ≈ ±25, puanlar daha açılır).
  const V2 = { scale: 1000, startRd: 500, minRd: 150, maxRd: 875, growth: 25 };

  // v2 lig ayarları
  const TARGET_AVERAGE = 1600; // ortalama bu değerin altındayken kazanana bonus
  const BONUS_PER = 25; // açığın her 25 puanı için +1 bonus
  const BONUS_MAX = 15;
  const TAPER_FROM = 2400; // bu puandan sonra kazanılan puan azalır…
  const TAPER_TO = 3000; // …burada en düşük orana iner
  const TAPER_MIN = 0.3;

  const rulesAt = (t) => (t != null && t >= V2_FROM ? V2 : V1);

  const qOf = (P) => Math.LN10 / P.scale;
  const gOf = (P, rd) => {
    const q = qOf(P);
    return 1 / Math.sqrt(1 + (3 * q * q * rd * rd) / (Math.PI * Math.PI));
  };
  const expectedOf = (P, r, rOpp, rdOpp) => 1 / (1 + Math.pow(10, (-gOf(P, rdOpp) * (r - rOpp)) / P.scale));

  // Geriye dönük uyumluluk (testler ve önizleme v1 ölçeğini kullanabilir)
  const g = (rd) => gOf(V1, rd);
  const expected = (r, rOpp, rdOpp) => expectedOf(V1, r, rOpp, rdOpp);

  /** Maç anındaki RD (oynamadığı süre kadar artmış hali). */
  function currentRd(p, t) {
    const P = rulesAt(t);
    const days = p.last != null && t != null ? Math.max(0, (t - p.last) / DAY) : 0;
    return Math.min(P.maxRd, Math.sqrt(p.rd * p.rd + P.growth * P.growth * days));
  }

  /** Tek oyuncunun Glicko güncellemesi (rForE: takımda takım ortalaması). */
  function step(P, r, rd, rOpp, rdOpp, s, rForE = r) {
    const q = qOf(P);
    const gj = gOf(P, rdOpp);
    const e = expectedOf(P, rForE, rOpp, rdOpp);
    const denom = 1 / (rd * rd) + q * q * gj * gj * e * (1 - e);
    return { change: (q / denom) * gj * (s - e), rd: Math.max(P.minRd, Math.sqrt(1 / denom)) };
  }

  /** v2: ortalama hedefin altındaysa kazanana verilen lig bonusu. */
  const leagueBonus = (average) =>
    average == null ? 0 : Math.max(0, Math.min(BONUS_MAX, (TARGET_AVERAGE - average) / BONUS_PER));

  /** v2: yüksek puanda kazanılan puanı azaltan çarpan (2400 → 1, 3000+ → 0,3). */
  function taper(r) {
    if (r <= TAPER_FROM) return 1;
    const k = Math.min(1, (r - TAPER_FROM) / (TAPER_TO - TAPER_FROM));
    return 1 - k * (1 - TAPER_MIN);
  }

  const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const rms = (xs) => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);

  /**
   * Bir maçın sonucunu hesaplar (1v1 veya 2v2).
   * @param {Array<{r:number, rd:number, last:?number}>} teamA
   * @param {Array<{r:number, rd:number, last:?number}>} teamB
   * @param {'A'|'B'} result
   * @param {number} t maç zamanı (ms) – hangi kuralların geçerli olduğunu belirler
   * @param {number} [average] maç anında sıralamadaki oyuncuların ortalaması (v2 bonusu için)
   * @returns {{a: Array<{r,rd,delta}>, b: Array<{r,rd,delta}>}}
   */
  function computeGame(teamA, teamB, result, t, average) {
    const P = rulesAt(t);
    const v2 = P === V2;
    const rdA = teamA.map((p) => currentRd(p, t));
    const rdB = teamB.map((p) => currentRd(p, t));
    const avgA = avg(teamA.map((p) => p.r));
    const avgB = avg(teamB.map((p) => p.r));
    const sA = result === 'A' ? 1 : 0;
    const bonus = v2 ? leagueBonus(average) : 0;
    const side = (team, rds, ownAvg, oppAvg, oppRd, s) =>
      team.map((p, i) => {
        const n = step(P, p.r, rds[i], oppAvg, oppRd, s, ownAvg);
        let change = n.change;
        if (v2 && s === 1) change = (change + bonus) * taper(p.r); // kazanç: bonus + yüksekte zorlaşma
        const r = Math.max(RATING_FLOOR, p.r + change);
        return { r, rd: n.rd, delta: Math.round(r) - Math.round(p.r) };
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

    // v2'ye geçişte mevcut belirsizlikler yeni ölçeğe taşınır (puanlar aynen kalır).
    let converted = false;
    const rankedAverage = () => {
      const played = [...stats.values()].filter((s) => s.games > 0);
      return played.length ? played.reduce((a, s) => a + s.r, 0) / played.length : null;
    };

    for (const ev of events) {
      if (!converted && ev.t >= V2_FROM) {
        converted = true;
        for (const s of stats.values()) s.rd = Math.min(V2.maxRd, s.rd * (V2.scale / V1.scale));
      }
      if (ev.kind === 'join') {
        const p = ev.p;
        stats.set(p.id, {
          id: p.id,
          name: p.name,
          created_at: p.created_at,
          r: START_RATING,
          rd: rulesAt(p.created_at).startRd,
          last: null,
          rating: START_RATING,
          peak: START_RATING,
          games: 0,
          wins: 0,
          losses: 0,
          draws: 0,
          form: [],
          streak: 0, // şu anki üst üste galibiyet sayısı
          bestStreak: 0, // en uzun galibiyet serisi
          lastDelta: null, // son maçtaki puan değişimi
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
        const res = computeGame(A, B, m.result, m.played_at, rankedAverage());

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
            s.streak = won ? s.streak + 1 : 0;
            s.bestStreak = Math.max(s.bestStreak, s.streak);
            s.lastDelta = out[i].delta;
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

    // Maç yapanlar puana göre sıralanır; hiç maç yapmayanlar sıralamaya girmez,
    // listenin sonunda isim sırasıyla durur (rank = null).
    const all = [...stats.values()];
    const ranked = all
      .filter((s) => s.games > 0)
      .sort((x, y) => y.rating - x.rating || y.wins - x.wins || x.games - y.games || x.id - y.id);
    const unranked = all.filter((s) => s.games === 0).sort((x, y) => x.name.localeCompare(y.name, 'tr') || x.id - y.id);
    ranked.forEach((s, i) => (s.rank = i + 1));
    unranked.forEach((s) => (s.rank = null));
    const list = [...ranked, ...unranked];
    list.forEach((s) => {
      s.winRate = s.games ? Math.round((s.wins / s.games) * 1000) / 10 : 0;
    });

    return {
      players: list,
      matches: outMatches.reverse(), // en yeni en üstte
      adjustments: outAdjustments.reverse(),
      average: list.length ? Math.round(list.reduce((a, s) => a + s.r, 0) / list.length) : 0,
    };
  }

  const api = {
    START_RATING, RATING_FLOOR, TARGET_AVERAGE, V2_FROM, V1, V2,
    g, expected, currentRd, leagueBonus, taper, computeGame, replay,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ZirElo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
