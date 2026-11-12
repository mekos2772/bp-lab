(() => {
  'use strict';

  const CONTRACT = window.BP_CONTRACT;
  const RULES = window.BP_RULES;
  if (!CONTRACT || !RULES || !window.BPLEngine) {
    document.body.innerHTML = '<pre style="color:#f88;padding:24px">缺少数据文件：请先运行 scripts/build_v22_contract.py 生成 data/bp_contract.js</pre>';
    return;
  }

  const engine = window.BPLEngine.createEngine({ contract: CONTRACT, rules: RULES });
  const ROLE_ORDER = engine.ROLES;
  const ROLE_META = {};
  ROLE_ORDER.forEach(r => { ROLE_META[r] = { label: engine.ROLE_LABELS[r], short: { top: '上', jungle: '野', mid: '中', adc: 'AD', support: '辅' }[r] }; });
  const LEVEL_LABEL = engine.levelLabels;
  const CHAMPS = engine.allChampions().filter(c => c.positions && c.positions.length);
  const CHAMP_BY_KEY = new Map(CHAMPS.map(c => [c.key, c]));
  const SIDE_META = {
    blue: { name: '蓝方', short: 'B' },
    red: { name: '红方', short: 'R' },
  };
  const BUCKET_ORDER = ['<25', '25-30', '30-35', '35-40', '40+'];
  const LANE = (window.BP_LANE_STATS && window.BP_LANE_STATS.champions) || {};
  const LANE_DUOS = (window.BP_LANE_DUOS && window.BP_LANE_DUOS.duos) || {};

  function laneFor(key, role) {
    const c = LANE[key];
    return c && c[role] ? c[role] : null;
  }

  function duoFor(adcKey, supKey) {
    if (!adcKey || !supKey) return null;
    return LANE_DUOS[`${adcKey}|${supKey}`] || null;
  }

  /** 对线强度：职业赛 15 分钟经济差（同位置/下路双人）。 */
  function laneEdge(role) {
    const b = state.blue.picks[role];
    const r = state.red.picks[role];
    if (!b || !r) return null;
    if (role === 'adc' || role === 'support') {
      const bd = duoFor(state.blue.picks.adc, state.blue.picks.support);
      const rd = duoFor(state.red.picks.adc, state.red.picks.support);
      if (bd && rd) return { kind: 'duo', mine: bd, theirs: rd, delta: bd.gd15 - rd.gd15, n: Math.min(bd.n, rd.n) };
    }
    const bv = laneFor(b, role);
    const rv = laneFor(r, role);
    if (!bv || !rv) return null;
    return { kind: 'solo', mine: bv, theirs: rv, delta: bv.gd15 - rv.gd15, n: Math.min(bv.n, rv.n) };
  }

  function edgeLabel(delta) {
    if (delta >= 200) return ['强', 'strong'];
    if (delta >= 100) return ['略强', 'strong'];
    if (delta <= -200) return ['弱', 'weak'];
    if (delta <= -100) return ['略弱', 'weak'];
    return ['均势', 'even'];
  }

  function renderPhaseCurve() {
    const panel = $('#phasePanel');
    if (!panel) return;
    const blue = engine.teamPhases(state.blue.picks);
    const red = engine.teamPhases(state.red.picks);
    if (!blue && !red) {
      panel.innerHTML = '<div class="lane-empty">选择英雄后显示双方「阶段倾向」（规则推断，非胜率）</div>';
      return;
    }
    const phases = ['early', 'mid', 'late'];
    const labels = { early: '前期', mid: '中期', late: '后期' };
    const W = 300, H = 64, padL = 30, padR = 10, padT = 8, padB = 14;
    const x = i => padL + ((W - padL - padR) * i) / 2;
    const y = v => padT + (H - padT - padB) * (1 - (v + 1) / 2);
    const line = (obj, color) => {
      if (!obj) return '';
      const pts = phases.map((k, i) => ({ x: x(i), y: y(obj[k] == null ? 0 : obj[k]), v: obj[k] }));
      const d = pts.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>` +
        pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="2.6" fill="#0a0e16" stroke="${color}" stroke-width="1.5"><title>${labels[phases[p === pts[0] ? 0 : 0]] || ''}${p.v == null ? '—' : (p.v >= 0 ? '+' : '') + p.v.toFixed(2)}</title></circle>`).join('');
    };
    const val = (o, k) => (o && o[k] != null ? (o[k] >= 0 ? '+' : '') + o[k].toFixed(2) : '—');
    const cal = (blue && blue.earlyCalibration) || (red && red.earlyCalibration);
    const calText = cal ? `早期校准 n=${cal.n} · CV ${cal.cvCorr} · 队伍级 ${cal.teamCorr}` : '早期未校准';
    const cov = `覆盖 蓝${blue ? blue.coverageCount : '0/0'} / 红${red ? red.coverageCount : '0/0'}`;
    panel.innerHTML = `
      <div class="phase-head"><span>阶段倾向（早期已校准）</span><i title="${calText}">非胜率 · ${cov} · 中后期为专家规则</i></div>
      <div class="phase-body">
        <svg viewBox="0 0 ${W} ${H}" class="phase-svg" role="img" aria-label="双方阶段倾向">
          <line x1="${padL}" y1="${y(0)}" x2="${W - padR}" y2="${y(0)}" stroke="rgba(255,255,255,.12)" stroke-dasharray="3 3"/>
          ${phases.map((k, i) => `<text x="${x(i)}" y="${H - 3}" text-anchor="middle" fill="rgba(127,136,155,.75)" font-size="7" font-family="monospace">${labels[k]}</text>`).join('')}
          ${line(blue, '#4c9dff')}
          ${line(red, '#ff5c6c')}
        </svg>
        <div class="phase-vals">
          <div class="pv-row blue"><b>蓝</b><span>${phases.map(k => val(blue, k)).join(' / ')}</span></div>
          <div class="pv-row red"><b>红</b><span>${phases.map(k => val(red, k)).join(' / ')}</span></div>
        </div>
      </div>`;
  }

  function renderLanePanel() {
    const panel = $('#lanePanel');
    if (!panel) return;
    const rows = ROLE_ORDER.map(role => ({ role, edge: laneEdge(role) }))
      .filter(x => x.edge)
      .filter(x => !(x.role === 'support' && x.edge.kind === 'duo'));
    if (!rows.length) {
      panel.innerHTML = '<div class="lane-empty">双方同一位置都选齐后，显示职业赛 15 分钟对线经济差对比</div>';
      return;
    }
    panel.innerHTML = `<div class="lane-head"><span>对线强度 · 15 分钟经济差（职业赛 2026）</span><i>实测数据，不是胜率</i></div>` +
      rows.map(({ role, edge }) => {
        const [label, cls] = edgeLabel(edge.delta);
        const sign = v => (v > 0 ? '+' : '');
        return `<div class="lane-row">
          <span class="lane-role">${ROLE_META[role].label}</span>
          <span class="lane-side blue">${sign(edge.mine.gd15)}${edge.mine.gd15}</span>
          <span class="lane-name">${edge.kind === 'duo' ? '双人路合计' : '同位置'}</span>
          <span class="lane-side red">${sign(edge.theirs.gd15)}${edge.theirs.gd15}</span>
          <span class="lane-badge ${cls}">${label} ${sign(edge.delta)}${Math.round(edge.delta)}</span>
          <span class="lane-n">n ${edge.n}</span>
        </div>`;
      }).join('');
  }

  const DRAFT_ORDER = [
    ['blue', 'ban'], ['red', 'ban'], ['blue', 'ban'], ['red', 'ban'], ['blue', 'ban'], ['red', 'ban'],
    ['blue', 'pick'], ['red', 'pick'], ['red', 'pick'], ['blue', 'pick'], ['blue', 'pick'], ['red', 'pick'],
    ['red', 'ban'], ['blue', 'ban'], ['red', 'ban'], ['blue', 'ban'],
    ['blue', 'pick'], ['red', 'pick'], ['red', 'pick'], ['blue', 'pick'],
  ];

  const createTeam = () => ({
    picks: { top: null, jungle: null, mid: null, adc: null, support: null },
    bans: [],
  });

  const state = {
    mode: 'standard',
    step: 0,
    blue: createTeam(),
    red: createTeam(),
    roleBySide: { blue: 'top', red: 'top' },
    activeRole: 'top',
    freeSide: 'blue',
    freeAction: 'pick',
    filterRole: 'all',
    search: '',
    sort: 'name',
    history: [],
  };

  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const fmtPp = (v, digits = 1) => {
    if (v === null || v === undefined || Number.isNaN(v)) return '—';
    const n = Number(v);
    return `${n > 0.049 ? '+' : ''}${n.toFixed(digits)}`;
  };
  const escapeHtml = (str = '') => String(str)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  const pct = v => (v === null || v === undefined ? '—' : `${Number(v).toFixed(1)}%`);
  const nfmt = v => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));

  function currentTurn() {
    if (state.mode === 'free') return { side: state.freeSide, action: state.freeAction };
    if (state.step >= DRAFT_ORDER.length) return null;
    const [side, action] = DRAFT_ORDER[state.step];
    return { side, action };
  }

  function getAllUsed() {
    const used = new Map();
    for (const side of ['blue', 'red']) {
      const team = state[side];
      ROLE_ORDER.forEach(role => {
        if (team.picks[role]) used.set(team.picks[role], { type: 'pick', side, role });
      });
      team.bans.forEach(key => used.set(key, { type: 'ban', side }));
    }
    return used;
  }

  function teamPickCount(team) {
    return ROLE_ORDER.filter(r => team.picks[r]).length;
  }

  function nextAvailableRole(side) {
    const team = state[side];
    return ROLE_ORDER.find(role => !team.picks[role]) || null;
  }

  function ensureActiveRole() {
    const turn = currentTurn();
    if (!turn || turn.action !== 'pick') return;
    const team = state[turn.side];
    let role = state.roleBySide[turn.side];
    if (!role || team.picks[role]) {
      role = nextAvailableRole(turn.side) || 'top';
      state.roleBySide[turn.side] = role;
    }
    state.activeRole = role;
  }

  function structureOf(side) {
    const other = side === 'blue' ? 'red' : 'blue';
    return engine.structure(state[side].picks, state[other].picks);
  }

  function activeGapDimensions() {
    const side = currentTurn()?.side || 'blue';
    const st = structureOf(side);
    return {
      side,
      dims: st.gaps.filter(g => g.severity === 'HIGH' || g.severity === 'MEDIUM').map(g => g.dimension),
      structure: st,
    };
  }

  // ---------- actions ----------
  function pushHistory() {
    state.history.push(JSON.stringify({
      mode: state.mode, step: state.step, blue: state.blue, red: state.red,
      roleBySide: state.roleBySide, activeRole: state.activeRole,
      freeSide: state.freeSide, freeAction: state.freeAction,
    }));
    if (state.history.length > 80) state.history.shift();
  }

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(node._timer);
    node._timer = setTimeout(() => node.classList.remove('show'), 1800);
  }

  function selectChampion(champ) {
    const turn = currentTurn();
    if (!turn) { toast('BP 已完成，点击右上角「重新开始」'); return; }
    const used = getAllUsed();
    if (used.has(champ.key)) { toast('这个英雄已经在 BP 中了'); return; }
    const team = state[turn.side];
    const sideName = SIDE_META[turn.side].name;

    if (turn.action === 'ban') {
      if (team.bans.length >= 5) { toast(`${sideName}的 Ban 位已满`); return; }
      pushHistory();
      team.bans.push(champ.key);
      if (state.mode === 'standard') state.step++;
      renderAll();
      toast(`${sideName} Ban 掉了 ${champ.name}`);
      return;
    }

    let role = state.roleBySide[turn.side];
    const canUseRole = role && !team.picks[role] && champ.positions.includes(role);
    if (!canUseRole) role = ROLE_ORDER.find(r => !team.picks[r] && champ.positions.includes(r));
    if (!role) { toast(`${champ.name} 没有可用的分路位置（或本队阵容已满）`); return; }
    pushHistory();
    team.picks[role] = champ.key;
    state.roleBySide[turn.side] = nextAvailableRole(turn.side) || role;
    state.activeRole = state.roleBySide[turn.side];
    if (state.mode === 'standard') state.step++;
    renderAll();
    toast(`${sideName} 选择了 ${champ.name} · ${ROLE_META[role].label}`);
  }

  function undo() {
    if (!state.history.length) { toast('没有可以撤销的操作'); return; }
    Object.assign(state, JSON.parse(state.history.pop()));
    renderAll();
    toast('已撤销上一步');
  }

  function resetDraft(silent = false) {
    state.step = 0;
    state.blue = createTeam();
    state.red = createTeam();
    state.roleBySide = { blue: 'top', red: 'top' };
    state.activeRole = 'top';
    state.freeSide = 'blue';
    state.freeAction = 'pick';
    state.history = [];
    renderAll();
    if (!silent) toast('BP 已重置');
  }

  function setMode(mode) {
    if (mode === state.mode) return;
    if (teamPickCount(state.blue) || teamPickCount(state.red) || state.blue.bans.length || state.red.bans.length) {
      if (!window.confirm('切换模式会清空当前 BP，继续吗？')) return;
    }
    state.mode = mode;
    resetDraft(true);
    toast(mode === 'standard' ? '已切换到标准 BP 顺序' : '已切换到自由模式');
  }

  // ---------- 实时比赛条 ----------
  function timeText(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  function renderLiveStrip() {
    const box = $('#liveStrip');
    if (!box) return;
    const doc = window.BP_LIVE || null;
    if (!doc || !doc.ok) {
      box.innerHTML = '<div class="live-empty">实时比赛数据未就绪：请确认 <code>scripts/live_poller.mjs</code> 正在后台运行。</div>';
      return;
    }
    const live = doc.live || [];
    const upcoming = (doc.upcoming || []).filter(e => e.state !== 'completed').slice(0, 4);
    const recent = (doc.recent || []).slice(-4);
    const fixtures = ((window.BP_ESPORTS_RESULTS || {}).fixtures || []).slice(0, 3).map(f => ({
      league: f.league, state: 'unstarted', startTime: f.scheduledAt, blockName: f.name,
      teams: [f.homeTeam, f.awayTeam], bp: null,
    }));
    const seenIds = new Set();
    const events = [...live, ...fixtures, ...upcoming, ...recent].filter(e => {
      const k = `${e.league}|${e.startTime}|${(e.teams || []).map(t => (t && (t.code || t.name)) || '').join('-')}`;
      if (seenIds.has(k)) return false;
      seenIds.add(k);
      return true;
    });
    const fetched = doc.meta && doc.meta.fetchedAt ? timeText(doc.meta.fetchedAt) : '';

    const rates = [];
    Object.entries(CONTRACT.champions).forEach(([key, champ]) => {
      Object.entries(champ.roles || {}).forEach(([role, rd]) => {
        const m = rd.meta || {};
        if (typeof m.winRate === 'number' && (m.play || 0) >= 300) {
          rates.push({ key, name: champ.name, icon: champ.icon, role, wr: m.winRate });
        }
      });
    });
    rates.sort((a, b) => b.wr - a.wr);
    const seenRate = new Set();
    const topRates = [];
    for (const r of rates) {
      if (seenRate.has(r.key)) continue;
      seenRate.add(r.key);
      topRates.push(r);
      if (topRates.length === 6) break;
    }

    const chip = e => {
      const teams = e.teams || [];
      const who = teams.length >= 2 ? `${teams[0].code || teams[0].name} vs ${teams[1].code || teams[1].name}` : (e.blockName || e.league || 'TBD');
      const when = e.state === 'inProgress' ? 'LIVE' : (timeText(e.startTime) || '—');
      const bp = e.bp && e.bp.picks && e.bp.picks.length
        ? `<span class="live-bp-icons">${e.bp.picks.map(x => `<img src="${x.icon}" alt="">`).join('')}</span>`
        : '';
      return `<span class="live-chip ${e.state}"><b>${escapeHtml(e.league || '')}</b><i>${escapeHtml(when)}</i><span>${escapeHtml(who)}</span>${bp}</span>`;
    };

    box.innerHTML = `
      <div class="live-title"><span class="live-dot ${live.length ? 'on' : ''}"></span>实时比赛
        <em>lolesports · 20s 刷新${fetched ? ` · ${fetched}` : ''}</em></div>
      <div class="live-list">${events.length ? events.map(chip).join('') : '<span class="live-empty">当前无进行中或即将开始的比赛（休赛期）</span>'}</div>
      <div class="live-rates">
        <div class="live-rates-title">版本胜率 TOP · OP.GG 16.22 <i>口径未确认</i></div>
        ${topRates.map(r => `<div class="rate-row"><img src="${r.icon}" alt=""><span>${escapeHtml(r.name)}</span><em>${ROLE_META[r.role] ? ROLE_META[r.role].label : r.role}</em><b>${r.wr.toFixed(1)}%</b></div>`).join('')}
      </div>`;
  }

  function refreshLive() {
    const old = document.querySelector('script[data-live]');
    if (old) old.remove();
    const s = document.createElement('script');
    s.src = `data/live_matches.js?t=${Date.now()}`;
    s.dataset.live = '1';
    s.onload = () => { if (typeof window.BP_LIVE !== 'undefined') renderLiveStrip(); };
    document.body.appendChild(s);
  }

  // ---------- rendering ----------
  function renderAll() {
    ensureActiveRole();
    renderTeam('blue');
    renderTeam('red');
    renderDraftTrack();
    renderPool();
    renderPredictStrip();
    renderLiveStrip();
    renderAnalysis();
    renderModeBar();
    if (!$('#synergyModal').hidden) renderSynergyModal();
    if (!$('#counterModal').hidden) renderCounterModal();
    if (!$('#candidateModal').hidden) renderCandidateModal();
    if (!$('#predictModal').hidden) renderPredictModal();
  }

  function renderDraftTrack() {
    const wrap = $('#draftTrackWrap');
    const track = $('#draftTrack');
    if (state.mode === 'free') { wrap.hidden = true; return; }
    wrap.hidden = false;
    const counts = { blue: { ban: 0, pick: 0 }, red: { ban: 0, pick: 0 } };
    track.innerHTML = DRAFT_ORDER.map(([side, action], i) => {
      const done = i < state.step;
      const active = i === state.step;
      counts[side][action] += 1;
      return `<span class="track-step ${side} ${action} ${done ? 'done' : ''} ${active ? 'active' : ''}" title="${SIDE_META[side].name} ${action === 'ban' ? 'Ban' : 'Pick'}">${String(i + 1).padStart(2, '0')}</span>`;
    }).join('');
    $('#draftStepLabel').textContent = state.step >= DRAFT_ORDER.length ? 'BP 完成' : `${state.step + 1} / ${DRAFT_ORDER.length}`;
  }

  function renderModeBar() {
    const bar = $('#freeBar');
    if (bar) {
      bar.hidden = state.mode !== 'free';
      $$('#freeBar [data-side]').forEach(b => b.classList.toggle('active', b.dataset.side === state.freeSide));
      $$('#freeBar [data-action]').forEach(b => b.classList.toggle('active', b.dataset.action === state.freeAction));
      const roleHint = $('#freeRoleHint');
      if (roleHint) roleHint.textContent = `位置：${ROLE_META[state.roleBySide[state.freeSide]]?.label || '上单'}`;
    }
    const modeBtn = $('#modeBtn');
    modeBtn.textContent = state.mode === 'standard' ? '标准 BP' : '自由模式';
    modeBtn.classList.toggle('active', state.mode === 'free');
  }

  function levelPill(level) {
    return `<i class="lvl-dot lvl-${level.toLowerCase()}" title="${LEVEL_LABEL[level] || level}"></i>`;
  }

  function renderTeam(side) {
    const team = state[side];
    const panel = $(`#${side}Panel`);
    const turn = currentTurn();
    const isActive = !!turn && turn.side === side;
    panel.classList.toggle('is-active', isActive);

    const pickCount = teamPickCount(team);
    $(`#${side}Index`).textContent = String(pickCount).padStart(2, '0');
    const status = $(`#${side}Status`);
    if (!turn) status.textContent = 'BP 完成';
    else if (state.mode === 'free' && turn.action === 'pick' && pickCount >= 5) status.textContent = '阵容已满';
    else if (state.mode === 'free' && turn.action === 'ban' && team.bans.length >= 5) status.textContent = 'Ban 位已满';
    else if (!isActive) status.textContent = '等待对方';
    else if (turn.action === 'ban') status.textContent = `禁用阶段 · 第 ${team.bans.length + 1} / 5 手`;
    else status.textContent = `选择阶段 · 第 ${pickCount + 1} / 5 手`;

    const rolesEl = $(`#${side}Roles`);
    rolesEl.innerHTML = ROLE_ORDER.map(role => {
      const champKey = team.picks[role];
      const champ = champKey ? CHAMP_BY_KEY.get(champKey) : null;
      const sideRole = state.roleBySide?.[side] || state.activeRole;
      const target = isActive && turn?.action === 'pick' && sideRole === role && !champ;
      const splash = champ ? `style="--splash:url('${champ.icon.replace('champions', 'loading').replace('.png', '_0.jpg')}')"` : '';
      return `
        <div class="role-row ${target ? 'is-target' : ''} ${champ ? 'has-champ' : ''}" data-side="${side}" data-role="${role}" ${splash}>
          <div class="role-slot">${ROLE_META[role].short}</div>
          ${champ
            ? `<img class="champ-face" src="${champ.icon}" alt="${escapeHtml(champ.name)}" />`
            : `<div class="champ-face empty">+</div>`}
          <div class="role-meta">
            <div class="role-name">${ROLE_META[role].label}</div>
            <div class="champ-name ${champ ? '' : 'empty'}">${champ ? escapeHtml(champ.name) : '未选择'}</div>
          </div>
        </div>`;
    }).join('');

    const bansEl = $(`#${side}Bans`);
    bansEl.innerHTML = Array.from({ length: 5 }, (_, i) => {
      const key = team.bans[i];
      const champ = key ? CHAMP_BY_KEY.get(key) : null;
      return `<div class="ban-slot ${champ ? 'filled' : ''}" title="${champ ? escapeHtml(champ.name) : '空 Ban 位'}">${champ ? `<img src="${champ.icon}" alt="${escapeHtml(champ.name)}">` : '＋'}</div>`;
    }).join('');
    $(`#${side}BanCount`).textContent = `${team.bans.length} / 5`;

    // 结构缺口（v2.2：替代原来的队伍强度数字）
    const st = structureOf(side);
    const gapsEl = $(`#${side}Gaps`);
    if (st.gapGate === 'NEEDS_3_PICKS') {
      gapsEl.innerHTML = `<span class="gap-empty">需 3 名英雄后评估</span>`;
    } else if (st.gaps.length === 0) {
      const reviewed = st.members.filter(m => Object.keys(m.traits).some(d => engine.isReviewed(m.traits[d]))).length;
      gapsEl.innerHTML = reviewed === 0
        ? `<span class="gap-empty" title="该英雄池的战术标签尚未审核">标签未审核</span>`
        : `<span class="gap-ok">未发现结构性缺口</span>`;
    } else {
      const top = st.gaps.slice(0, 2);
      gapsEl.innerHTML = top.map(g => `<span class="gap-chip ${g.severity.toLowerCase()}" title="${escapeHtml(g.detail)}">${escapeHtml(g.title)}</span>`).join('')
        + (st.gaps.length > 2 ? `<span class="gap-more" title="${escapeHtml(st.gaps.slice(2).map(g => g.title).join(' / '))}">+${st.gaps.length - 2}</span>` : '');
    }
  }

  function champSortValue(champ, mode) {
    const role = state.filterRole !== 'all' && champ.positions.includes(state.filterRole)
      ? state.filterRole
      : champ.positions[0];
    const m = engine.meta(champ.key, role);
    if (mode === 'tier') return m.status === 'KNOWN' && m.tier != null ? -m.tier : -999;
    if (mode === 'winRate') return m.status === 'KNOWN' && m.winRate != null ? m.winRate : -999;
    if (mode === 'gaps') {
      const { dims } = activeGapDimensions();
      const t = engine.traits(champ.key, role);
      return dims.filter(d => engine.atLeast(t[d].level, 'MEDIUM')).length;
    }
    return 0;
  }

  function renderPool() {
    const used = getAllUsed();
    const search = state.search.trim().toLowerCase();
    let list = CHAMPS.filter(champ => {
      if (state.filterRole !== 'all' && !champ.positions.includes(state.filterRole)) return false;
      if (!search) return true;
      return [champ.name, champ.title, champ.key, ...(champ.tags || [])]
        .join(' ').toLowerCase().includes(search);
    });
    if (state.sort !== 'name') {
      list = list.slice().sort((a, b) => champSortValue(b, state.sort) - champSortValue(a, state.sort));
    } else {
      list = list.slice().sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    const turnForPool = currentTurn();
    const openRoles = turnForPool && turnForPool.action === 'pick'
      ? ROLE_ORDER.filter(r => !state[turnForPool.side].picks[r])
      : null;
    const scrollTop = $('#poolBody')?.scrollTop || 0;
    $('#champGrid').innerHTML = list.map(champ => {
      const isUsed = used.has(champ.key);
      const canFit = !openRoles || openRoles.length === 0 || champ.positions.some(p => openRoles.includes(p));
      return `
        <button class="champ-card ${isUsed ? 'is-used' : ''} ${!isUsed && !canFit ? 'is-offrole' : ''}" data-key="${champ.key}" title="${escapeHtml(champ.name)} · ${escapeHtml(champ.title)}${!canFit ? '（不适合当前空缺位置）' : ''}">
          <img src="${champ.icon}" alt="${escapeHtml(champ.name)}" loading="lazy" />
          <span class="cc-name">${escapeHtml(champ.name)}</span>
        </button>`;
    }).join('');
    $('#poolCount').textContent = `${list.length} / ${CHAMPS.length} CHAMPIONS`;
    $('#poolEmpty').hidden = list.length > 0;

    const turn = currentTurn();
    const hint = $('#poolHint');
    if (!turn) hint.innerHTML = `BP 已完成 · 点击右上角 <b>重新开始</b> 开启下一轮`;
    else if (state.mode === 'free') hint.innerHTML = `自由模式 · 为 <b>${SIDE_META[state.freeSide].name}${state.freeAction === 'pick' ? ' · ' + ROLE_META[state.roleBySide[state.freeSide]]?.label : ' · Ban'}</b> 选择`;
    else if (turn.action === 'ban') hint.innerHTML = `<b>${SIDE_META[turn.side].name}</b> 禁用英雄 · 第 ${state[turn.side].bans.length + 1} / 5 手`;
    else hint.innerHTML = `为 <b>${SIDE_META[turn.side].name} · ${ROLE_META[state.roleBySide[turn.side]]?.label || ''}</b> 选择英雄`;

    const body = $('#poolBody');
    if (body && scrollTop) body.scrollTop = scrollTop;
  }

  // ---------- 下一手预测 ----------
  function currentSideData() {
    const turn = currentTurn();
    if (!turn) return null;
    const side = turn.side;
    const enemySide = side === 'blue' ? 'red' : 'blue';
    return { turn, side, enemySide, picks: state[side].picks, enemyPicks: state[enemySide].picks };
  }

  function predictForTurn(limit) {
    const ctx = currentSideData();
    if (!ctx || ctx.turn.action !== 'pick') return null;
    const role = state.roleBySide[ctx.side];
    if (!role || ctx.picks[role]) return null;
    const result = engine.predict({
      side: ctx.side,
      picks: ctx.picks,
      enemyPicks: ctx.enemyPicks,
      bans: [...state.blue.bans, ...state.red.bans],
      role,
      limit: limit || 5,
    });
    return { ...ctx, role, result, list: result.byRole[role] || [] };
  }

  function fitClass(fit) {
    if (!fit || fit.total == null) return 'none';
    return fit.confidence === 'HIGH' ? 'high' : fit.confidence === 'MEDIUM' ? 'mid' : 'low';
  }

  const CONF_LABEL = { HIGH: '高置信', MEDIUM: '中置信', LOW: '低置信' };

  function renderPredictStrip() {
    const strip = $('#predictStrip');
    if (!strip) return;
    const p = predictForTurn(5);
    if (!p || !p.list.length) { strip.hidden = true; return; }
    strip.hidden = false;
    strip.innerHTML = `
      <div class="pred-head">
        <span class="pred-title">下一手候选参考 · <b>${SIDE_META[p.side].name} ${ROLE_META[p.role].label}</b> <em class="unverified">未验证排序</em></span>
        <span class="pred-ver" title="适配度权重：${escapeHtml(Object.entries(p.result.weights).map(([k, v]) => `${k} ${v}`).join(' / '))}">${escapeHtml(p.result.modelVersion)}</span>
        <button class="pred-more" id="predictMore" title="查看适配度拆解">拆解 ↗</button>
      </div>
      <div class="pred-list">
        ${p.list.map(c => `
          <button class="pred-chip ${fitClass(c.fit)}" data-key="${c.key}" title="${escapeHtml(c.fit.parts.filter(x => x.points != null).map(x => `${x.label} ${x.points}/${x.weight}`).join(' · ') || '暂无可用评分项')}">
            <img src="${c.champion.icon}" alt="">
            <span class="pred-name">${escapeHtml(c.champion.name)}</span>
            <span class="pred-fit">${c.fit.total == null ? '—' : Math.round(c.fit.total)}</span>
            <span class="pred-cov">${CONF_LABEL[c.fit.confidence]} · 覆盖 ${c.fit.coverage}%</span>
            <i class="pred-bar"><b style="width:${c.fit.total == null ? 0 : clamp(c.fit.total, 0, 100)}%"></b></i>
          </button>`).join('')}
      </div>`;
    $('#predictMore').addEventListener('click', () => { renderPredictModal(); $('#predictModal').hidden = false; });
    strip.querySelectorAll('.pred-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        const champ = CHAMP_BY_KEY.get(btn.dataset.key);
        if (champ) selectChampion(champ);
      });
    });
  }

  function fitPartRow(part) {
    const pct = part.points == null ? 0 : clamp(part.points / part.weight * 100, 0, 100);
    const statusLabel = part.status === 'NEUTRAL' ? '中性' : part.status === 'NEEDS_3_PICKS' ? '需 3 人' : '未提供';
    const val = part.status === 'KNOWN'
      ? `<b>${part.points}</b><small> / ${part.weight}</small>`
      : `<span class="na">${statusLabel}</span>`;
    return `<div class="fit-part ${part.status.toLowerCase()}">
      <span class="fp-label">${escapeHtml(part.label)}</span>
      <i class="fp-bar"><b style="width:${pct}%"></b></i>
      <span class="fp-val">${val}</span>
      <span class="fp-ev">${escapeHtml((part.evidence || []).join(' · '))}</span>
    </div>`;
  }

  function renderPredictModal() {
    const grid = $('#predictGrid');
    if (!grid) return;
    const ctx = currentSideData();
    if (!ctx) { grid.innerHTML = '<div class="syn-empty">BP 已完成</div>'; return; }
    if (ctx.turn.action !== 'pick') { grid.innerHTML = '<div class="syn-empty">当前是禁用阶段，适配度预测只在选人阶段可用</div>'; return; }
    const res = engine.predict({
      side: ctx.side,
      picks: ctx.picks,
      enemyPicks: ctx.enemyPicks,
      bans: [...state.blue.bans, ...state.red.bans],
    });
    const openRoles = res.roles.filter(r => !ctx.picks[r]);
    $('#predictMeta').textContent = `${SIDE_META[ctx.side].name} · 模型 ${res.modelVersion} · 权重 ${Object.entries(res.weights).map(([k, v]) => `${k} ${v}`).join(' / ')} · 真实 BP 回测（8,848 场）：同补丁出场频率 Top5 19.2%，版本与适配项无增量 · ${engine.disclaimers.fitNotProbability}`;
    grid.innerHTML = openRoles.map(role => {
      const list = res.byRole[role] || [];
      return `<section class="cand-role">
        <div class="cand-role-head"><span>${ROLE_META[role].label}</span><i>${list.length} 个候选</i></div>
        ${list.slice(0, 6).map(c => `
          <div class="pred-card">
            <img class="cand-icon" src="${c.champion.icon}" alt="">
            <div class="pred-card-main">
              <div class="cand-title">
                <b>${escapeHtml(c.champion.name)}</b><span>${ROLE_META[role].label}</span>
                <em class="fit-badge ${fitClass(c.fit)}">参考 ${c.fit.total == null ? '—' : c.fit.total}</em>
                <em class="cov-badge">覆盖 ${c.fit.coverage}% · ${CONF_LABEL[c.fit.confidence]}</em>
              </div>
              ${c.fit.parts.map(fitPartRow).join('')}
              ${c.risks.length ? `<div class="cand-row risk"><i>风险</i>${c.risks.map(escapeHtml).join('；')}</div>` : ''}
              ${c.unknowns.length ? `<div class="cand-row unknown"><i>未知</i>${c.unknowns.map(escapeHtml).join('；')}</div>` : ''}
            </div>
          </div>`).join('')}
      </section>`;
    }).join('') || '<div class="syn-empty">没有待选位置</div>';
  }

  // ---------- analysis ----------
  function renderAnalysis() {
    const blueSt = structureOf('blue');
    const redSt = structureOf('red');
    const blueConflicts = engine.conflicts(blueSt, redSt);
    const redConflicts = engine.conflicts(redSt, blueSt);

    renderStructurePanel(blueSt, redSt, blueConflicts, redConflicts);
    renderLanePanel();
    renderPhaseCurve();
    renderEvidencePanel(blueSt, redSt);
    if ($('#chartLegend')) $('#chartLegend').innerHTML = '<span class="legend-note">胜率 / 15′ 经济差为已验证来源 · 时间强度未开放</span>';

    const verdict = $('#verdictText');
    const total = teamPickCount(state.blue) + teamPickCount(state.red);
    if (!total) {
      verdict.innerHTML = '开始选择英雄，系统会给出阵容结构缺口与体系冲突提示。';
    } else {
      const pieces = [];
      blueConflicts.slice(0, 1).forEach(c => pieces.push(`<b class="blue-t">蓝方</b> <span>${escapeHtml(c.title)}：${escapeHtml(c.reason)}</span>`));
      redConflicts.slice(0, 1).forEach(c => pieces.push(`<b class="red-t">红方</b> <span>${escapeHtml(c.title)}：${escapeHtml(c.reason)}</span>`));
      if (blueSt.gaps.length) pieces.push(`<b class="blue-t">蓝方缺口</b> <span>${escapeHtml(blueSt.gaps.slice(0, 2).map(g => g.title).join(' / '))}</span>`);
      if (redSt.gaps.length) pieces.push(`<b class="red-t">红方缺口</b> <span>${escapeHtml(redSt.gaps.slice(0, 2).map(g => g.title).join(' / '))}</span>`);
      if (!pieces.length) pieces.push(`<em>已选 ${total}/10 · 暂无可报告的结构问题（可能因为标签未审核）</em>`);
      verdict.innerHTML = pieces.join('<i class="verdict-sep">/</i>');
    }

    const summary = $('#analysisSummary');
    summary.textContent = '只展示有来源、有样本量的数据：胜率（OP.GG，口径未确认）、15 分钟经济差（职业赛 2026）、阵容结构（人工审核标签）。时间强度曲线已下线。';
  }

  function renderLegend(blueSt, redSt) {
    const items = [];
    blueSt.members.forEach((m, i) => {
      if (engine.trend(m.key, m.role).status === 'KNOWN') items.push({ side: 'blue', idx: i, m });
    });
    redSt.members.forEach((m, i) => {
      if (engine.trend(m.key, m.role).status === 'KNOWN') items.push({ side: 'red', idx: i, m });
    });
    $('#chartLegend').innerHTML = items.length
      ? items.map(it => `<span class="legend-item ${it.side}"><i class="line-swatch ${it.side}"></i>${escapeHtml(it.m.champion.name)}</span>`).join('')
      : '<span class="legend-note">尚无可用时长曲线</span>';
  }

  function seriesFor(sideName, st) {
    const out = [];
    st.members.forEach(m => {
      const t = engine.trend(m.key, m.role);
      if (t.status !== 'KNOWN') return;
      const vals = BUCKET_ORDER.map(k => {
        const b = t.buckets.find(x => x.key === k);
        if (!b || b.flag !== 'OK' || typeof b.rate !== 'number') return null;
        return Number(b.rate) - Number(b.average == null ? 50 : b.average);
      });
      out.push({ name: m.champion.name, side: sideName, vals, flagged: t.flagged.map(b => b.key) });
    });
    return out;
  }

  function renderTrendChart(blueSt, redSt) {
    const svg = $('#trendChart');
    const wrap = svg.parentElement;
    const W = Math.max(320, wrap.clientWidth || 600);
    const H = Math.max(150, (wrap.clientHeight || 200) - 6);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const series = [...seriesFor('blue', blueSt), ...seriesFor('red', redSt)];
    $('#chartEmpty').classList.toggle('hidden', series.length > 0);
    if (!series.length) { svg.innerHTML = ''; return; }

    const left = 34, right = 14, top = 12, bottom = 22;
    const innerW = W - left - right;
    const innerH = H - top - bottom;
    const all = [];
    series.forEach(s => s.vals.forEach(v => { if (typeof v === 'number') all.push(v); }));
    const maxAbs = Math.max(1.2, ...all.map(v => Math.abs(v)));
    const domain = Math.max(2, Math.ceil((maxAbs + 0.3) / 2) * 2);
    const x = i => left + (innerW * i) / (BUCKET_ORDER.length - 1);
    const y = v => top + innerH / 2 - (v / domain) * (innerH / 2);

    const colorOf = side => (side === 'blue' ? '#4c9dff' : '#ff5c6c');
    let out = '';
    // grid
    const step = domain <= 2 ? 1 : 2;
    for (let v = -domain; v <= domain + 0.001; v += step) {
      const yy = y(Number(v.toFixed(2)));
      const isZero = Math.abs(v) < 0.001;
      out += `<line x1="${left}" y1="${yy}" x2="${W - right}" y2="${yy}" stroke="${isZero ? 'rgba(201,163,91,.32)' : 'rgba(255,255,255,.06)'}" stroke-dasharray="${isZero ? '4 4' : ''}"/>`;
      out += `<text x="${left - 7}" y="${yy + 3}" text-anchor="end" fill="rgba(127,136,155,.75)" font-size="7.5" font-family="monospace">${v > 0 ? '+' : ''}${v}</text>`;
    }
    BUCKET_ORDER.forEach((k, i) => {
      out += `<text x="${x(i)}" y="${H - 6}" text-anchor="middle" fill="rgba(127,136,155,.8)" font-size="7.5" font-family="monospace">${k}</text>`;
    });
    out += `<text x="${left - 7}" y="${top + 6}" text-anchor="end" fill="rgba(201,163,91,.6)" font-size="6.5" font-family="monospace">pp</text>`;

    series.forEach((s, idx) => {
      const color = colorOf(s.side);
      const dash = s.side === 'red' ? '5 3' : (idx % 2 ? '2 2' : '');
      const segs = [];
      let cur = [];
      s.vals.forEach((v, i) => {
        if (typeof v === 'number') cur.push({ x: x(i), y: y(v), v, i });
        else { if (cur.length > 1) segs.push(cur); cur = []; }
      });
      if (cur.length > 1) segs.push(cur);

      out += `<g opacity="${s.side === 'blue' ? '.68' : '.52'}">`;
      segs.forEach(seg => {
        out += `<path d="${seg.map((p, i) => `${i ? 'L' : 'M'} ${p.x} ${p.y}`).join(' ')}" fill="none" stroke="${color}" stroke-width="1.3" stroke-linecap="round" stroke-dasharray="${dash}"/>`;
      });
      s.vals.forEach((v, i) => {
        if (typeof v !== 'number') return;
        out += `<circle cx="${x(i)}" cy="${y(v)}" r="2.4" fill="#0a0e16" stroke="${color}" stroke-width="1.4"><title>${escapeHtml(s.name)} · ${BUCKET_ORDER[i]} 分钟 · ${fmtPp(v)} pp（相对该英雄均值）</title></circle>`;
      });
      out += `</g>`;
    });
    svg.innerHTML = out;
  }

  function renderMemberTrends(blueSt, redSt) {
    const rows = [...blueSt.members.map(m => ({ side: 'blue', m })), ...redSt.members.map(m => ({ side: 'red', m }))];
    if (!rows.length) { $('#memberTrends').innerHTML = ''; return; }
    $('#memberTrends').innerHTML = rows.map(({ side, m }) => {
      const s = engine.championTrendSummary(m.key, m.role);
      if (s.status !== 'KNOWN') {
        return `<div class="mt-row ${side}"><span class="mt-name">${escapeHtml(m.champion.name)}</span><span class="mt-na">无时长统计</span></div>`;
      }
      const cell = (label, v) => `<span class="mt-cell"><i>${label}</i>${v === null ? '<em>—</em>' : fmtPp(v)}</span>`;
      return `<div class="mt-row ${side}" title="${s.partial ? `已排除时长桶：${s.excluded.join(' / ')}` : '全部时长桶可用'}">
        <span class="mt-name"><i class="mt-role">${ROLE_META[m.role].short}</i>${escapeHtml(m.champion.name)}</span>
        ${cell('前', s.early)}${cell('中', s.mid)}${cell('后', s.late)}
        ${s.partial ? `<span class="mt-flag" title="排除 ${s.excluded.join('/')}">⚑${s.excluded.length}</span>` : ''}
      </div>`;
    }).join('');
  }

  function renderEvidencePanel(blueSt, redSt) {
    const panel = $('#evidencePanel');
    if (!panel) return;
    const rows = [
      ...blueSt.members.map(m => ({ side: 'blue', m })),
      ...redSt.members.map(m => ({ side: 'red', m })),
    ];
    if (!rows.length) {
      panel.innerHTML = '<div class="ev-empty">选择英雄后，这里会列出每个英雄当前可用的数据，以及哪些指标因为未验证而不展示。</div>';
      return;
    }
    panel.innerHTML = rows.map(({ side, m }) => {
      const meta = m.meta;
      const lane = laneFor(m.key, m.role);
      const strong = engine.dims
        .filter(d => engine.atLeast(m.traits[d].level, 'STRONG'))
        .slice(0, 2)
        .map(d => (engine.dimMeta[d] || {}).label || d);
      const winLine = meta.status === 'KNOWN'
        ? `${pct(meta.winRate)} <em>${nfmt(meta.play)} 场 · 口径未确认</em>`
        : '<span class="na">源端未提供</span>';
      const laneLine = lane
        ? `${lane.gd15 > 0 ? '+' : ''}${lane.gd15} <em>职业赛 n=${lane.n} · CI ${lane.gd15_lo}~${lane.gd15_hi}</em>`
        : '<span class="na">职业赛样本不足（n&lt;20）</span>';
      return `<div class="ev-row ${side}">
        <img src="${m.champion.icon}" alt="">
        <div class="ev-main">
          <div class="ev-title"><b>${escapeHtml(m.champion.name)}</b><span>${ROLE_META[m.role].label}</span></div>
          <div class="ev-line"><i title="报告胜率与实际胜负关系很弱：职业赛 8,800 局 AUC 0.515、Q4−Q1 +1.9pp（CI 含 0）。仅作参考，不是预测。">胜率</i>${winLine}</div>
          <div class="ev-line"><i>15′经济差</i>${laneLine}</div>
          <div class="ev-line"><i>时间强度</i><span class="na">未开放（旧曲线已下线）</span></div>
          ${strong.length ? `<div class="ev-line"><i>结构标签</i>${strong.join('、')}</div>` : ''}
        </div>
      </div>`;
    }).join('');
  }

  function structureColumn(side, st) {
    const dimRows = engine.dims.map(d => {
      const stat = st.dims[d];
      const label = (engine.dimMeta[d] || {}).label || d;
      const pill = stat.reviewedCount === 0
        ? '<span class="lvl-pill unknown">未审核</span>'
        : `<span class="lvl-pill ${stat.status.toLowerCase()}">${LEVEL_LABEL[stat.status]}</span><span class="lvl-count">${stat.contributors.length}/${st.members.length}</span>`;
      return `<div class="dim-row" title="${escapeHtml((engine.dimMeta[d] || {}).check || '')}"><span class="dim-label">${label}</span>${pill}</div>`;
    }).join('');
    return `<div class="struct-col ${side}">
      <div class="struct-head"><span>${SIDE_META[side].name}结构</span><i>${st.members.length} 人</i></div>
      <div class="dim-list">${dimRows}</div>
      <div class="mix-row">伤害 <b>${escapeHtml(st.damageMix.label)}</b><i>AP ${st.damageMix.counts.AP} · AD ${st.damageMix.counts.AD}${st.damageMix.counts.BOTH ? ` · 混 ${st.damageMix.counts.BOTH}` : ''}</i></div>
      <div class="mix-row" title="关键技能冷却与操作难度：结构检查项，未纳入任何总分">操作 <b>待审核</b><i>不纳入总分</i></div>
    </div>`;
  }

  function renderStructurePanel(blueSt, redSt, blueConflicts, redConflicts) {
    const gapBlock = (side, st) => {
      if (st.gapGate === 'NEEDS_3_PICKS') return `<div class="struct-note">${SIDE_META[side].name}：需要至少 3 名英雄后才评估结构缺口</div>`;
      if (!st.gaps.length) return `<div class="struct-note ok">${SIDE_META[side].name}：未发现结构性缺口</div>`;
      return st.gaps.map(g => `<div class="gap-line ${g.severity.toLowerCase()}">
        <b>${escapeHtml(g.title)}</b>
        <span>${escapeHtml(g.detail)}</span>
        <i>${g.severity} · ${g.reviewedPatch} · ${g.reviewStatus}</i>
      </div>`).join('');
    };
    const conflictBlock = list => list.length
      ? list.map(c => `<div class="conflict-line ${c.severity.toLowerCase()}">
          <b>${escapeHtml(c.title)}</b>
          <span>${escapeHtml(c.reason)}</span>
          <i>反例：${escapeHtml(c.counterexample)}</i>
        </div>`).join('')
      : '<div class="struct-note">暂无体系冲突提示</div>';

    $('#structurePanel').innerHTML = `
      <div class="struct-cols">${structureColumn('blue', blueSt)}${structureColumn('red', redSt)}</div>
      <div class="struct-section">
        <div class="struct-caption">结构缺口 <i>规则 ${escapeHtml(engine.rules.meta?.ruleVersion || '')}</i></div>
        ${gapBlock('blue', blueSt)}${gapBlock('red', redSt)}
      </div>
      <div class="struct-section">
        <div class="struct-caption">体系相克提示 <i>机制解释，不是胜率</i></div>
        ${conflictBlock([...blueConflicts, ...redConflicts])}
      </div>`;
  }

  // ---------- modals ----------
  function renderSynergyModal() {
    const grid = $('#synergyGrid');
    const sides = ['blue', 'red'].map(side => ({ side, team: state[side] }));
    grid.innerHTML = sides.map(({ side, team }) => {
      const entries = ROLE_ORDER.filter(r => team.picks[r]).map(r => ({ role: r, key: team.picks[r], champ: CHAMP_BY_KEY.get(team.picks[r]) }));
      let rows = [];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = entries[i], b = entries[j];
          rows.push({ a, b, data: engine.synergy(a.key, a.role, b.key, b.role) });
        }
      }
      const known = rows.filter(r => r.data.status === 'KNOWN');
      let content;
      if (entries.length < 2) {
        content = `<div class="syn-empty">至少选择 2 名英雄后生成双人协同分析</div>`;
      } else {
        content = `<div class="syn-list">${rows.map(r => {
          const d = r.data;
          const a = r.a.champ, b = r.b.champ;
          if (d.status !== 'KNOWN') {
            return `<div class="syn-pair unknown">
              <div class="syn-avatars"><img src="${a.icon}" alt=""><img src="${b.icon}" alt=""></div>
              <div class="syn-pair-main"><div class="syn-pair-names">${escapeHtml(a.name)} <span>+</span> ${escapeHtml(b.name)}</div>
              <div class="syn-pair-meta">${ROLE_META[r.a.role].label} × ${ROLE_META[r.b.role].label} · <em>未提供</em>${d.note ? ` · ${escapeHtml(d.note)}` : ''}</div></div>
              <div class="syn-pair-bar"><i style="width:0"></i></div>
              <div class="syn-pair-val"><span class="na">未提供</span></div>
            </div>`;
          }
          const wr = Number(d.winRate);
          return `<div class="syn-pair ${wr >= 50 ? 'pos' : 'neg'}">
            <div class="syn-avatars"><img src="${a.icon}" alt=""><img src="${b.icon}" alt=""></div>
            <div class="syn-pair-main"><div class="syn-pair-names">${escapeHtml(a.name)} <span>+</span> ${escapeHtml(b.name)}</div>
            <div class="syn-pair-meta">${ROLE_META[r.a.role].label} × ${ROLE_META[r.b.role].label} · ${nfmt(d.play)} 场${d.lowSample ? ' · 样本较少' : ''}${d.perspective === 'REVERSED' ? ' · 反向记录' : ''}</div></div>
            <div class="syn-pair-bar"><i style="width:${clamp(Math.abs(wr - 50) / 10 * 100, 0, 100)}%"></i></div>
            <div class="syn-pair-val">${pct(wr)}</div>
          </div>`;
        }).join('')}</div>
        <div class="syn-foot">已知 ${known.length} / ${rows.length} 组 · 组合表现是单独一张统计卡，不会加到任何“阵容胜率”上</div>`;
      }
      return `<section class="syn-side ${side}">
        <div class="syn-side-head">
          <div><span class="team-kicker">${SIDE_META[side].name.toUpperCase()} PAIRS</span><h3>${SIDE_META[side].name}协同</h3></div>
          <div class="syn-score neutral">${known.length}<small> / ${rows.length}</small></div>
        </div>
        ${content}
      </section>`;
    }).join('');
    $('#synergyMeta').textContent = '来源：OP.GG 官方 MCP · 口径未确认（响应未返回地区/段位）· 缺失组合显示“未提供”，不回退位置、不加成';
  }

  function renderCounterModal() {
    const rows = ROLE_ORDER.map(role => {
      const b = state.blue.picks[role] ? CHAMP_BY_KEY.get(state.blue.picks[role]) : null;
      const r = state.red.picks[role] ? CHAMP_BY_KEY.get(state.red.picks[role]) : null;
      const info = b && r ? engine.counter(b.key, role, r.key) : null;
      return { role, b, r, info };
    });
    const known = rows.filter(x => x.info && x.info.status === 'KNOWN');
    $('#counterMeta').textContent = `来源：OP.GG 官方 MCP · 口径未确认 · 同路 ${known.length} / 5 有记录 · 方向以蓝方视角显示，反向记录会标注`;
    $('#counterGrid').innerHTML = rows.map(({ role, b, r, info }) => {
      const side = (champ, empty) => champ
        ? `<div class="matchup-side"><img src="${champ.icon}" alt=""><div><span class="matchup-role">${ROLE_META[role].label}</span><b>${escapeHtml(champ.name)}</b></div></div>`
        : `<div class="matchup-side empty"><span class="matchup-role">${ROLE_META[role].label}</span><span class="matchup-missing">待选择</span></div>`;
      let mid;
      if (!b || !r) mid = '<span class="matchup-missing">未选齐</span>';
      else if (info.status !== 'KNOWN') mid = `<span class="matchup-missing">未提供</span>`;
      else {
        const cls = info.ourWinRate > 52 ? 'blue-edge' : info.ourWinRate < 48 ? 'red-edge' : 'even';
        mid = `<div class="matchup-delta ${cls}">${pct(info.ourWinRate)}<small>蓝方胜率 · ${nfmt(info.play)} 场${info.perspective === 'REVERSED' ? ' · 反向' : ''}</small></div>`;
      }
      return `<div class="matchup-row">${side(b)}${mid}${side(r)}</div>`;
    }).join('');
  }

  function candidateCard(c, gapLabelOf) {
    const layers = c.layers;
    const gapText = c.fillsGaps.length
      ? c.fillsGaps.map(d => gapLabelOf(d)).join('、')
      : '无';
    const metaText = c.meta.status === 'KNOWN'
      ? `梯队 ${c.meta.tier ?? '—'} · 排名 ${c.meta.rank ?? '—'} · 胜率 ${pct(c.meta.winRate)} · ${nfmt(c.meta.play)} 场`
      : '源端未提供该分路统计';
    const comboText = c.combos.length
      ? c.combos.map(x => `与 ${escapeHtml(x.partner.key ? (CHAMP_BY_KEY.get(x.partner.key)?.name || x.partner.key) : '')}（${ROLE_META[x.partner.role].label}）${pct(x.data.winRate)} / ${nfmt(x.data.play)} 场`).join('；')
      : '无已知协同记录';
    const counterText = !c.counter
      ? '敌方该位置未锁定'
      : c.counter.status === 'KNOWN'
        ? `同路 ${pct(c.counter.ourWinRate)}（${nfmt(c.counter.play)} 场${c.counter.perspective === 'REVERSED' ? ' · 反向记录' : ''}）`
        : '未提供同路对位';
    return `<div class="cand-card">
      <img class="cand-icon" src="${c.champion.icon}" alt="">
      <div class="cand-main">
        <div class="cand-title"><b>${escapeHtml(c.champion.name)}</b><span>${ROLE_META[c.role].label}</span></div>
        <div class="cand-row"><i>补位</i>${escapeHtml(gapText)}</div>
        <div class="cand-row"><i>统计</i>${escapeHtml(metaText)}<em class="cohort">口径未确认</em></div>
        <div class="cand-row"><i>协同</i>${comboText}</div>
        <div class="cand-row"><i>对位</i>${escapeHtml(counterText)}</div>
        ${c.risks.length ? `<div class="cand-row risk"><i>风险</i>${c.risks.map(escapeHtml).join('；')}</div>` : ''}
        ${c.unknowns.length ? `<div class="cand-row unknown"><i>未知</i>${c.unknowns.map(escapeHtml).join('；')}</div>` : ''}
        <div class="cand-layers">${Object.entries(layers).map(([k, v]) => `<span class="lay lay-${k.toLowerCase()}">${k}: ${escapeHtml(String(v))}</span>`).join('')}</div>
      </div>
    </div>`;
  }

  function renderCandidateModal() {
    const turn = currentTurn();
    const side = turn ? turn.side : 'blue';
    const enemySide = side === 'blue' ? 'red' : 'blue';
    const result = engine.candidates({
      side,
      picks: state[side].picks,
      enemyPicks: state[enemySide].picks,
      bans: [...state.blue.bans, ...state.red.bans],
    });
    const gapLabelOf = dim => {
      const g = result.gaps.find(x => x.dimension === dim);
      return g ? g.title : ((engine.dimMeta[dim] || {}).label || dim);
    };
    const openRoles = ROLE_ORDER.filter(r => !state[side].picks[r]);
    $('#candidateMeta').textContent = `${SIDE_META[side].name}待选 · ${result.layerNote} · ${engine.disclaimers.noPrediction}`;
    $('#candidateGrid').innerHTML = openRoles.length
      ? openRoles.map(role => {
          const list = result.roles[role] || [];
          const head = `<div class="cand-role-head"><span>${ROLE_META[role].label}</span><i>${list.length} 个候选</i></div>`;
          return `<section class="cand-role">${head}${list.length ? list.map(c => candidateCard(c, gapLabelOf)).join('') : '<div class="syn-empty">没有可用候选</div>'}</section>`;
        }).join('')
      : '<div class="syn-empty">双方阵容已满，没有待选位置</div>';
  }

  // ---------- popover ----------
  function showPopover(champ, evt) {
    const pop = $('#champPopover');
    const role = champ.positions[0] || 'top';
    const m = engine.meta(champ.key, role);
    const tr = engine.traits(champ.key, role);
    const lane = laneFor(champ.key, role);
    const strong = engine.dims.filter(d => engine.atLeast(tr[d].level, 'STRONG'));
    const weakDims = engine.dims.filter(d => tr[d].level === 'WEAK');
    const unreviewed = engine.dims.filter(d => !engine.isReviewed(tr[d]));
    pop.innerHTML = `
      <div class="cp-head">
        <img src="${champ.icon}" alt="">
        <div><b>${escapeHtml(champ.name)}</b><small>${escapeHtml(champ.title)} · ${champ.positions.map(r => ROLE_META[r]?.label || r).join('/')}</small></div>
      </div>
      <div class="cp-stats">
        ${m.status === 'KNOWN'
          ? `<span>胜率 <b>${pct(m.winRate)}</b></span><span>选取 <b>${pct(m.pickRate)}</b></span><span>禁用 <b>${pct(m.banRate)}</b></span><span>梯队 <b>${m.tier ?? '—'}</b></span><span>场次 <b>${nfmt(m.play)}</b></span>`
          : '<span class="na">该分路无官方统计</span>'}
      </div>
      <div class="cp-note">时间强度曲线已下线（校验未通过）</div>
      <div class="cp-lane">${lane
        ? `15′ 经济差 <b>${lane.gd15 > 0 ? '+' : ''}${lane.gd15}</b><small>职业赛 n=${lane.n}</small>`
        : '<span class="na">无职业赛样本</span>'}</div>
      <div class="cp-tags">
        ${strong.length ? strong.map(d => `<span class="t-strong">强 ${(engine.dimMeta[d] || {}).label || d}</span>`).join('') : ''}
        ${weakDims.slice(0, 3).map(d => `<span class="t-weak">弱 ${(engine.dimMeta[d] || {}).label || d}</span>`).join('')}
        ${unreviewed.length ? `<span class="t-na">未审核 ${unreviewed.length} 维</span>` : ''}
      </div>
      <div class="cp-src">${m.status === 'KNOWN' ? '来源 OP.GG 官方 MCP · 口径未确认 · ' + escapeHtml(m.retrievedAt || '') : '无来源数据'}</div>`;
    pop.hidden = false;
    const rect = pop.getBoundingClientRect();
    let px = evt.clientX + 14;
    let py = evt.clientY + 14;
    if (px + rect.width > window.innerWidth - 12) px = evt.clientX - rect.width - 14;
    if (py + rect.height > window.innerHeight - 12) py = evt.clientY - rect.height - 14;
    pop.style.left = `${Math.max(8, px)}px`;
    pop.style.top = `${Math.max(8, py)}px`;
  }
  function hidePopover() { $('#champPopover').hidden = true; }

  // ---------- events ----------
  function bindEvents() {
    $('#modeBtn').addEventListener('click', () => setMode(state.mode === 'standard' ? 'free' : 'standard'));
    $('#synergyBtn').addEventListener('click', () => { renderSynergyModal(); $('#synergyModal').hidden = false; });
    $('#synergyClose').addEventListener('click', () => { $('#synergyModal').hidden = true; });
    $('#synergyModal').addEventListener('click', e => { if (e.target.id === 'synergyModal') $('#synergyModal').hidden = true; });
    $('#counterBtn').addEventListener('click', () => { renderCounterModal(); $('#counterModal').hidden = false; });
    $('#counterClose').addEventListener('click', () => { $('#counterModal').hidden = true; });
    $('#counterModal').addEventListener('click', e => { if (e.target.id === 'counterModal') $('#counterModal').hidden = true; });
    $('#predictBtn').addEventListener('click', () => { renderPredictModal(); $('#predictModal').hidden = false; });
    $('#predictClose').addEventListener('click', () => { $('#predictModal').hidden = true; });
    $('#predictModal').addEventListener('click', e => { if (e.target.id === 'predictModal') $('#predictModal').hidden = true; });
    $('#candidateBtn').addEventListener('click', () => { renderCandidateModal(); $('#candidateModal').hidden = false; });
    $('#candidateClose').addEventListener('click', () => { $('#candidateModal').hidden = true; });
    $('#candidateModal').addEventListener('click', e => { if (e.target.id === 'candidateModal') $('#candidateModal').hidden = true; });
    $('#undoBtn').addEventListener('click', undo);
    $('#resetBtn').addEventListener('click', () => resetDraft(false));
    $('#searchInput').addEventListener('input', e => { state.search = e.target.value; renderPool(); });
    $('#sortSelect').addEventListener('change', e => { state.sort = e.target.value; renderPool(); });
    $('#roleFilters').addEventListener('click', e => {
      const btn = e.target.closest('.filter-chip');
      if (!btn) return;
      state.filterRole = btn.dataset.role;
      $$('#roleFilters .filter-chip').forEach(x => x.classList.toggle('active', x === btn));
      renderPool();
    });

    ['blue', 'red'].forEach(side => {
      $(`#${side}Roles`).addEventListener('click', e => {
        const row = e.target.closest('.role-row');
        if (!row) return;
        const role = row.dataset.role;
        if (state.mode === 'free') {
          state.freeSide = side;
          state.freeAction = 'pick';
          state.roleBySide[side] = role;
          state.activeRole = role;
          renderAll();
          return;
        }
        const turn = currentTurn();
        if (!turn) return;
        if (turn.side !== side) { toast(`现在轮到${SIDE_META[turn.side].name}`); return; }
        if (turn.action !== 'pick') { toast('当前是禁用阶段'); return; }
        state.roleBySide[side] = role;
        state.activeRole = role;
        renderAll();
      });
      $(`#${side}Bans`).addEventListener('click', () => {
        if (state.mode === 'free') { state.freeSide = side; state.freeAction = 'ban'; renderAll(); }
      });
      $(`#${side}Panel`).querySelector('.team-head').addEventListener('click', () => {
        if (state.mode === 'free') { state.freeSide = side; renderAll(); }
      });
    });

    $('#champGrid').addEventListener('click', e => {
      const card = e.target.closest('.champ-card');
      if (!card) return;
      if (card.classList.contains('is-used')) return;
      if (card.classList.contains('is-offrole')) { toast('该英雄不适合当前空缺位置，请选择其他分路英雄'); return; }
      const champ = CHAMP_BY_KEY.get(card.dataset.key);
      if (champ) selectChampion(champ);
    });
    $('#champGrid').addEventListener('pointerover', e => {
      const card = e.target.closest('.champ-card');
      if (!card) return;
      const champ = CHAMP_BY_KEY.get(card.dataset.key);
      if (champ) showPopover(champ, e);
    });
    $('#champGrid').addEventListener('pointerout', e => {
      if (e.target.closest('.champ-card')) hidePopover();
    });
    $('#champGrid').addEventListener('pointermove', e => {
      const card = e.target.closest('.champ-card');
      const pop = $('#champPopover');
      if (!card || pop.hidden) return;
      const rect = pop.getBoundingClientRect();
      let px = e.clientX + 14, py = e.clientY + 14;
      if (px + rect.width > window.innerWidth - 12) px = e.clientX - rect.width - 14;
      if (py + rect.height > window.innerHeight - 12) py = e.clientY - rect.height - 14;
      pop.style.left = `${Math.max(8, px)}px`;
      pop.style.top = `${Math.max(8, py)}px`;
    });

    const freeBar = $('#freeBar');
    if (freeBar) {
      freeBar.addEventListener('click', e => {
        const sideBtn = e.target.closest('[data-side]');
        const actionBtn = e.target.closest('[data-action]');
        if (sideBtn) { state.freeSide = sideBtn.dataset.side; renderAll(); }
        if (actionBtn) { state.freeAction = actionBtn.dataset.action; renderAll(); }
      });
    }

    document.addEventListener('keydown', e => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
      if (e.key === '/' && document.activeElement !== $('#searchInput')) { e.preventDefault(); $('#searchInput').focus(); }
      if (e.key === 'Escape') {
        hidePopover();
        $('#synergyModal').hidden = true;
        $('#counterModal').hidden = true;
        $('#candidateModal').hidden = true;
        $('#predictModal').hidden = true;
        $('#searchInput').blur();
      }
    });

    window.addEventListener('resize', () => renderAnalysis());
  }

  // ---------- init ----------
  function init() {
    const meta = CONTRACT.meta || {};
    const patch = meta.patch || {};
    $('#patchLabel').textContent = patch.label || '16.22';
    $('#patchChip').title = `Data Dragon ${patch.ddragon || '—'} · 官方补丁 ${patch.officialPatch || '—'}（两者版本号不同，不可混用）`;
    const mcp = engine.sourceInfo('OPGG_MCP') || {};
    $('#cohortChip').title = engine.disclaimers.cohortUnknown + `\nMCP 响应：${mcp.cohortNote || '未说明'}`;
    $('#sourceChip').title = `抓取时间 ${mcp.retrievedAt || '—'}\n字段语义：${mcp.fieldSemanticsStatus || 'UNVERIFIED'}`;
    $('#traitChip').textContent = `标签 ${meta.traitReviewedCount ?? 0}/${meta.traitLabelCount ?? 0}`;
    $('#traitChip').title = `已审核 ${meta.traitReviewedCount ?? 0} 维 · 未审核 ${meta.traitUnreviewedCount ?? 0} 维（未审核不会当作中性值）`;
    bindEvents();
    renderAll();
    refreshLive();
    setInterval(refreshLive, 20000);
  }

  init();
})();
