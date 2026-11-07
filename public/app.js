(function () {
  'use strict';

  const Elo = window.ZirElo;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  const S = {
    state: { version: 0, players: [], matches: [], average: 0, target: 1600, start: 1000 },
    byId: new Map(),
    token: null,
    isAdmin: false,
    view: 'siralama',
    result: null,
    matchLimit: 30,
    freshMatchId: null,
  };

  // ---------- yardımcılar ----------
  const esc = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const upper = (s) => String(s).toLocaleUpperCase('tr-TR');
  const initials = (name) =>
    upper(
      String(name)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => [...w][0])
        .join('')
    );
  const signed = (n) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : '±0');
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  const tsFmt = new Intl.DateTimeFormat('tr-TR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const timeFmt = new Intl.DateTimeFormat('tr-TR', { hour: '2-digit', minute: '2-digit' });
  function ago(t) {
    const diff = Date.now() - t;
    if (diff < 60e3) return 'az önce';
    if (diff < 3600e3) return `${Math.floor(diff / 60e3)} dk önce`;
    const d = new Date(t);
    const today = new Date();
    if (d.toDateString() === today.toDateString()) return `bugün ${timeFmt.format(d)}`;
    const y = new Date(today);
    y.setDate(today.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return `dün ${timeFmt.format(d)}`;
    return tsFmt.format(d);
  }

  function tier(rating) {
    if (rating >= 1800) return { cls: 'elite', name: 'ZIR Elit' };
    if (rating >= 1500) return { cls: 'gold', name: 'Altın' };
    if (rating >= 1200) return { cls: 'silver', name: 'Gümüş' };
    return { cls: 'bronze', name: 'Bronz' };
  }

  // ---------- ZIR ZIR mizahı (dozunda) ----------
  const LOSS_QUIPS = ['Konsolunda sorun olabilir mi?', 'Biraz daha antrenman lazım.'];
  function playerQuip(p) {
    const ps = S.state.players;
    if (p.rating >= 1900) return 'Bu lig sana dar geliyor.';
    if (ps.length >= 3 && p.games > 0 && p.rank === ps.length) return 'Küme düşme hattı seni bekliyor.';
    if (p.games > 0 && (p.rating < 950 || p.rating < S.state.average - 250)) return 'ZIR ZIR AĞLAMA';
    return null;
  }
  const isDomination = (m) => m.score_a != null && m.score_b != null && Math.abs(m.score_a - m.score_b) >= 3;

  // ---------- API ----------
  async function api(path, { method = 'GET', body, auth = false } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (auth && S.token) headers.Authorization = `Bearer ${S.token}`;
    const res = await fetch(path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = {};
    try {
      data = await res.json();
    } catch {}
    if (res.status === 401 && auth) setAdmin(null);
    if (!res.ok) throw new Error(data.error || 'Bir şeyler ters gitti.');
    return data;
  }

  async function loadState() {
    try {
      const st = await api('/api/state');
      if (st.version === S.state.version && S.byId.size) return;
      S.state = st;
      S.byId = new Map(st.players.map((p) => [p.id, p]));
      render();
    } catch (e) {
      console.warn(e);
    }
  }

  // ---------- canlı güncelleme (SSE + yedek yoklama) ----------
  function connectLive() {
    const live = $('#live');
    const text = $('#live-text');
    const setLive = (on) => {
      live.classList.toggle('off', !on);
      text.textContent = on ? 'CANLI' : 'BAĞLANIYOR';
    };
    if (!('EventSource' in window)) {
      setLive(false);
      return;
    }
    const es = new EventSource('/api/events');
    es.addEventListener('update', (ev) => {
      setLive(true);
      if (Number(ev.data) !== S.state.version) loadState();
    });
    es.onopen = () => setLive(true);
    es.onerror = () => setLive(false);
  }
  setInterval(loadState, 30000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadState();
  });

  // ---------- render ----------
  function render() {
    renderKpis();
    renderPodium();
    renderTable();
    renderRecent();
    renderMatchForm();
    renderAllMatches();
    renderAdmin();
    $('#foot-target').textContent = S.state.target;
  }

  function renderKpis() {
    const ps = S.state.players;
    let record = null;
    for (const p of ps) if (!record || p.peak > record.peak) record = p;
    const total = S.state.matches.length;
    $('#kpis').innerHTML = `
      <div class="kpi"><div class="kpi-label">Rekor ELO</div><div class="kpi-value neon">${record ? record.peak : '–'}</div><div class="kpi-sub">${record ? esc(record.name) : 'henüz yok'}</div></div>
      <div class="kpi"><div class="kpi-label">Ortalama</div><div class="kpi-value">${ps.length ? S.state.average : '–'}</div><div class="kpi-sub">hedef ~${S.state.target}</div></div>
      <div class="kpi"><div class="kpi-label">Oynanan Maç</div><div class="kpi-value">${total}</div><div class="kpi-sub">${ps.length} oyuncu</div></div>`;
  }

  function futCard(p, extraClass = '') {
    if (!p) {
      return `<div class="fut empty-card ${extraClass}"><div class="fut-top"><div><div class="fut-rating">–</div></div></div><div class="fut-avatar">?</div><div class="fut-name">Boş</div></div>`;
    }
    const t = tier(p.rating);
    const quip = playerQuip(p);
    return `
      <div class="fut ${t.cls} ${extraClass}" data-player="${p.id}" role="button" tabindex="0" aria-label="${esc(p.name)} profili">
        <div class="fut-top">
          <div><div class="fut-rating">${p.rating}</div><div class="fut-rank">#${p.rank}</div></div>
          <div class="fut-tier">${t.name}<br>ELO</div>
        </div>
        <div class="fut-avatar">${esc(initials(p.name))}</div>
        <div class="fut-name">${esc(p.name)}</div>
        <div class="fut-stats">
          <div><b>${p.wins}</b><span>GAL</span></div>
          <div><b>${p.draws}</b><span>BER</span></div>
          <div><b>${p.losses}</b><span>MAĞ</span></div>
          <div><b>${p.games ? Math.round(p.winRate) : '–'}</b><span>%</span></div>
        </div>
        ${quip ? `<div class="fut-quip">${esc(quip)}</div>` : ''}
      </div>`;
  }

  function renderPodium() {
    const ps = S.state.players;
    const el = $('#podium');
    if (!ps.length) {
      el.innerHTML = '';
      return;
    }
    el.innerHTML = [0, 1, 2]
      .map((i) => `<div class="podium-slot p${i + 1}">${futCard(ps[i])}<div class="podium-base">${i + 1}</div></div>`)
      .join('');
  }

  function formHtml(form) {
    const map = { W: 'G', D: 'B', L: 'M' };
    return `<span class="form">${form.map((r) => `<i class="${r}">${map[r]}</i>`).join('')}</span>`;
  }

  function renderTable() {
    const ps = S.state.players;
    $('#empty-players').hidden = ps.length > 0;
    $('#table-note').textContent = ps.length ? `${ps.length} oyuncu` : '';
    $('#leaderboard tbody').innerHTML = ps
      .map((p, i) => {
        const quip = playerQuip(p);
        const last = ps.length >= 3 && p.games > 0 && p.rank === ps.length;
        const cls = [i < 3 ? `top${i + 1}` : '', last ? 'relegation' : ''].join(' ');
        let tag = '';
        if (quip === 'Bu lig sana dar geliyor.') tag = '<span class="tag tag-neon">Lig dar</span>';
        else if (last) tag = '<span class="tag tag-red">Küme hattı</span>';
        else if (quip) tag = '<span class="tag tag-red">Zır zır</span>';
        return `
        <tr class="${cls}" data-player="${p.id}" style="animation-delay:${Math.min(i, 12) * 25}ms">
          <td class="c"><span class="rank-num">${p.rank}</span></td>
          <td><div class="pname"><span class="mini-av">${esc(initials(p.name))}</span><span class="pname-text">${esc(p.name)}</span>${tag}</div></td>
          <td class="r"><span class="elo">${p.rating}</span></td>
          <td class="c hide-sm">${p.games}</td>
          <td class="c w">${p.wins}</td>
          <td class="c d">${p.draws}</td>
          <td class="c l">${p.losses}</td>
          <td class="r">${p.games ? p.winRate : '–'}</td>
          <td class="r hide-sm">${p.peak}</td>
          <td class="c hide-md">${p.form.length ? formHtml(p.form) : '<span class="muted">–</span>'}</td>
        </tr>`;
      })
      .join('');
  }

  function matchHtml(m, { admin = false } = {}) {
    const aWin = m.result === 'A';
    const bWin = m.result === 'B';
    const hasScore = m.score_a != null;
    const score = hasScore ? `${m.score_a} – ${m.score_b}` : m.result === 'D' ? 'B' : aWin ? 'G – M' : 'M – G';
    const dCls = (d) => (d > 0 ? 'up' : d < 0 ? 'down' : 'zero');
    const tag = isDomination(m) ? '<span class="tag tag-neon m-tag">Dominasyon</span>' : '';
    return `
      <li class="match ${S.freshMatchId === m.id ? 'fresh' : ''}" data-match="${m.id}">
        ${tag}
        <div class="m-side">
          <span class="m-name ${aWin ? 'winner' : bWin ? 'loser' : ''}" data-player="${m.player_a}">${esc(m.name_a)}</span>
          <span class="m-delta ${dCls(m.delta_a)}">${signed(m.delta_a)} · ${m.before_a + m.delta_a}</span>
        </div>
        <div class="m-center">
          <span class="m-score ${m.result === 'D' ? 'draw' : ''}">${score}</span>
          <div class="m-time">${ago(m.played_at)}</div>
        </div>
        <div class="m-side right">
          <span class="m-name ${bWin ? 'winner' : aWin ? 'loser' : ''}" data-player="${m.player_b}">${esc(m.name_b)}</span>
          <span class="m-delta ${dCls(m.delta_b)}">${m.before_b + m.delta_b} · ${signed(m.delta_b)}</span>
        </div>
        ${
          admin
            ? `<div class="m-admin"><button class="btn btn-ghost btn-sm" data-edit-match="${m.id}">Düzelt</button><button class="btn btn-danger btn-sm" data-del-match="${m.id}">Sil</button></div>`
            : ''
        }
      </li>`;
  }

  function renderRecent() {
    const ms = S.state.matches.slice(0, 6);
    $('#recent').innerHTML = ms.length
      ? ms.map((m) => matchHtml(m)).join('')
      : '<li class="empty">Henüz maç yok. İlk maçı sen gir!</li>';
  }

  function renderAllMatches() {
    const sel = $('#filter-player');
    const cur = sel.value;
    sel.innerHTML =
      '<option value="">Bütün oyuncular</option>' +
      S.state.players.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (cur && S.byId.has(Number(cur))) sel.value = cur;
    const fid = Number(sel.value) || null;
    const list = fid ? S.state.matches.filter((m) => m.player_a === fid || m.player_b === fid) : S.state.matches;
    $('#all-matches').innerHTML = list.length
      ? list
          .slice(0, S.matchLimit)
          .map((m) => matchHtml(m, { admin: S.isAdmin }))
          .join('')
      : '<li class="empty">Maç bulunamadı.</li>';
    $('#more-matches').hidden = list.length <= S.matchLimit;
  }

  // ---------- Maç ekle ----------
  function playerOptions(selected, placeholder) {
    return (
      `<option value="">${placeholder}</option>` +
      [...S.state.players]
        .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
        .map((p) => `<option value="${p.id}" ${p.id === selected ? 'selected' : ''}>${esc(p.name)} (${p.rating})</option>`)
        .join('')
    );
  }

  function renderMatchForm() {
    const a = $('#sel-a');
    const b = $('#sel-b');
    const va = Number(a.value) || null;
    const vb = Number(b.value) || null;
    a.innerHTML = playerOptions(va, 'Oyuncu seç');
    b.innerHTML = playerOptions(vb, 'Oyuncu seç');
    updatePreview();
  }

  function scoreVal(id) {
    const v = $(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 99 ? n : NaN;
  }

  function setResult(r) {
    S.result = r;
    $$('.res-btn').forEach((btn) => {
      btn.classList.toggle('selected', btn.dataset.result === r);
      btn.setAttribute('aria-checked', String(btn.dataset.result === r));
    });
  }

  function updatePreview() {
    const pa = S.byId.get(Number($('#sel-a').value));
    const pb = S.byId.get(Number($('#sel-b').value));
    $('#elo-a').textContent = pa ? `${pa.rating} ELO · ${tier(pa.rating).name}` : '';
    $('#elo-b').textContent = pb ? `${pb.rating} ELO · ${tier(pb.rating).name}` : '';
    $('#res-a').textContent = pa ? pa.name : 'Ev Sahibi';
    $('#res-b').textContent = pb ? pb.name : 'Deplasman';

    // Skor girildiyse sonucu otomatik seç
    const sa = scoreVal('#score-a');
    const sb = scoreVal('#score-b');
    if (sa != null && sb != null && !Number.isNaN(sa) && !Number.isNaN(sb)) setResult(sa > sb ? 'A' : sa < sb ? 'B' : 'D');

    for (const r of ['A', 'D', 'B']) $(`#pv-${r}`).textContent = '';
    if (pa && pb && pa.id !== pb.id) {
      const ps = S.state.players;
      const avg = ps.reduce((s, p) => s + p.rating, 0) / ps.length;
      for (const r of ['A', 'D', 'B']) {
        const c = Elo.computeMatch(pa, pb, r, avg);
        $(`#pv-${r}`).textContent = `${signed(c.deltaA)} / ${signed(c.deltaB)}`;
      }
    }
  }

  $('#sel-a').addEventListener('change', updatePreview);
  $('#sel-b').addEventListener('change', updatePreview);
  $$('.res-btn').forEach((btn) => btn.addEventListener('click', () => setResult(btn.dataset.result)));
  $$('.stepper').forEach((st) => {
    const input = $('input', st);
    st.addEventListener('click', (e) => {
      const step = Number(e.target.dataset.step);
      if (!step) return;
      const cur = input.value === '' ? 0 : Number(input.value) || 0;
      input.value = String(Math.max(0, Math.min(99, cur + step)));
      // Skor girilmeye başlandıysa diğer tarafı 0'dan başlat
      for (const other of ['#score-a', '#score-b']) if ($(other).value === '') $(other).value = '0';
      updatePreview();
    });
    input.addEventListener('input', updatePreview);
  });

  $('#match-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#match-msg');
    msg.className = 'form-msg';
    msg.textContent = '';
    const playerA = Number($('#sel-a').value);
    const playerB = Number($('#sel-b').value);
    const sa = scoreVal('#score-a');
    const sb = scoreVal('#score-b');
    const fail = (t) => {
      msg.className = 'form-msg err';
      msg.textContent = t;
    };
    if (!playerA || !playerB) return fail('İki oyuncuyu da seç.');
    if (playerA === playerB) return fail('Kendinle maç yapamazsın. Bu kadar da yalnız kalma.');
    if (Number.isNaN(sa) || Number.isNaN(sb)) return fail('Skor 0-99 arası olmalı.');
    if ((sa == null) !== (sb == null)) return fail('Skoru iki taraf için de gir ya da boş bırak.');
    if (!S.result) return fail('Kazananı seç.');

    const btn = $('#save-match');
    btn.disabled = true;
    try {
      const { match } = await api('/api/matches', {
        method: 'POST',
        body: { playerA, playerB, result: S.result, scoreA: sa, scoreB: sb },
      });
      S.freshMatchId = match ? match.id : null;
      $('#score-a').value = '';
      $('#score-b').value = '';
      setResult(null);
      msg.className = 'form-msg ok';
      msg.textContent = 'Kaydedildi! Puanlar güncellendi.';
      await loadState();
      if (match) matchToast(match);
    } catch (err) {
      fail(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  function matchToast(m) {
    if (m.result === 'D') {
      toast({
        title: 'Berabere',
        lines: [`${m.name_a} ${signed(m.delta_a)} · ${m.name_b} ${signed(m.delta_b)}`],
        quip: 'Puanlar paylaşıldı.',
      });
      return;
    }
    const aWon = m.result === 'A';
    const winner = aWon ? m.name_a : m.name_b;
    const loser = aWon ? m.name_b : m.name_a;
    const dw = aWon ? m.delta_a : m.delta_b;
    const dl = aWon ? m.delta_b : m.delta_a;
    toast({
      title: `${winner} kazandı!`,
      lines: [`${winner} ${signed(dw)} ELO`, `${loser} ${signed(dl)} ELO — ${pick(LOSS_QUIPS)}`],
      quip: isDomination(m) ? 'Bu nasıl bir dominasyon!' : null,
    });
  }

  // ---------- Bildirim ----------
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
    setTimeout(close, 5500);
  }

  // ---------- Profil ----------
  const modal = $('#modal');
  function openModal(html) {
    $('#modal-body').innerHTML = html;
    if (!modal.open) modal.showModal();
  }
  $('#modal-close').addEventListener('click', () => modal.close());
  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.close();
  });

  function chartSvg(history) {
    if (history.length < 2) return '';
    const W = 600, H = 120, P = 10;
    const vals = history.map((h) => h.rating);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (max - min < 40) { min -= 20; max += 20; }
    const x = (i) => P + (i * (W - 2 * P)) / (history.length - 1);
    const y = (v) => H - P - ((v - min) * (H - 2 * P)) / (max - min);
    const pts = vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
    const area = `${P},${H - P} ${pts} ${W - P},${H - P}`;
    return `<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="ELO grafiği">
      <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#00ff87" stop-opacity=".35"/><stop offset="1" stop-color="#00ff87" stop-opacity="0"/></linearGradient></defs>
      <polygon points="${area}" fill="url(#g)"/>
      <polyline points="${pts}" fill="none" stroke="#00ff87" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>
    </svg>`;
  }

  function openProfile(id) {
    const p = S.byId.get(id);
    if (!p) return;
    const ms = S.state.matches.filter((m) => m.player_a === id || m.player_b === id);
    const hasGoals = p.goalsFor + p.goalsAgainst > 0;
    openModal(`
      <div class="profile">
        <div>${futCard(p)}</div>
        <div>
          <p class="eyebrow">Oyuncu Profili · #${p.rank}</p>
          <h1 class="title sm">${esc(p.name)}</h1>
          <div class="pstats">
            <div class="pstat"><b class="neon">${p.rating}</b><span>ELO</span></div>
            <div class="pstat"><b>${p.peak}</b><span>Rekor</span></div>
            <div class="pstat"><b>${p.games ? p.winRate + '%' : '–'}</b><span>Galibiyet</span></div>
            <div class="pstat"><b><span class="w">${p.wins}</span>-<span class="d">${p.draws}</span>-<span class="l">${p.losses}</span></b><span>G-B-M</span></div>
            <div class="pstat"><b>${p.games}</b><span>Maç</span></div>
            <div class="pstat"><b>${hasGoals ? `${p.goalsFor}:${p.goalsAgainst}` : '–'}</b><span>Gol</span></div>
          </div>
          ${chartSvg(p.history)}
        </div>
      </div>
      <div class="profile-matches">
        <h3>Maç Geçmişi</h3>
        <ul class="match-list compact">${ms.length ? ms.map((m) => matchHtml(m)).join('') : '<li class="empty">Henüz maç yok.</li>'}</ul>
      </div>`);
  }

  // Genel tıklama: oyuncu kartları/satırları, maç düzenleme
  document.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-edit-match]');
    if (editBtn) return openEditMatch(Number(editBtn.dataset.editMatch));
    const delBtn = e.target.closest('[data-del-match]');
    if (delBtn) return deleteMatch(Number(delBtn.dataset.delMatch));
    const pl = e.target.closest('[data-player]');
    if (pl && !e.target.closest('.admin-players')) openProfile(Number(pl.dataset.player));
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('.fut[data-player]')) openProfile(Number(e.target.dataset.player));
  });

  // ---------- Navigasyon ----------
  const VIEWS = ['siralama', 'mac-ekle', 'maclar', 'ayarlar'];
  function show(view) {
    if (!VIEWS.includes(view)) view = 'siralama';
    S.view = view;
    for (const v of VIEWS) $(`#view-${v}`).hidden = v !== view;
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.nav === view));
    if (modal.open) modal.close();
    window.scrollTo({ top: 0 });
  }
  window.addEventListener('hashchange', () => show(location.hash.slice(1)));
  $('#filter-player').addEventListener('change', () => {
    S.matchLimit = 30;
    renderAllMatches();
  });
  $('#more-matches').addEventListener('click', () => {
    S.matchLimit += 30;
    renderAllMatches();
  });

  // ---------- Yönetici ----------
  function setAdmin(token) {
    S.token = token;
    S.isAdmin = !!token;
    try {
      if (token) localStorage.setItem('zirzir_admin', token);
      else localStorage.removeItem('zirzir_admin');
    } catch {}
    $('#login-panel').hidden = S.isAdmin;
    $('#admin-panel').hidden = !S.isAdmin;
    renderAllMatches();
    renderAdmin();
    if (S.isAdmin) loadLog();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#login-msg');
    msg.className = 'form-msg';
    msg.textContent = '';
    try {
      const { token } = await api('/api/admin/login', { method: 'POST', body: { code: $('#admin-code').value } });
      $('#admin-code').value = '';
      setAdmin(token);
      toast({ title: 'Yönetici paneli açıldı', lines: ['Güç sende. Adil kullan.'] });
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  $('#logout').addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST', auth: true });
    } catch {}
    setAdmin(null);
  });

  function renderAdmin() {
    if (!S.isAdmin) return;
    const sel = $('#adj-player');
    const cur = Number(sel.value) || null;
    sel.innerHTML = playerOptions(cur, 'Oyuncu seç');
    $('#admin-players').innerHTML = S.state.players.length
      ? S.state.players
          .map(
            (p) => `<li><span class="ap-name">${esc(p.name)}</span><span class="ap-elo">${p.rating}</span>
              <button class="btn btn-ghost btn-sm" data-rename="${p.id}">Ad</button>
              <button class="btn btn-danger btn-sm" data-del-player="${p.id}">Sil</button></li>`
          )
          .join('')
      : '<li class="empty">Henüz oyuncu yok.</li>';
  }

  const ACTION_TEXT = {
    admin_login: () => 'Yönetici girişi yapıldı',
    player_add: (d) => `Oyuncu eklendi: ${d.name}`,
    player_rename: (d) => `Oyuncu adı değişti: ${d.from} → ${d.to}`,
    player_delete: (d) => `Oyuncu silindi: ${d.name} (${d.rating ?? '?'} ELO, ${d.matchesRemoved} maç kaldırıldı)`,
    elo_adjust: (d) => `Manuel ELO: ${d.name} ${signed(d.amount)} (${d.before ?? '?'} → ${(d.before ?? 0) + d.amount})${d.reason ? ` · “${d.reason}”` : ''}`,
    match_edit: (d) => {
      const b = d.before || {};
      const nm = (id) => S.byId.get(id)?.name || `#${id}`;
      const fmt = (x, a, bb) => (x.score_a != null || x.scoreA != null ? `${x.score_a ?? x.scoreA}-${x.score_b ?? x.scoreB}` : { A: `${a} kazandı`, B: `${bb} kazandı`, D: 'berabere' }[x.result]);
      return `Maç #${d.matchId} düzeltildi: ${b.name_a ?? '?'} vs ${b.name_b ?? '?'} (${fmt(b, b.name_a, b.name_b)}) → ${nm(d.after.playerA)} vs ${nm(d.after.playerB)} (${fmt(d.after, nm(d.after.playerA), nm(d.after.playerB))})`;
    },
    match_delete: (d) => `Maç #${d.matchId} silindi${d.match ? `: ${d.match.name_a} vs ${d.match.name_b}` : ''}`,
  };

  async function loadLog() {
    try {
      const { audit } = await api('/api/admin/log', { auth: true });
      $('#admin-log').innerHTML = audit.length
        ? audit
            .map((r) => {
              const cls = r.action === 'elo_adjust' ? (r.details.amount > 0 ? 'adj-up' : 'adj-down') : '';
              const text = (ACTION_TEXT[r.action] || (() => r.action))(r.details);
              return `<li class="${cls}"><time>${tsFmt.format(new Date(r.created_at))}</time><span>${esc(text)}</span></li>`;
            })
            .join('')
        : '<li class="empty">Kayıt yok.</li>';
    } catch (e) {
      console.warn(e);
    }
  }

  $$('.quick button').forEach((b) =>
    b.addEventListener('click', () => {
      $('#adj-amount').value = b.dataset.amt;
    })
  );

  $('#adjust-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#adj-msg');
    msg.className = 'form-msg';
    const playerId = Number($('#adj-player').value);
    const amount = Number($('#adj-amount').value);
    const p = S.byId.get(playerId);
    if (!p) {
      msg.className = 'form-msg err';
      msg.textContent = 'Oyuncu seç.';
      return;
    }
    try {
      const r = await api('/api/admin/adjust', {
        method: 'POST',
        auth: true,
        body: { playerId, amount, reason: $('#adj-reason').value },
      });
      msg.className = 'form-msg ok';
      msg.textContent = `${p.name}: ${signed(amount)} ELO uygulandı → ${r.player ? r.player.rating : '?'}`;
      $('#adj-amount').value = '';
      $('#adj-reason').value = '';
      await loadState();
      loadLog();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  $('#player-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('#player-msg');
    const name = $('#new-player').value;
    try {
      await api('/api/admin/players', { method: 'POST', auth: true, body: { name } });
      msg.className = 'form-msg ok';
      msg.textContent = `${name.trim()} lige katıldı. 1000 ELO ile başlıyor.`;
      $('#new-player').value = '';
      await loadState();
      loadLog();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  $('#admin-players').addEventListener('click', async (e) => {
    const ren = e.target.closest('[data-rename]');
    const del = e.target.closest('[data-del-player]');
    const msg = $('#player-msg');
    try {
      if (ren) {
        const p = S.byId.get(Number(ren.dataset.rename));
        const name = prompt('Yeni ad:', p?.name || '');
        if (!name) return;
        await api(`/api/admin/players/${p.id}`, { method: 'PATCH', auth: true, body: { name } });
      } else if (del) {
        const p = S.byId.get(Number(del.dataset.delPlayer));
        if (!p) return;
        if (!confirm(`${p.name} silinsin mi?\n\nOyuncunun ${p.games} maçı da silinir ve bütün sıralama yeniden hesaplanır. Bu işlem geri alınamaz.`)) return;
        await api(`/api/admin/players/${p.id}`, { method: 'DELETE', auth: true });
        msg.className = 'form-msg ok';
        msg.textContent = `${p.name} silindi.`;
      } else return;
      await loadState();
      loadLog();
    } catch (err) {
      msg.className = 'form-msg err';
      msg.textContent = err.message;
    }
  });

  function openEditMatch(id) {
    const m = S.state.matches.find((x) => x.id === id);
    if (!m || !S.isAdmin) return;
    openModal(`
      <p class="eyebrow">Yönetici</p>
      <h1 class="title sm">Maç #${m.id} <span class="neon">Düzelt</span></h1>
      <form id="edit-form" autocomplete="off">
        <div class="edit-grid">
          <label>Ev sahibi<select id="ed-a">${playerOptions(m.player_a, 'Seç')}</select></label>
          <label>Deplasman<select id="ed-b">${playerOptions(m.player_b, 'Seç')}</select></label>
          <label>Ev sahibi skor<input id="ed-sa" inputmode="numeric" value="${m.score_a ?? ''}" placeholder="–"></label>
          <label>Deplasman skor<input id="ed-sb" inputmode="numeric" value="${m.score_b ?? ''}" placeholder="–"></label>
          <label>Sonuç<select id="ed-r">
            <option value="A" ${m.result === 'A' ? 'selected' : ''}>Ev sahibi kazandı</option>
            <option value="D" ${m.result === 'D' ? 'selected' : ''}>Berabere</option>
            <option value="B" ${m.result === 'B' ? 'selected' : ''}>Deplasman kazandı</option>
          </select></label>
        </div>
        <p class="muted small">Kaydedince bu maçtan sonraki bütün puanlar otomatik yeniden hesaplanır.</p>
        <p class="form-msg" id="ed-msg"></p>
        <div class="row-actions">
          <button type="button" class="btn btn-danger" data-del-match="${m.id}">Maçı Sil</button>
          <button type="submit" class="btn btn-primary">Kaydet</button>
        </div>
      </form>`);
    $('#edit-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sa = $('#ed-sa').value.trim();
      const sb = $('#ed-sb').value.trim();
      try {
        await api(`/api/admin/matches/${id}`, {
          method: 'PUT',
          auth: true,
          body: {
            playerA: Number($('#ed-a').value),
            playerB: Number($('#ed-b').value),
            scoreA: sa === '' ? null : Number(sa),
            scoreB: sb === '' ? null : Number(sb),
            result: $('#ed-r').value,
          },
        });
        modal.close();
        toast({ title: 'Maç düzeltildi', lines: ['Sıralama yeniden hesaplandı.'] });
        await loadState();
        loadLog();
      } catch (err) {
        $('#ed-msg').className = 'form-msg err';
        $('#ed-msg').textContent = err.message;
      }
    });
  }

  async function deleteMatch(id) {
    const m = S.state.matches.find((x) => x.id === id);
    if (!m || !S.isAdmin) return;
    if (!confirm(`${m.name_a} vs ${m.name_b} maçı silinsin mi?\nPuanlar yeniden hesaplanır.`)) return;
    try {
      await api(`/api/admin/matches/${id}`, { method: 'DELETE', auth: true });
      if (modal.open) modal.close();
      toast({ title: 'Maç silindi', lines: ['Sıralama yeniden hesaplandı.'] });
      await loadState();
      loadLog();
    } catch (err) {
      toast({ title: 'Silinemedi', lines: [err.message], error: true });
    }
  }

  // ---------- Başlangıç ----------
  show(location.hash.slice(1) || 'siralama');
  let saved = null;
  try {
    saved = localStorage.getItem('zirzir_admin');
  } catch {}
  loadState().then(async () => {
    if (saved) {
      S.token = saved;
      try {
        await api('/api/admin/check', { auth: true });
        setAdmin(saved);
      } catch {
        setAdmin(null);
      }
    }
  });
  connectLive();
})();
