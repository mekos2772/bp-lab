/* BP LAB 首页：实时比赛 + 版本胜率 + 数据概览 */
(function () {
  'use strict';
  const C = window.BP_CONTRACT || {};
  const R = window.BP_RULES || {};
  const ROLE_LABEL = { top: '上单', jungle: '打野', mid: '中单', adc: '下路', support: '辅助' };
  const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];

  const timeText = iso => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
  };

  function heroStats() {
    const meta = C.meta || {};
    const cal = (R.phase && R.phase.early && R.phase.early.calibration) || {};
    const items = [
      ['173', '英雄标签'],
      ['1,618', '韩服排位'],
      ['12,523', '职业对局'],
      ['8,848', '真实 BP 场次'],
    ];
    const el = document.getElementById('heroStats');
    el.innerHTML = items.map(([v, l]) => `<div class="hero-stat"><b>${v}</b><span>${l}</span></div>`).join('');
  }

  function normEvent(e) {
    const teams = e.teams || [];
    return {
      league: e.league || '',
      state: e.state,
      start: e.startTime,
      block: e.blockName || '',
      teams,
      bp: e.bp,
    };
  }

  function renderLive() {
    const doc = window.BP_LIVE || {};
    const reg = window.BP_ESPORTS_RESULTS || {};
    const grid = document.getElementById('liveGrid');
    const dot = document.getElementById('liveDot');
    const up = document.getElementById('liveUpdated');
    if (!grid) return;
    const live = (doc.live || []).map(e => ({ ...e, kind: 'live' }));
    const fixtures = (reg.fixtures || []).slice(0, 4).map(f => ({
      league: f.league, state: 'unstarted', startTime: f.scheduledAt,
      blockName: f.name, teams: [f.homeTeam, f.awayTeam], kind: 'fixture', bp: null,
    }));
    const cards = [...live, ...fixtures];
    dot.className = 'live-dot' + (live.length ? ' on' : '');
    const t = (doc.meta && doc.meta.fetchedAt) ? timeText(doc.meta.fetchedAt) : '';
    up.textContent = `lolesports / OP.GG · ${t}${live.length ? '' : ' · 当前无进行中'}`;
    if (!cards.length) {
      grid.innerHTML = '<div class="lc-sub">当前无进行中或即将开始的比赛（休赛期）</div>';
      return;
    }
    grid.innerHTML = cards.slice(0, 6).map(e => {
      const te = e.teams || [];
      const names = te.length >= 2 ? `${te[0].code || te[0].name || ''} <i>vs</i> ${te[1].code || te[1].name || ''}` : (e.blockName || '待定对阵');
      const state = e.state === 'inProgress' ? '<span class="badge-live">LIVE</span>'
        : `<span class="lc-sub">${timeText(e.startTime) || ''}</span>`;
      const bp = e.bp && e.bp.picks && e.bp.picks.length
        ? `<div class="lc-bp">${e.bp.picks.map(p => `<img src="${p.icon}" title="${p.name}" alt="">`).join('')}</div>`
        : (e.kind === 'live' ? '<div class="lc-bp"><span class="none">BP 待同步</span></div>' : '');
      const sub = e.kind === 'live' ? (e.blockName || '') : (e.blockName || e.name || '');
      return `<div class="live-card-lg ${e.state}">
        <div class="lc-top"><span>${e.league || ''}</span>${state}</div>
        <div class="lc-teams">${names}</div>
        <div class="lc-sub">${sub || ''}</div>
        ${bp}
      </div>`;
    }).join('');
  }

  let currentRole = 'top';
  function renderRates() {
    const tabs = document.getElementById('roleTabs');
    tabs.innerHTML = ROLES.map(r => `<button class="role-tab ${r === currentRole ? 'active' : ''}" data-role="${r}">${ROLE_LABEL[r]}</button>`).join('');
    tabs.querySelectorAll('.role-tab').forEach(b => b.addEventListener('click', () => {
      currentRole = b.dataset.role;
      renderRates();
    }));
    const rows = [];
    Object.entries(C.champions || {}).forEach(([key, champ]) => {
      const rd = (champ.roles || {})[currentRole];
      if (!rd) return;
      const m = rd.meta || {};
      if (typeof m.winRate !== 'number') return;
      rows.push({ key, name: champ.name, icon: champ.icon, wr: m.winRate, pick: m.pickRate, play: m.play || 0 });
    });
    rows.sort((a, b) => b.wr - a.wr);
    const top = rows.slice(0, 10);
    document.getElementById('ratesTable').innerHTML = top.map(r =>
      `<div class="rate-item"><img src="${r.icon}" alt=""><b>${r.name}</b>
        <em>${r.pick != null ? r.pick.toFixed(1) + '% pick' : ''}</em>
        <span class="wr">${r.wr.toFixed(1)}%</span></div>`).join('');
  }

  function refreshLive() {
    const old = document.querySelector('script[data-live]');
    if (old) old.remove();
    const s = document.createElement('script');
    s.src = `data/live_matches.js?t=${Date.now()}`;
    s.dataset.live = '1';
    s.onload = renderLive;
    document.body.appendChild(s);
  }

  function renderResults() {
    const doc = window.BP_ESPORTS_RESULTS || {};
    const box = document.getElementById('resultsPanel');
    if (!box) return;
    const rows = (doc.results || doc.matches || []).slice(0, 8);
    if (!rows.length) { box.innerHTML = '<div class="lc-sub">暂无结果数据</div>'; return; }
    const upd = document.getElementById('resultsUpdated');
    if (upd && doc.meta) upd.textContent = `OP.GG · ${timeText(doc.meta.fetchedAt)}`;
    box.innerHTML = rows.map(m => {
      const h = m.homeTeam || {}, a = m.awayTeam || {};
      const win = (m.homeScore ?? 0) > (m.awayScore ?? 0);
      return `<div class="result-row">
        <div class="rs-league">${m.league || ''}<em>${timeText(m.scheduledAt)}</em></div>
        <div class="rs-teams">
          <b class="${win ? 'win' : ''}">${h.code || h.name || ''}</b>
          <span class="rs-score">${m.homeScore ?? '-'} : ${m.awayScore ?? '-'}</span>
          <b class="${win ? '' : 'win'}">${a.code || a.name || ''}</b>
        </div>
        <div class="rs-name">${m.name || ''}</div>
      </div>`;
    }).join('');
  }

  heroStats();
  renderLive();
  renderResults();
  renderRates();
  setInterval(refreshLive, 20000);
})();
