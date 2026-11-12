#!/usr/bin/env node
/**
 * BP LAB · 用 ChainCC（CC BY 4.0）职业赛数据校验「早期强度」到底存不存在
 *
 * 数据：chaincc-players-2026.csv.gz（每行 = 一名选手一局）
 *   patch / champion / position / side / result / gamelength
 *   golddiffat10|15, xpdiffat15, csdiffat15（相对同路对手）
 *
 * 做两件事：
 *  1. 用 15 分钟经济差建立「对线期表现」指标（按补丁去均值 + 按局聚类 bootstrap）
 *  2. 检验旧时长曲线的「早期强」标签是否与真实 15 分钟经济差相关
 *
 * 用法：node tests/eval_lane.mjs /path/to/chaincc-players-2026.csv.gz
 */
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const contract = JSON.parse(readFileSync(join(root, 'data/bp_contract.json'), 'utf8'));
const ddragon = JSON.parse(readFileSync(join(root, 'data/ddragon_champion_index.json'), 'utf8'));

const csvPath = process.argv[2] || '/tmp/cc_players.csv.gz';
const text = gunzipSync(readFileSync(csvPath)).toString('utf8');
const lines = text.split('\n').filter(Boolean);
const header = lines[0].split(',');
const col = Object.fromEntries(header.map((h, i) => [h, i]));
const POS = { top: 'top', jng: 'jungle', mid: 'mid', bot: 'adc', sup: 'support' };
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// 英雄名映射：ChainCC 用英文名
const byNorm = new Map();
for (const [key, champ] of Object.entries(contract.champions)) {
  byNorm.set(norm(champ.ddragonId || key), key);
  byNorm.set(norm(key), key);
}
const alias = { wukong: 'monkeyking', nunuwillump: 'nunu', renataglasc: 'renata', ksante: 'ksante' };
function mapChamp(name) {
  const n = norm(name);
  return byNorm.get(n) || byNorm.get(alias[n]) || null;
}

const rows = [];
let skipped = 0;
for (let i = 1; i < lines.length; i++) {
  const f = lines[i].split(',');
  const patch = f[col.patch];
  if (!patch || !patch.startsWith('16.')) { skipped += 1; continue; }
  const gd15 = parseFloat(f[col.golddiffat15]);
  const gp15 = parseFloat(f[col.xpdiffat15]);
  if (!Number.isFinite(gd15)) { skipped += 1; continue; }
  const champ = mapChamp(f[col.champion]);
  const role = POS[f[col.position]];
  if (!champ || !role) { skipped += 1; continue; }
  rows.push({
    game: f[col.game_id],
    patch,
    champion: champ,
    role,
    side: f[col.side] === 'Blue' ? 1 : -1,
    win: f[col.result] === 'TRUE' ? 1 : 0,
    gd15,
    xd15: Number.isFinite(gp15) ? gp15 : null,
  });
}
console.log(`载入 ${rows.length} 条（跳过 ${skipped}），对局 ${new Set(rows.map(r => r.game)).size}，补丁 ${new Set(rows.map(r => r.patch)).size}`);

// ---------- 补丁内去均值 ----------
// 同一补丁同一分路求均值，英雄值 = 自身 - 该补丁该分路均值
function patchRoleMeans(list, field) {
  const acc = new Map();
  for (const r of list) {
    const v = r[field];
    if (v == null) continue;
    const k = `${r.patch}|${r.role}`;
    const a = acc.get(k) || { n: 0, s: 0 };
    a.n += 1; a.s += v;
    acc.set(k, a);
  }
  const means = new Map();
  for (const [k, a] of acc) means.set(k, a.s / a.n);
  return means;
}

function buildMetric(list) {
  const means = patchRoleMeans(list, 'gd15');
  const byChamp = new Map();
  for (const r of list) {
    const m = means.get(`${r.patch}|${r.role}`);
    const adj = r.gd15 - m;
    const k = `${r.champion}|${r.role}`;
    const a = byChamp.get(k) || { n: 0, sum: 0, games: new Set(), vals: [] };
    a.n += 1; a.sum += adj; a.games.add(r.game); a.vals.push(adj);
    byChamp.set(k, a);
  }
  const out = [];
  for (const [k, a] of byChamp) {
    const [champion, role] = k.split('|');
    out.push({ champion, role, n: a.n, games: a.games.size, mean: a.sum / a.n, vals: a.vals });
  }
  return out;
}

