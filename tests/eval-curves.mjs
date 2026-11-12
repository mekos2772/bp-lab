#!/usr/bin/env node
/**
 * BP LAB · 曲线与胜率的离线校验
 *
 * 问题：我们展示给用户的"英雄胜率"和"最终比赛时长条件胜率曲线"到底有没有信息量？
 * 数据：真实对局（韩服高端排位 / 职业比赛），每条记录 = 一个英雄-分路-这局时长-胜负。
 *
 * 做四件事：
 *   A. 胜率校验：OP.GG 报告的分路胜率 vs 真实样本胜率（相关、MAE、方向一致率）
 *   B. 曲线斜率：英雄曲线的"偏后期"程度 vs 真实"长局胜率 - 短局胜率"
 *   C. 队伍合成：同队 5 人曲线均值 vs 长局/短局胜率（检验能否把个体曲线加总）
 *   D. 分桶校准：每个 (英雄,分路,时长桶) 单元里，预测偏差 vs 真实胜率
 *
 * 用法：
 *   node tests/eval-curves.mjs                     # 只看排位库
 *   node tests/eval-curves.mjs --pro data/pro_matches.sqlite   # 额外跑职业库
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const contract = JSON.parse(readFileSync(join(root, 'data/bp_contract.json'), 'utf8'));
const ddragon = JSON.parse(readFileSync(join(root, 'data/ddragon_champion_index.json'), 'utf8'));
const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
const BUCKETS = [
  { key: '<25', min: 0, max: 25 },
  { key: '25-30', min: 25, max: 30 },
  { key: '30-35', min: 30, max: 35 },
  { key: '35-40', min: 35, max: 40 },
  { key: '40+', min: 40, max: 999 },
];
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- 英雄映射 ----------
const byNorm = new Map();
for (const [key, champ] of Object.entries(contract.champions)) {
  byNorm.set(norm(champ.ddragonId || key), key);
  byNorm.set(norm(key), key);
}
function mapChampion(championId, storedKey) {
  const entry = ddragon[String(championId)];
  if (entry) {
    const hit = byNorm.get(norm(entry.ddragonId));
    if (hit) return hit;
  }
  return byNorm.get(norm(storedKey)) || null;
}
function bucketOf(minutes) {
  return BUCKETS.find(b => minutes >= b.min && minutes < b.max) || null;
}

// ---------- 统计工具 ----------
const Z = 1.96;
function wilson(wins, n) {
  if (!n) return [0, 0, 0];
  const p = wins / n;
  const denom = 1 + (Z * Z) / n;
  const center = (p + (Z * Z) / (2 * n)) / denom;
  const margin = (Z * Math.sqrt((p * (1 - p)) / n + (Z * Z) / (4 * n * n))) / denom;
  return [p, Math.max(0, center - margin), Math.min(1, center + margin)];
}
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (!dx || !dy) return null;
  return num / Math.sqrt(dx * dy);
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// ---------- 合约侧：报告胜率与曲线 ----------
function champRole(key, role) {
  const champ = contract.champions[key];
  if (!champ || !champ.roles || !champ.roles[role]) return null;
  return champ.roles[role];
}

function curveDeltas(key, role) {
  const rd = champRole(key, role);
  if (!rd || !rd.trend) return null;
  const map = {};
  for (const b of rd.trend.buckets) {
    map[b.key] = b.flag === 'OK' && typeof b.rate === 'number'
      ? Number(b.rate) - Number(b.average == null ? 50 : b.average)
      : null;
  }
  return map;
}

function lateLean(key, role) {
  const map = curveDeltas(key, role);
  if (!map) return null;
  const late = ['35-40', '40+'].map(k => map[k]).filter(v => v != null);
  const early = ['<25', '25-30'].map(k => map[k]).filter(v => v != null);
  if (!late.length || !early.length) return null;
  return mean(late) - mean(early);
}

// ---------- 载入数据集 ----------
function loadRanked(path, since) {
  const db = new DatabaseSync(path);
  const games = new Map();
  const rowsGames = since
    ? db.prepare('SELECT game_id, duration_s, blue_win FROM matches WHERE created_at >= ?').all(since)
    : db.prepare('SELECT game_id, duration_s, blue_win FROM matches').all();
  for (const g of rowsGames) {
    games.set(g.game_id, { id: g.game_id, durationMin: g.duration_s / 60, blueWin: g.blue_win, players: [] });
  }
  const rows = db.prepare('SELECT game_id, side, position, champion_id, champion_key, win FROM players').all();
  let mapped = 0, unmapped = 0;
  for (const p of rows) {
    const game = games.get(p.game_id);
    if (!game) continue;
    const key = mapChampion(p.champion_id, p.champion_key);
    if (!key) { unmapped += 1; continue; }
    mapped += 1;
    game.players.push({ side: p.side === 'BLUE' ? 'blue' : 'red', role: p.position, key, win: p.win });
  }
  return {
    label: since ? `韩服高端排位（${since} 起）` : '韩服高端排位',
    path,
    games: [...games.values()].filter(g => g.players.length === 10),
    mapped, unmapped,
  };
}

// 职业库结构：games(game_id, duration_s, winner_side), players(game_id, side, position, champion_key, champion_name)
function loadPro(path, tierFilter, patchFilter) {
  const db = new DatabaseSync(path);
  const games = new Map();
  const tiers = tierFilter ? tierFilter.split(',').map(t => t.trim().toUpperCase()).filter(Boolean) : null;
  const where = [];
  const params = [];
  if (tiers) { where.push(`tier IN (${tiers.map(() => '?').join(',')})`); params.push(...tiers); }
  if (patchFilter) {
    const patches = patchFilter.split(',').map(x => x.trim()).filter(Boolean);
    if (patches.length === 1) { where.push('patch = ?'); params.push(patches[0]); }
    else { where.push(`patch IN (${patches.map(() => '?').join(',')})`); params.push(...patches); }
  }
  const sql = 'SELECT game_id, duration_s, winner_side FROM games' + (where.length ? ` WHERE ${where.join(' AND ')}` : '');
  const gameRows = db.prepare(sql).all(...params);
  for (const g of gameRows) {
    games.set(g.game_id, { id: g.game_id, durationMin: g.duration_s / 60, winnerSide: g.winner_side, players: [] });
  }
  const rows = db.prepare('SELECT game_id, side, position, champion_key, champion_name FROM players').all();
  for (const p of rows) {
    const game = games.get(p.game_id);
    if (!game) continue;
    const key = mapChampion(p.champion_key ?? p.champion_name, p.champion_name);
    if (!key) continue;
    const win = game.winnerSide ? (p.side === game.winnerSide ? 1 : 0) : null;
    game.players.push({ side: p.side, role: p.position, key, win });
  }
  const label = `职业比赛${patchFilter ? `（patch ${patchFilter}` : '（'}${tiers ? ` · ${tiers.join('/')}` : ' · 全部'}）`;
  return { label, path, games: [...games.values()].filter(g => g.players.length === 10), mapped: rows.length, unmapped: 0 };
}

// ---------- 分析 ----------
function analyze(dataset) {
  const records = [];
  for (const g of dataset.games) {
    const b = bucketOf(g.durationMin);
    if (!b) continue;
    for (const p of g.players) {
      if (p.win == null) continue;
      records.push({ key: p.key, role: p.role, bucket: b.key, durationMin: g.durationMin, win: p.win, side: p.side, gameId: g.id });
    }
  }

  // A. 胜率校验
  const byChampRole = new Map();
  for (const r of records) {
    const id = `${r.key}|${r.role}`;
    if (!byChampRole.has(id)) byChampRole.set(id, { key: r.key, role: r.role, n: 0, wins: 0, buckets: {} });
    const s = byChampRole.get(id);
    s.n += 1; s.wins += r.win;
    if (!s.buckets[r.bucket]) s.buckets[r.bucket] = { n: 0, wins: 0 };
    s.buckets[r.bucket].n += 1; s.buckets[r.bucket].wins += r.win;
  }
  const pairs = [];
  for (const s of byChampRole.values()) {
    const rd = champRole(s.key, s.role);
    if (!rd || !rd.meta || typeof rd.meta.winRate !== 'number') continue;
    if (s.n < 20) continue;
    const [p, lo, hi] = wilson(s.wins, s.n);
    pairs.push({ key: s.key, role: s.role, n: s.n, reported: rd.meta.winRate, actual: p * 100, lo: lo * 100, hi: hi * 100, delta: p * 100 - rd.meta.winRate });
  }
  const corrWin = pearson(pairs.map(p => p.reported), pairs.map(p => p.actual));
  const maeWin = mean(pairs.map(p => Math.abs(p.delta)));
  const signAgree = pairs.length ? pairs.filter(p => Math.sign(p.reported - 50) === Math.sign(p.actual - 50)).length / pairs.length : null;

  // B. 曲线斜率
  const slopeRows = [];
  for (const s of byChampRole.values()) {
    const lean = lateLean(s.key, s.role);
    if (lean == null) continue;
    const short = Object.entries(s.buckets).filter(([k]) => k === '<25' || k === '25-30').reduce((a, [, v]) => ({ n: a.n + v.n, wins: a.wins + v.wins }), { n: 0, wins: 0 });
    const long = Object.entries(s.buckets).filter(([k]) => k === '35-40' || k === '40+').reduce((a, [, v]) => ({ n: a.n + v.n, wins: a.wins + v.wins }), { n: 0, wins: 0 });
    if (short.n < 5 || long.n < 5) continue;
    const shortRate = (short.wins / short.n) * 100;
    const longRate = (long.wins / long.n) * 100;
    slopeRows.push({ key: s.key, role: s.role, lean, shortN: short.n, longN: long.n, shortRate, longRate, slope: longRate - shortRate });
  }
  const corrSlope = pearson(slopeRows.map(r => r.lean), slopeRows.map(r => r.slope));
  const weightedSlopeCorr = (() => {
    if (!slopeRows.length) return null;
    const totalW = slopeRows.reduce((a, r) => a + Math.min(r.shortN, r.longN), 0);
    const mx = slopeRows.reduce((a, r) => a + r.lean * Math.min(r.shortN, r.longN), 0) / totalW;
    const my = slopeRows.reduce((a, r) => a + r.slope * Math.min(r.shortN, r.longN), 0) / totalW;
    let num = 0, dx = 0, dy = 0;
    for (const r of slopeRows) {
      const w = Math.min(r.shortN, r.longN);
      const a = (r.lean - mx) * Math.sqrt(w), b = (r.slope - my) * Math.sqrt(w);
      num += a * b; dx += a * a; dy += b * b;
    }
    return dx && dy ? num / Math.sqrt(dx * dy) : null;
  })();

  // C. 队伍合成：长局看"更偏后期"的队是否赢更多
  const teamRows = [];
  for (const g of dataset.games) {
    if (g.durationMin < 25 || g.durationMin >= 40) continue;
    const sides = { blue: [], red: [] };
    for (const p of g.players) {
      const lean = lateLean(p.key, p.role);
      if (lean != null) sides[p.side].push(lean);
    }
    if (sides.blue.length < 3 || sides.red.length < 3) continue;
    const bLean = mean(sides.blue), rLean = mean(sides.red);
    if (bLean === rLean) continue;
    const winner = g.blueWin != null ? (g.blueWin ? 'blue' : 'red') : g.winnerSide;
    if (!winner) continue;
    const moreLate = bLean > rLean ? 'blue' : 'red';
    const longGame = g.durationMin >= 35;
    teamRows.push({ longGame, moreLate, winner, agree: moreLate === winner });
  }
  const longTeam = teamRows.filter(r => r.longGame);
  const shortTeam = teamRows.filter(r => !r.longGame);
  const teamTest = {
    long: { n: longTeam.length, hit: longTeam.filter(r => r.agree).length },
    short: { n: shortTeam.length, hit: shortTeam.filter(r => r.agree).length },
  };

  // D. 分桶校准
  const cells = [];
  for (const s of byChampRole.values()) {
    const deltas = curveDeltas(s.key, s.role);
    if (!deltas) continue;
    for (const [bucketKey, v] of Object.entries(s.buckets)) {
      if (v.n < 10) continue;
      if (deltas[bucketKey] == null) continue;
      cells.push({ key: s.key, role: s.role, bucket: bucketKey, n: v.n, predicted: deltas[bucketKey], actual: (v.wins / v.n) * 100 - 50 });
    }
  }
  const corrBucket = pearson(cells.map(c => c.predicted), cells.map(c => c.actual));

  // A2. 报告的胜率分位 → 实际胜率（分组降低单英雄噪声）
  const wrPairs = [];
  for (const s of byChampRole.values()) {
    const rd = champRole(s.key, s.role);
    if (!rd || !rd.meta || typeof rd.meta.winRate !== 'number' || s.n < 10) continue;
    wrPairs.push({ reported: rd.meta.winRate, n: s.n, wins: s.wins });
  }
  wrPairs.sort((a, b) => a.reported - b.reported);
  const quartiles = [];
  if (wrPairs.length >= 8) {
    const q = Math.floor(wrPairs.length / 4);
    for (let i = 0; i < 4; i++) {
      const seg = wrPairs.slice(i * q, i === 3 ? wrPairs.length : (i + 1) * q);
      const n = seg.reduce((a, x) => a + x.n, 0);
      const wins = seg.reduce((a, x) => a + x.wins, 0);
      const [p, lo, hi] = wilson(wins, n);
      quartiles.push({
        reportedRange: [seg[0].reported, seg[seg.length - 1].reported],
        n, actual: Number((p * 100).toFixed(1)), ci: [Number((lo * 100).toFixed(1)), Number((hi * 100).toFixed(1))],
      });
    }
  }

  // B2. 曲线偏后期三分位 → 真实长短局胜率
  const terciles = [];
  const slopeGroups = slopeRows.slice().sort((a, b) => a.lean - b.lean);
  if (slopeGroups.length >= 6) {
    const t = Math.floor(slopeGroups.length / 3);
    for (let i = 0; i < 3; i++) {
      const seg = slopeGroups.slice(i * t, i === 2 ? slopeGroups.length : (i + 1) * t);
      const shortN = seg.reduce((a, r) => a + r.shortN, 0);
      const longN = seg.reduce((a, r) => a + r.longN, 0);
      const shortW = seg.reduce((a, r) => a + r.shortRate * r.shortN, 0) / 100;
      const longW = seg.reduce((a, r) => a + r.longRate * r.longN, 0) / 100;
      const [sp, slo, shi] = wilson(shortW, shortN);
      const [lp, llo, lhi] = wilson(longW, longN);
      terciles.push({
        leanRange: [Number(seg[0].lean.toFixed(2)), Number(seg[seg.length - 1].lean.toFixed(2))],
        shortN, longN,
        shortRate: Number((sp * 100).toFixed(1)), longRate: Number((lp * 100).toFixed(1)),
        shortCi: [Number((slo * 100).toFixed(1)), Number((shi * 100).toFixed(1))],
        longCi: [Number((llo * 100).toFixed(1)), Number((lhi * 100).toFixed(1))],
        slope: Number(((lp - sp) * 100).toFixed(1)),
      });
    }
  }

  // D2. 预测偏差分组 → 实际偏差
  const deltaBins = [
    { label: '< -2pp', test: v => v < -2 },
    { label: '-2 ~ 0', test: v => v >= -2 && v < 0 },
    { label: '0 ~ +2', test: v => v >= 0 && v < 2 },
    { label: '>= +2pp', test: v => v >= 2 },
  ].map(b => {
    const cellsIn = cells.filter(c => b.test(c.predicted));
    const n = cellsIn.reduce((a, c) => a + c.n, 0);
    const wins = cellsIn.reduce((a, c) => a + (c.actual + 50) / 100 * c.n, 0);
    const [p, lo, hi] = wilson(wins, n);
    return { label: b.label, cells: cellsIn.length, n, actualDelta: Number(((p - 0.5) * 100).toFixed(2)), ci: [Number(((lo - 0.5) * 100).toFixed(2)), Number(((hi - 0.5) * 100).toFixed(2))] };
  });

  const [teamLongP, teamLongLo, teamLongHi] = wilson(teamTest.long.hit, teamTest.long.n);
  const [teamShortP, teamShortLo, teamShortHi] = wilson(teamTest.short.hit, teamTest.short.n);

  return {
    label: dataset.label,
    games: dataset.games.length,
    playerGames: records.length,
    champRoles: byChampRole.size,
    winRateCheck: {
      quartiles,
      pairs: pairs.length,
      corr: corrWin == null ? null : Number(corrWin.toFixed(3)),
      mae: maeWin == null ? null : Number(maeWin.toFixed(2)),
      signAgree: signAgree == null ? null : Number((signAgree * 100).toFixed(1)),
      examples: pairs.sort((a, b) => b.n - a.n).slice(0, 8),
    },
    curveSlopeCheck: {
      terciles,
      pairs: slopeRows.length,
      corr: corrSlope == null ? null : Number(corrSlope.toFixed(3)),
      weightedCorr: weightedSlopeCorr == null ? null : Number(weightedSlopeCorr.toFixed(3)),
      rows: slopeRows.sort((a, b) => b.shortN + b.longN - (a.shortN + a.longN)).slice(0, 12),
    },
    teamCurveTest: {
      long: { n: teamTest.long.n, hitRate: Number((teamLongP * 100).toFixed(1)), ci: [Number((teamLongLo * 100).toFixed(1)), Number((teamLongHi * 100).toFixed(1))] },
      short: { n: teamTest.short.n, hitRate: Number((teamShortP * 100).toFixed(1)), ci: [Number((teamShortLo * 100).toFixed(1)), Number((teamShortHi * 100).toFixed(1))] },
    },
    bucketCalibration: {
      bins: deltaBins,
      cells: cells.length,
      corr: corrBucket == null ? null : Number(corrBucket.toFixed(3)),
      examples: cells.sort((a, b) => b.n - a.n).slice(0, 10),
    },
  };
}

// ---------- 运行 ----------
const rankedPath = join(root, 'data/ranked_drafts.sqlite');
const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : null;
const datasets = [loadRanked(rankedPath, since)];
const proIdx = process.argv.indexOf('--pro');
if (proIdx > -1 && process.argv[proIdx + 1]) {
  const tierIdx = process.argv.indexOf('--pro-tier');
  const tier = tierIdx > -1 ? process.argv[tierIdx + 1] : null;
  const patchIdx = process.argv.indexOf('--patch');
  const patch = patchIdx > -1 ? process.argv[patchIdx + 1] : null;
  datasets.push(loadPro(process.argv[proIdx + 1], tier, patch));
}

const results = datasets.map(d => {
  const r = analyze(d);
  console.log(`\n=== ${r.label} ===`);
  console.log(`对局 ${r.games} · 英雄-分路记录 ${r.playerGames} · 覆盖 ${r.champRoles} 个英雄-分路`);
  console.log(`A 胜率: 可比较 ${r.winRateCheck.pairs} 组 · 相关 ${r.winRateCheck.corr} · MAE ${r.winRateCheck.mae}pp · 方向一致 ${r.winRateCheck.signAgree}%`);
  console.log(`B 曲线斜率: ${r.curveSlopeCheck.pairs} 组 · 相关 ${r.curveSlopeCheck.corr} · 加权相关 ${r.curveSlopeCheck.weightedCorr}`);
  console.log(`C 队伍合成: 长局 n=${r.teamCurveTest.long.n} 命中 ${r.teamCurveTest.long.hitRate}% ${JSON.stringify(r.teamCurveTest.long.ci)} | 短局 n=${r.teamCurveTest.short.n} 命中 ${r.teamCurveTest.short.hitRate}%`);
  console.log(`D 分桶校准: ${r.bucketCalibration.cells} 个单元 · 相关 ${r.bucketCalibration.corr}`);
  return r;
});

mkdirSync(join(root, 'modeling/reports'), { recursive: true });
const report = {
  generatedAt: new Date().toISOString(),
  note: '曲线是"最终比赛时长条件胜率"，不是局中即时强度。相关为 0 或接近 0 表示该信息不能用于区分英雄强弱。',
  datasets: results,
};
writeFileSync(join(root, 'modeling/reports/curve_validation.json'), JSON.stringify(report, null, 2));

const md = ['# 曲线与胜率校验\n', `生成时间：${report.generatedAt}\n`];
for (const r of results) {
  md.push(`## ${r.label}\n`);
  md.push(`- 对局 ${r.games} 局；英雄-分路记录 ${r.playerGames} 条；覆盖 ${r.champRoles} 个英雄-分路\n`);
  md.push('### A. 报告的胜率 vs 实际胜率\n');
  md.push(`可比较 ${r.winRateCheck.pairs} 组（每组 ≥20 局）｜相关系数 **${r.winRateCheck.corr}**｜平均绝对误差 **${r.winRateCheck.mae}pp**｜方向一致率 **${r.winRateCheck.signAgree}%**\n`);
  md.push('| 英雄 | 分路 | 场次 | 报告胜率 | 实际胜率 | 偏差 |');
  md.push('|---|---|---|---|---|---|');
  for (const e of r.winRateCheck.examples) md.push(`| ${e.key} | ${e.role} | ${e.n} | ${e.reported}% | ${e.actual.toFixed(1)}% | ${e.delta >= 0 ? '+' : ''}${e.delta.toFixed(1)}pp |`);
  md.push('\n**分位分组（降低单英雄噪声）**\n');
  md.push('| 报告胜率分组 | 报告区间 | 场次 | 实际胜率 | 95% CI |');
  md.push('|---|---|---|---|---|');
  r.winRateCheck.quartiles.forEach((q, i) => {
    md.push(`| Q${i + 1} | ${q.reportedRange[0]}–${q.reportedRange[1]}% | ${q.n} | **${q.actual}%** | ${q.ci[0]}–${q.ci[1]}% |`);
  });
  md.push('\n### B. 曲线"偏后期"程度 vs 真实长短局胜率差\n');
  md.push(`可比较 ${r.curveSlopeCheck.pairs} 个英雄-分路（短局/长局各 ≥5 局）｜相关系数 **${r.curveSlopeCheck.corr}**｜按样本加权 **${r.curveSlopeCheck.weightedCorr}**\n`);
  md.push('| 英雄 | 分路 | 曲线偏后期 | 短局胜率(n) | 长局胜率(n) | 差值 |');
  md.push('|---|---|---|---|---|---|');
  for (const e of r.curveSlopeCheck.rows) md.push(`| ${e.key} | ${e.role} | ${e.lean >= 0 ? '+' : ''}${e.lean.toFixed(2)}pp | ${e.shortRate.toFixed(1)}% (${e.shortN}) | ${e.longRate.toFixed(1)}% (${e.longN}) | ${e.slope >= 0 ? '+' : ''}${e.slope.toFixed(1)}pp |`);
  md.push('| 曲线偏后期分组 | 区间 | 短局胜率 (n) | 长局胜率 (n) | 长短差 |');
  md.push('|---|---|---|---|---|');
  r.curveSlopeCheck.terciles.forEach((t, i) => {
    md.push(`| T${i + 1} | ${t.leanRange[0]} ~ ${t.leanRange[1]}pp | ${t.shortRate}% (${t.shortN}) | ${t.longRate}% (${t.longN}) | ${t.slope >= 0 ? '+' : ''}${t.slope}pp |`);
  });
  md.push('\n### C. 队伍级合成测试\n');
  md.push(`长局（35–40 分钟）：更"偏后期"的一方获胜率 **${r.teamCurveTest.long.hitRate}%**（n=${r.teamCurveTest.long.n}，95% CI ${JSON.stringify(r.teamCurveTest.long.ci)}）`);
  md.push(`短局（25–35 分钟）：更"偏后期"的一方获胜率 **${r.teamCurveTest.short.hitRate}%**（n=${r.teamCurveTest.short.n}，95% CI ${JSON.stringify(r.teamCurveTest.short.ci)}）\n`);
  md.push('### D. 分桶校准\n');
  md.push(`可比较 ${r.bucketCalibration.cells} 个 (英雄,分路,时长桶) 单元（每单元 ≥10 局）｜相关系数 **${r.bucketCalibration.corr}**\n`);
  md.push('| 预测偏差分组 | 单元数 | 场次 | 实际偏差 | 95% CI |');
  md.push('|---|---|---|---|---|');
  r.bucketCalibration.bins.forEach(b => {
    md.push(`| ${b.label} | ${b.cells} | ${b.n} | **${b.actualDelta >= 0 ? '+' : ''}${b.actualDelta}pp** | ${b.ci[0]}–${b.ci[1]}pp |`);
  });
}
writeFileSync(join(root, 'modeling/reports/curve_validation.md'), md.join('\n'));
console.log('\n报告：modeling/reports/curve_validation.md');
