(function () {
  'use strict';

  const Elo = window.ZirElo;
  const Store = window.ZirStore;
  const $ = (s, el = document) => el.querySelector(s);

  const S = {
    version: -1,
    players: [], // sıralı (ELO'ya göre)
    matches: [], // en yeni en üstte
    average: 0,
    byId: new Map(),
    token: null,
    modal: null, // 'match' | 'settings'
    flow: { a: null, b: null },
  };

  // ---------- yardımcılar ----------
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const byName = (a, b) => a.name.localeCompare(b.name, 'tr');
  const tsFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const when = (t) => tsFmt.format(new Date(t));

  // ---------- ZIR ZIR mizahı (dozunda) ----------
  const LOSS_QUIPS = ['Konsolunda sorun olabilir mi?', 'Biraz daha antrenman lazım.'];
  function playerQuip(p) {
    if (p.rating >= 1900) return { text: 'Bu lig sana dar geliyor.', good: true };
    if (S.players.length >= 3 && p.games > 0 && p.rank === S.players.length) return { text: 'Küme düşme hattı seni bekliyor.' };
    if (p.games > 0 && (p.rating < 950 || p.rating < S.average - 250)) return { text: 'ZIR ZIR AĞLAMA' };
    return null;
  }

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
        Object.assign(S, { version: v, players: r.players, matches: r.matches, average: r.average });
        S.byId = new Map(r.players.map((p) => [p.id, p]));
        renderTable();
        if (S.modal === 'settings') refreshSettings();
      } catch (e) {
        console.warn(e);
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
      .map((p, i) => {
        const q = playerQuip(p);
        return `<tr class="${i < 3 ? `top${i + 1}` : ''}" data-player="${p.id}">
          <td class="c"><span class="rank">${p.rank}</span></td>
          <td><span class="name">${esc(p.name)}</span>${q ? `<span class="quip ${q.good ? 'good' : ''}">${esc(q.text)}</span>` : ''}</td>
          <td class="r"><span class="elo">${p.rating}</span></td>
          <td class="c w">${p.wins}</td>
          <td class="c l">${p.losses}</td>
          <td class="r">${p.games ? Math.round(p.winRate) : '–'}</td>
        </tr>`;
      })
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

  // ---------- maç ekleme: iki oyuncu → kazanan ----------
  function openMatch(firstId = null) {
    S.flow = { a: firstId, b: null };
    renderFlow();
  }
  $('#open-match').addEventListener('click', () => openMatch());

  function renderFlow() {
    const { a, b } = S.flow;
    const pa = S.byId.get(a);
    const pb = S.byId.get(b);

    if (S.players.length < 2) {
      openModal('match', `<h2>Maç Ekle</h2><p class="muted">Maç eklemek için en az 2 oyuncu lazım. Sağ üstteki ⚙ ayarlardan oyuncu ekleyebilirsin.</p>`);
      return;
    }

    if (pa && pb) {
      const ra = Elo.computeMatch(pa, pb, 'A', S.average);
      const rb = Elo.computeMatch(pa, pb, 'B', S.average);
      openModal(
        'match',
        `<button class="back" data-back>← geri</button>
        <h2>Kim kazandı?</h2>
        <div class="winners">
          <button class="winner" data-win="A"><b>${esc(pa.name)}</b><span>${signed(ra.deltaA)} ELO</span></button>
          <button class="winner" data-win="B"><b>${esc(pb.name)}</b><span>${signed(rb.deltaB)} ELO</span></button>
        </div>
        <p class="msg" id="m-match"></p>`
      );
      return;
    }

    const list = [...S.players].sort(byName).filter((p) => !pa || p.id !== a);
    openModal(
      'match',
      `<h2>${pa ? `${esc(pa.name)} kimle oynadı?` : 'Kim oynadı?'}</h2>
      ${pa ? '' : '<p class="muted small">İki oyuncuyu seç.</p>'}
      <div class="chips">${list
        .map((p) => `<button class="chip" data-pick="${p.id}"><b>${esc(p.name)}</b><span>${p.rating}</span></button>`)
        .join('')}</div>`
    );
  }

  async function saveMatch(result) {
    const { a, b } = S.flow;
    const buttons = document.querySelectorAll('[data-win]');
    buttons.forEach((x) => (x.disabled = true));
    try {
      const id = await Store.addMatch({ playerA: a, playerB: b, result, scoreA: null, scoreB: null });
      await load(true);
      modal.close();
      const m = S.matches.find((x) => x.id === id);
      if (m) matchToast(m);
    } catch (err) {
      setMsg('#m-match', err.message);
      buttons.forEach((x) => (x.disabled = false));
    }
  }

  function matchToast(m) {
    const aWon = m.result === 'A';
    const winner = aWon ? m.name_a : m.name_b;
    const loser = aWon ? m.name_b : m.name_a;
    const dw = aWon ? m.delta_a : m.delta_b;
    const dl = aWon ? m.delta_b : m.delta_a;
    const after = (aWon ? m.before_a : m.before_b) + dw;
    const w = S.byId.get(aWon ? m.player_a : m.player_b);
    const streak = w && w.form.length >= 3 && w.form.slice(-3).every((r) => r === 'W'); // üst üste 3 galibiyet
    toast({
      title: `${winner} kazandı!`,
      lines: [`${winner} ${signed(dw)} ELO`, `${loser} ${signed(dl)} ELO — ${pick(LOSS_QUIPS)}`],
      quip: after >= 1900 ? 'Bu lig sana dar geliyor.' : streak ? 'Bu nasıl bir dominasyon!' : null,
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
      const list = cur ? S.matches.filter((m) => m.player_a === cur || m.player_b === cur) : S.matches;
      $('#history').innerHTML = list.length
        ? list
            .slice(0, 200)
            .map((m) => {
              let text;
              if (m.result === 'D') {
                text = `${esc(m.name_a)} – ${esc(m.name_b)} <span class="muted">berabere</span>`;
              } else {
                const [w, l, dw, dl] =
                  m.result === 'A' ? [m.name_a, m.name_b, m.delta_a, m.delta_b] : [m.name_b, m.name_a, m.delta_b, m.delta_a];
                text = `<b>${esc(w)}</b> <span class="d-up">${signed(dw)}</span> · ${esc(l)} <span class="d-down">${signed(dl)}</span>`;
              }
              const actions = S.token
                ? `<span class="actions"><button class="btn btn-ghost btn-sm" data-flip="${m.id}" title="Kazananı değiştir">⇄</button><button class="btn btn-danger btn-sm" data-del-match="${m.id}">Sil</button></span>`
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
    match_edit: (d) => `Maç #${d.matchId} düzeltildi`,
    match_delete: (d) => `Maç silindi${d.match ? `: ${d.match.name_a} – ${d.match.name_b}` : ''}`,
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

  // ---------- pencere içi tıklamalar ----------
  modal.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;

    if (t.dataset.pick) {
      const id = Number(t.dataset.pick);
      if (S.flow.a == null) {
        S.flow.a = id; // ilk oyuncu seçildi, ikinciyi bekle
        t.classList.add('selected');
        return;
      }
      if (S.flow.a === id) {
        S.flow.a = null; // seçimi geri al
        t.classList.remove('selected');
        return;
      }
      S.flow.b = id;
      return renderFlow();
    }
    if (t.hasAttribute('data-back')) {
      S.flow.b = null;
      return renderFlow();
    }
    if (t.dataset.win) return saveMatch(t.dataset.win);
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
        if (!m || m.result === 'D') return;
        const other = m.result === 'A' ? m.name_b : m.name_a;
        if (!confirm(`Bu maçın kazananı ${other} olarak değiştirilsin mi?`)) return;
        await admin((tk) =>
          Store.editMatch(tk, m.id, {
            playerA: m.player_a,
            playerB: m.player_b,
            result: m.result === 'A' ? 'B' : 'A',
            scoreA: null,
            scoreB: null,
          })
        );
      } else if (t.dataset.delMatch) {
        const m = S.matches.find((x) => x.id === Number(t.dataset.delMatch));
        if (!m || !confirm(`${m.name_a} – ${m.name_b} maçı silinsin mi? Puanlar yeniden hesaplanır.`)) return;
        await admin((tk) => Store.deleteMatch(tk, m.id));
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
        setMsg(msgId, `${name.trim()} lige katıldı. 1000 ELO ile başlıyor.`, true);
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