// ---------- 聚类 bootstrap（按局重采样） ----------
function bootstrapByGame(list, metricFn, iterations = 1000) {
  const byGame = new Map();
  for (const r of list) {
    if (!byGame.has(r.game)) byGame.set(r.game, []);
    byGame.get(r.game).push(r);
  }
  const games = [...byGame.values()];
  const stats = [];
  for (let i = 0; i < iterations; i++) {
    const sample = [];
    for (let j = 0; j < games.length; j++) {
      const g = games[Math.floor(Math.random() * games.length)];
      sample.push(...g);
    }
    const val = metricFn(sample);
    if (Number.isFinite(val)) stats.push(val);
  }
  stats.sort((a, b) => a - b);
  const q = p => stats[Math.floor(p * (stats.length - 1))];
  return { lo: q(0.025), hi: q(0.975), n: stats.length };
}

// ---------- 1. 对线期指标 ----------
const full = buildMetric(rows).filter(m => m.games >= 20);
console.log(`英雄-分路：${buildMetric(rows).length} 个，其中 ≥20 局的有 ${full.length} 个`);

// ---------- 2. 与旧曲线对比 ----------
function curveDeltas(key, role) {
  const rd = contract.champions[key] && contract.champions[key].roles && contract.champions[key].roles[role];
  if (!rd || !rd.trend) return null;
  const map = {};
  for (const b of rd.trend.buckets) {
    map[b.key] = b.flag === 'OK' && typeof b.rate === 'number' ? Number(b.rate) - Number(b.average == null ? 50 : b.average) : null;
  }
  return map;
}
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

const pairs = [];
for (const m of full) {
  const d = curveDeltas(m.champion, m.role);
  if (!d) continue;
  const early = mean([d['<25'], d['25-30']].filter(v => v != null));
  const late = mean([d['35-40'], d['40+']].filter(v => v != null));
  if (early == null || late == null) continue;
  pairs.push({ ...m, early, late, lateLean: late - early });
}
console.log(`可与旧曲线比较：${pairs.length} 个英雄-分路`);

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
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const corrEarly = pearson(pairs.map(p => p.early), pairs.map(p => p.mean));
const corrLateLean = pearson(pairs.map(p => p.lateLean), pairs.map(p => p.mean));

// 分位数分组：旧曲线说早期强的 vs 早期弱的
pairs.sort((a, b) => b.early - a.early);
const third = Math.floor(pairs.length / 3);
const groups = [
  ['旧曲线：早期最强 1/3', pairs.slice(0, third)],
  ['旧曲线：中间 1/3', pairs.slice(third, 2 * third)],
  ['旧曲线：早期最弱 1/3', pairs.slice(2 * third)],
];
console.log(`\n旧曲线"早期强度" vs 真实 15 分钟经济差（${pairs.length} 个英雄-分路）`);
console.log(`相关系数：early=${corrEarly.toFixed(3)}  lateLean=${corrLateLean.toFixed(3)}`);
for (const [label, seg] of groups) {
  const n = seg.reduce((a, x) => a + x.n, 0);
  const w = seg.reduce((a, x) => a + x.mean * x.n, 0) / n;
  console.log(`  ${label}: ${seg.length} 个 · ${n} 场 · 平均经济差 ${w.toFixed(1)}`);
}

// 聚类 bootstrap：整条相关
const bEarly = bootstrapByGame(rows, sample => {
  const m = buildMetric(sample).filter(x => x.games >= 20);
  const ps = [];
  for (const x of m) {
    const d = curveDeltas(x.champion, x.role);
    if (!d) continue;
    const early = mean([d['<25'], d['25-30']].filter(v => v != null));
    if (early == null) continue;
    ps.push([early, x.mean]);
  }
  return pearson(ps.map(p => p[0]), ps.map(p => p[1]));
}, 300);
console.log(`  early 相关 95% CI: [${bEarly.lo.toFixed(3)}, ${bEarly.hi.toFixed(3)}]（按局重采样 ${bEarly.n} 次）`);

// ---------- 3. 当前补丁窗口（16.20–16.22）----------
const recent = rows.filter(r => ['16.20', '16.21', '16.22'].includes(r.patch));
const recentMetric = buildMetric(recent).filter(m => m.games >= 8).sort((a, b) => b.games - a.games);
console.log(`\n当前窗口 16.20–16.22：${recent.length} 条 / ${new Set(recent.map(r => r.game)).size} 局`);
console.log('  经济差@15 最高（≥8 局）：', recentMetric.slice(0, 8).map(m => `${m.champion}/${m.role} ${m.mean.toFixed(0)}(${m.games})`).join(', '));
console.log('  经济差@15 最低（≥8 局）：', recentMetric.slice(-8).map(m => `${m.champion}/${m.role} ${m.mean.toFixed(0)}(${m.games})`).join(', '));
