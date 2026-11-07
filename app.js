(function () {
  'use strict';

  const Elo = window.ZirElo;
  const Store = window.ZirStore;
  const $ = (s, el = document) => el.querySelector(s);

  const S = {
    version: -1,
    players: [], // sıralı (puana göre)
    matches: [], // en yeni en üstte
    byId: new Map(),
    token: null,
    modal: null, // 'match' | 'settings'
    // solo: a vs b · team: [a, a2] vs [b, b2]
    flow: { mode: 'solo', a: null, b: null, teamA: [], teamB: [] },
  };

  // ---------- yardımcılar ----------
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const byName = (a, b) => a.name.localeCompare(b.name, 'tr');
  const tsFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const when = (t) => tsFmt.format(new Date(t));
  const joinNames = (side) => side.map((p) => p.name).join(' & ');
  const joinDeltas = (side) => {
    const ds = side.map((p) => p.delta);
    return ds.every((d) => d === ds[0]) ? signed(ds[0]) : ds.map(signed).join(' / ');
  };

  const LOSS_QUIPS = ['Konsolunda sorun olabilir mi?', 'Biraz daha antrenman lazım.'];

  // ---------- veri ----------
  let loading = null;
  function load(force = false) {
    if (loading) return force ? loading.then(() => load(true)) : loading;
    loading = (async () => {
      try {
        const v = await Store.version();
        if (!force && v === S.version) return;
        const raw = await Store.load();
        const r = Elo.replay(raw.players, raw.matches, raw.adjustments);
        Object.assign(S, { version: v, players: r.players, matches: r.matches });
        S.byId = new Map(r.players.map((p) => [p.id, p]));
        renderTable();
        if (S.modal === 'settings') refreshSettings();
        S.warned = false;
      } catch (e) {
        console.warn(e);
        // Hatayı ekranda bir kez göster (her 4 saniyede tekrarlamasın)
        if (!S.warned) {
          S.warned = true;
          toast({ title: 'Veritabanına bağlanılamadı', lines: [e.message || String(e)], error: true });
        }
      }
    })().finally(() => {
      loading = null;
    });
    return loading;
  }

  async function admin(fn) {
    try {
      return await fn(S.token);
    } catch (e) {
      if (e.auth) setToken(null);
      throw e;
    }
  }

  function setToken(t) {
    S.token = t;
    try {
      if (t) localStorage.setItem('zirzir_admin', t);
      else localStorage.removeItem('zirzir_admin');
    } catch {}
    if (S.modal === 'settings') renderSettings();
  }

  // ---------- ana ekran: sıralama ----------
  function renderTable() {
    $('#empty').hidden = S.players.length > 0;
    $('#leaderboard').hidden = S.players.length === 0;
    $('#leaderboard tbody').innerHTML = S.players
      .map(
        (p, i) => `<tr class="${i < 3 ? `top${i + 1}` : ''}" data-player="${p.id}">
          <td class="c"><span class="rank">${p.rank}</span></td>
          <td><span class="name">${esc(p.name)}</span></td>
          <td class="r"><span class="elo">${p.rating}</span></td>
          <td class="c w">${p.wins}</td>
          <td class="c l">${p.losses}</td>
          <td class="r">${p.games ? Math.round(p.winRate) : '–'}</td>
        </tr>`
      )
      .join('');
  }

  $('#leaderboard').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-player]');
    if (tr) openMatch(Number(tr.dataset.player));
  });

  // ---------- pencere ----------
  const modal = $('#modal');
  function openModal(kind, html) {
    S.modal = kind;
    $('#modal-body').innerHTML = html;
    if (!modal.open) modal.showModal();
  }
  modal.addEventListener('close', () => {
    S.modal = null;
  });
  $('#modal-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  // ---------- maç ekleme ----------
  function openMatch(firstId = null) {
    S.flow = { mode: 'solo', a: firstId, b: null, teamA: [], teamB: [] };
    renderFlow();
  }
  function openTeamMatch() {
    S.flow = { mode: 'team', a: null, b: null, teamA: [], teamB: [] };
    renderFlow();
  }
  $('#open-match').addEventListener('click', () => openMatch());

  const chip = (p, cls = '') =>
    `<button class="chip ${cls}" data-pick="${p.id}"><b>${esc(p.name)}</b><span>${p.rating}</span></button>`;

  function winnerScreen(sideA, sideB) {
    const res = (r) => Elo.computeGame(sideA, sideB, r, Date.now());
    const ra = res('A');
    const rb = res('B');
    const label = (side, out) =>
      `<b>${esc(joinNames(side))}</b><span>${joinDeltas(out)} ELO</span>`;
    openModal(
      'match',
      `<button class="back" data-back>← geri</button>
      <h2>Kim kazandı?</h2>
      <div class="winners">
        <button class="winner" data-win="A">${label(sideA, ra.a)}</button>
        <button class="winner" data-win="B">${label(sideB, rb.b)}</button>
      </div>
      <p class="msg" id="m-match"></p>`
    );
  }

  function renderFlow() {
    const f = S.flow;
    const need = f.mode === 'team' ? 4 : 2;
    if (S.players.length < need) {
      openModal('match', `<h2>Maç Ekle</h2><p class="muted">Bunun için en az ${need} oyuncu lazım. Sağ üstteki ⚙ ayarlardan oyuncu ekleyebilirsin.</p>`);
      return;
    }
    const sorted = [...S.players].sort(byName);

    if (f.mode === 'team') {
      const A = f.teamA.map((id) => S.byId.get(id));
      const B = f.teamB.map((id) => S.byId.get(id));
      if (A.length === 2 && B.length === 2) return winnerScreen(A, B);
      const avg = (t) => (t.length ? Math.round(t.reduce((s, p) => s + p.rating, 0) / t.length) : '–');
      const box = (t, n) =>
        `<div class="team-box ${t.length ? 'filled' : ''}"><span>Takım ${n} · ort. ${avg(t)}</span><b>${t.length ? esc(joinNames(t)) : 'Seç'}</b></div>`;
      openModal(
        'match',
        `<h2>2v2 Takım Maçı</h2>
        <p class="muted small">Önce 1. takımın iki oyuncusunu, sonra 2. takımın iki oyuncusunu seç.</p>
        <div class="teams">${box(A, 1)}${box(B, 2)}</div>
        <div class="chips">${sorted
          .map((p) => chip(p, f.teamA.includes(p.id) ? 'selected' : f.teamB.includes(p.id) ? 'selected t2' : ''))
          .join('')}</div>`
      );
      return;
    }

    const pa = S.byId.get(f.a);
    const pb = S.byId.get(f.b);
    if (pa && pb) return winnerScreen([pa], [pb]);
    openModal(
      'match',
      `<h2>${pa ? `${esc(pa.name)} kimle oynadı?` : 'Kim oynadı?'}</h2>
      ${pa ? '' : '<p class="muted small">İki oyuncuyu seç.</p>'}
      <div class="chips">${sorted.filter((p) => !pa || p.id !== f.a).map((p) => chip(p)).join('')}</div>`
    );
  }

  async function saveMatch(result) {
    const f = S.flow;
    const m =
      f.mode === 'team'
        ? { a: f.teamA[0], a2: f.teamA[1], b: f.teamB[0], b2: f.teamB[1], result }
        : { a: f.a, b: f.b, result };
    const buttons = document.querySelectorAll('[data-win]');
    buttons.forEach((x) => (x.disabled = true));
    try {
      const id = await Store.addMatch(m);
      await load(true);
      modal.close();
      const saved = S.matches.find((x) => x.id === id);
      if (saved) matchToast(saved);
    } catch (err) {
      setMsg('#m-match', err.message);
      buttons.forEach((x) => (x.disabled = false));
    }
  }

  function matchToast(m) {
    const [w, l] = m.result === 'A' ? [m.a, m.b] : [m.b, m.a];
    const lead = S.byId.get(w[0].id);
    const streak = !m.team && lead && lead.form.length >= 3 && lead.form.slice(-3).every((r) => r === 'W');
    toast({
      title: `${joinNames(w)} kazandı!`,
      lines: [`${joinNames(w)} ${joinDeltas(w)} ELO`, `${joinNames(l)} ${joinDeltas(l)} ELO — ${pick(LOSS_QUIPS)}`],
      quip: streak ? 'Bu nasıl bir dominasyon!' : null,
    });
  }

  // ---------- ayarlar ----------
  $('#open-settings').addEventListener('click', () => renderSettings());

  function renderSettings() {
    const isAdmin = !!S.token;
    openModal(
      'settings',
      `<h2>Ayarlar</h2>

      <h3>Oyuncu Ekle</h3>
      <form class="row" id="f-player" autocomplete="off">
        <input type="text" id="new-player" maxlength="20" placeholder="Oyuncu adı" required>
        <button class="btn btn-primary" type="submit">Ekle</button>
      </form>
      <p class="msg" id="m-player"></p>

      <h3>2v2 Takım Maçı</h3>
      <button class="btn btn-ghost" id="open-team">2v2 maç ekle</button>

      <h3>Maç Geçmişi</h3>
      <select id="hist-filter" aria-label="Oyuncuya göre filtrele"></select>
      <ul class="list" id="history"></ul>

      <h3>Yönetici</h3>
      ${
        isAdmin
          ? `<form class="stack" id="f-adjust" autocomplete="off">
              <select id="adj-player" required></select>
              <div class="quick">
                <button type="button" class="neg" data-amt="-100">−100</button>
                <button type="button" class="neg" data-amt="-50">−50</button>
                <button type="button" class="pos" data-amt="50">+50</button>
                <button type="button" class="pos" data-amt="100">+100</button>
              </div>
              <div class="row">
                <input type="number" id="adj-amount" step="1" placeholder="ELO (ör. 50 / -100)" required>
                <input type="text" id="adj-reason" maxlength="120" placeholder="Sebep (isteğe bağlı)">
              </div>
              <button class="btn btn-primary" type="submit">ELO Uygula</button>
              <p class="msg" id="m-adjust"></p>
            </form>
            <h3>Oyuncular</h3>
            <ul class="list" id="admin-players"></ul>
            <h3>Yönetici Kayıtları</h3>
            <ul class="list" id="admin-log"></ul>
            <p><button class="btn btn-ghost btn-sm" id="logout">Yönetici çıkışı</button></p>`
          : `<form class="row" id="f-login" autocomplete="off">
              <input type="password" id="admin-code" placeholder="Yönetici kodu" autocapitalize="off" autocorrect="off" spellcheck="false" required>
              <button class="btn btn-primary" type="submit">Giriş</button>
            </form>
            <p class="msg" id="m-login"></p>`
      }`
    );
    refreshSettings();
    if (isAdmin) loadLog();
  }

  /** Ayarlar açıkken listeleri günceller (yazılan alanlara dokunmaz). */
  function refreshSettings() {
    const sorted = [...S.players].sort(byName);
    const opts = (cur, ph) =>
      `<option value="">${ph}</option>` +
      sorted.map((p) => `<option value="${p.id}" ${p.id === cur ? 'selected' : ''}>${esc(p.name)} (${p.rating})</option>`).join('');

    const f = $('#hist-filter');
    if (f) {
      const cur = Number(f.value) || null;
      f.innerHTML = opts(cur, 'Bütün maçlar');
      const list = cur ? S.matches.filter((m) => [...m.a, ...m.b].some((p) => p.id === cur)) : S.matches;
      $('#history').innerHTML = list.length
        ? list
            .slice(0, 200)
            .map((m) => {
              const [w, l] = m.result === 'A' ? [m.a, m.b] : [m.b, m.a];
              const text = `${m.team ? '<span class="tag">2v2</span> ' : ''}<b>${esc(joinNames(w))}</b> <span class="d-up">${joinDeltas(w)}</span> · ${esc(joinNames(l))} <span class="d-down">${joinDeltas(l)}</span>`;
              const actions = S.token
                ? `<span class="actions"><button class="btn btn-ghost btn-sm" data-flip="${m.id}" title="Kazananı değiştir">⇄</button><button class="btn btn-danger btn-sm" data-del-match="${m.id}" title="Maçı iptal et, puanlar geri alınsın">İptal Et</button></span>`
                : '';
              return `<li><span class="grow">${text}</span><span class="when">${when(m.played_at)}</span>${actions}</li>`;
            })
            .join('')
        : '<li class="empty">Henüz maç yok.</li>';
    }

    const adj = $('#adj-player');
    if (adj) adj.innerHTML = opts(Number(adj.value) || null, 'Oyuncu seç');

    const ap = $('#admin-players');
    if (ap) {
      ap.innerHTML = S.players.length
        ? S.players
            .map(
              (p) => `<li><span class="grow"><b>${esc(p.name)}</b> <span class="muted">${p.rating}</span></span>
                <span class="actions"><button class="btn btn-ghost btn-sm" data-rename="${p.id}">Ad</button>
                <button class="btn btn-danger btn-sm" data-del-player="${p.id}">Sil</button></span></li>`
            )
            .join('')
        : '<li class="empty">Henüz oyuncu yok.</li>';
    }
  }

  const ACTION_TEXT = {
    admin_login: () => 'Yönetici girişi',
    player_add: (d) => `Oyuncu eklendi: ${d.name}`,
    player_rename: (d) => `Ad değişti: ${d.from} → ${d.to}`,
    player_delete: (d) => `Oyuncu silindi: ${d.name} (${d.rating ?? '?'} ELO, ${d.matchesRemoved} maç)`,
    elo_adjust: (d) =>
      `Manuel ELO: ${d.name} ${signed(d.amount)}${d.before != null ? ` (${d.before} → ${d.before + d.amount})` : ''}${d.reason ? ` · “${d.reason}”` : ''}`,
    match_flip: (d) => `Kazanan değişti: ${d.teamA} – ${d.teamB} → ${d.newWinner === 'A' ? d.teamA : d.teamB}`,
    match_delete: (d) => `Maç iptal edildi: ${d.teamA ?? '?'} – ${d.teamB ?? '?'}`,
  };

  async function loadLog() {
    try {
      const rows = await admin((t) => Store.log(t));
      const el = $('#admin-log');
      if (!el) return;
      el.innerHTML = rows.length
        ? rows
            .map(
              (r) =>
                `<li><span class="grow">${esc((ACTION_TEXT[r.action] || (() => r.action))(r.details || {}))}</span><span class="when">${when(r.created_at)}</span></li>`
            )
            .join('')
        : '<li class="empty">Kayıt yok.</li>';
    } catch (e) {
      console.warn(e);
    }
  }

  function setMsg(id, text, ok = false) {
    const el = $(id);
    if (!el) return;
    el.className = `msg ${ok ? 'ok' : 'err'}`;
    el.textContent = text;
  }

  // ---------- oyuncu seçimi ----------
  function pickPlayer(id) {
    const f = S.flow;
    if (f.mode === 'team') {
      if (f.teamA.includes(id)) f.teamA = f.teamA.filter((x) => x !== id);
      else if (f.teamB.includes(id)) f.teamB = f.teamB.filter((x) => x !== id);
      else if (f.teamA.length < 2) f.teamA.push(id);
      else if (f.teamB.length < 2) f.teamB.push(id);
      return renderFlow();
    }
    if (f.a == null) {
      f.a = id; // ilk oyuncu seçildi, ikinciyi bekle
      return renderFlow();
    }
    if (f.a === id) {
      f.a = null;
      return renderFlow();
    }
    f.b = id;
    renderFlow();
  }

  // ---------- pencere içi tıklamalar ----------
  modal.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.dataset.pick) return pickPlayer(Number(t.dataset.pick));
    if (t.hasAttribute('data-back')) {
      if (S.flow.mode === 'team') S.flow.teamB = S.flow.teamB.slice(0, 1);
      else S.flow.b = null;
      return renderFlow();
    }
    if (t.dataset.win) return saveMatch(t.dataset.win);
    if (t.id === 'open-team') return openTeamMatch();
    if (t.dataset.amt) {
      $('#adj-amount').value = t.dataset.amt;
      return;
    }
    if (t.id === 'logout') {
      try {
        await Store.logout(S.token);
      } catch {}
      return setToken(null);
    }

    try {
      if (t.dataset.flip) {
        const m = S.matches.find((x) => x.id === Number(t.dataset.flip));
        if (!m) return;
        const other = joinNames(m.result === 'A' ? m.b : m.a);
        if (!confirm(`Bu maçın kazananı ${other} olarak değiştirilsin mi?`)) return;
        await admin((tk) => Store.flipMatch(tk, m.id));
      } else if (t.dataset.delMatch) {
        const m = S.matches.find((x) => x.id === Number(t.dataset.delMatch));
        if (!m) return;
        const who = [...m.a, ...m.b].map((p) => p.id);
        if (
          !confirm(
            `${joinNames(m.a)} – ${joinNames(m.b)} maçı iptal edilsin mi?\n\nMaç geçmişten silinir ve bu maçtan kazanılan/kaybedilen puanlar geri alınır.`
          )
        )
          return;
        const before = new Map(who.map((id) => [id, S.byId.get(id)?.rating]));
        await admin((tk) => Store.deleteMatch(tk, m.id));
        await load(true);
        const lines = who
          .map((id) => {
            const p = S.byId.get(id);
            const old = before.get(id);
            return p && old != null ? `${p.name}: ${old} → ${p.rating} (${signed(p.rating - old)})` : null;
          })
          .filter(Boolean);
        toast({ title: 'Maç iptal edildi', lines: ['Puanlar geri alındı.', ...lines] });
      } else if (t.dataset.rename) {
        const p = S.byId.get(Number(t.dataset.rename));
        const name = p && prompt('Yeni ad:', p.name);
        if (!name) return;
        await admin((tk) => Store.renamePlayer(tk, p.id, name));
      } else if (t.dataset.delPlayer) {
        const p = S.byId.get(Number(t.dataset.delPlayer));
        if (!p || !confirm(`${p.name} silinsin mi?\nOyuncunun ${p.games} maçı da silinir. Geri alınamaz.`)) return;
        await admin((tk) => Store.deletePlayer(tk, p.id, p.rating));
      } else return;
      await load(true);
      loadLog();
    } catch (err) {
      toast({ title: 'İşlem yapılamadı', lines: [err.message], error: true });
    }
  });

  modal.addEventListener('change', (e) => {
    if (e.target.id === 'hist-filter') refreshSettings();
  });

  // ---------- pencere içi formlar ----------
  modal.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const msgId = { 'f-player': '#m-player', 'f-login': '#m-login', 'f-adjust': '#m-adjust' }[f.id];
    try {
      if (f.id === 'f-player') {
        const name = $('#new-player').value;
        await Store.addPlayer(name);
        $('#new-player').value = '';
        setMsg(msgId, `${name.trim()} lige katıldı. ${Elo.START_RATING} ELO ile başlıyor.`, true);
        await load(true);
        if (S.token) loadLog();
      } else if (f.id === 'f-login') {
        setToken(await Store.login($('#admin-code').value));
      } else if (f.id === 'f-adjust') {
        const playerId = Number($('#adj-player').value);
        const amount = Number($('#adj-amount').value);
        const p = S.byId.get(playerId);
        if (!p) throw new Error('Oyuncu seç.');
        if (!Number.isInteger(amount) || amount === 0) throw new Error('Geçerli bir miktar gir (ör. 50 veya -100).');
        await admin((t) => Store.adjust(t, playerId, amount, $('#adj-reason').value, p.rating));
        $('#adj-amount').value = '';
        $('#adj-reason').value = '';
        await load(true);
        setMsg(msgId, `${p.name}: ${signed(amount)} ELO → ${S.byId.get(playerId)?.rating ?? '?'}`, true);
        loadLog();
      }
    } catch (err) {
      setMsg(msgId, err.message);
    }
  });

  // ---------- bildirim ----------
  function toast({ title, lines = [], quip = null, error = false }) {
    const el = document.createElement('div');
    el.className = `toast${error ? ' err' : ''}`;
    el.innerHTML =
      `<div class="toast-title">${esc(title)}</div>` +
      lines.map((l) => `<div class="toast-line">${esc(l)}</div>`).join('') +
      (quip ? `<div class="toast-quip">${esc(quip)}</div>` : '');
    $('#toasts').appendChild(el);
    const close = () => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 300);
    };
    el.addEventListener('click', close);
    setTimeout(close, 5000);
  }

  // ---------- başlangıç ----------
  let saved = null;
  try {
    saved = localStorage.getItem('zirzir_admin');
  } catch {}
  if (saved) {
    S.token = saved;
    Store.check(saved).catch(() => setToken(null));
  }
  load();
  Store.subscribe(() => load());
  setInterval(() => {
    if (!document.hidden) load();
  }, Store.mode === 'remote' ? 4000 : 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
})();
