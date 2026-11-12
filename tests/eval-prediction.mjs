#!/usr/bin/env node
/**
 * BP LAB · 下一手预测的离线评估 + 权重微调
 *
 * 数据：data/ranked_drafts.sqlite（scripts/collect_ranked_drafts.py 通过 OP.GG 官方 MCP 采集的
 *       韩服单双排对局，含双方 5 个位置的英雄）
 *
 * 评估方式（不假装知道真实 BP 顺序）：
 *   按 上单 → 打野 → 中单 → 下路 → 辅助 的顺序，蓝红交替逐个"揭晓"。
 *   每揭晓一个位置前，把"该队已选 + 对方已选"喂给 engine.predict，看真实英雄落在第几名。
 *
 * 指标：Top1 / Top3 / Top5 命中率、MRR、平均名次；并和三个基线比较：
 *   1) 分路选取率（pickRate）  2) 分路胜率（winRate）  3) 分路排名（rank）
 *
 * 用法：
 *   node tests/eval-prediction.mjs                 # 当前权重 + 基线
 *   node tests/eval-prediction.mjs --tune          # 额外做 70/30 时间切分的权重网格搜索
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const BPLEngine = require(join(root, 'engine.js'));

const contract = JSON.parse(readFileSync(join(root, 'data/bp_contract.json'), 'utf8'));
const rules = JSON.parse(readFileSync(join(root, 'data/bp_rules.json'), 'utf8'));
const champIndex = JSON.parse(readFileSync(join(root, 'data/ddragon_champion_index.json'), 'utf8'));

const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
const LIST_LIMIT = 40;
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// ---------- 英雄映射：numeric id / ddragon key → 合约 key ----------
const byNorm = new Map();
for (const [key, champ] of Object.entries(contract.champions)) {
  byNorm.set(norm(champ.ddragonId || key), key);
  byNorm.set(norm(key), key);
}
function mapChampion(championId, storedKey) {
  const entry = champIndex[String(championId)];
  if (entry) {
    const hit = byNorm.get(norm(entry.ddragonId));
    if (hit) return hit;
  }
  return byNorm.get(norm(storedKey)) || null;
}

// ---------- 读取对局 ----------
const dbPath = process.env.BP_LAB_DRAFTS_DB || join(root, 'data/ranked_drafts.sqlite');
const db = new DatabaseSync(dbPath);
const sinceIdx = process.argv.indexOf('--since');
const since = sinceIdx > -1 ? process.argv[sinceIdx + 1] : null;
const gameRows = since
  ? db.prepare('SELECT game_id, created_at, blue_win FROM matches WHERE created_at >= ? ORDER BY created_at, game_id').all(since)
  : db.prepare('SELECT game_id, created_at, blue_win FROM matches ORDER BY created_at, game_id').all();
const playerRows = db.prepare('SELECT game_id, side, position, champion_id, champion_key FROM players').all();

const gamesById = new Map();
for (const g of gameRows) {
  gamesById.set(g.game_id, {
    gameId: g.game_id,
    createdAt: g.created_at,
    blueWin: g.blue_win,
    blue: {},
    red: {},
    mapped: 0,
    unmapped: [],
  });
}
for (const p of playerRows) {
  const game = gamesById.get(p.game_id);
  if (!game) continue;
  const key = mapChampion(p.champion_id, p.champion_key);
  const side = p.side === 'BLUE' ? 'blue' : 'red';
  if (!key) {
    game.unmapped.push(`${p.champion_key || p.champion_id}`);
    continue;
  }
  game[side][p.position] = key;
}

const usable = [];
let dropped = 0;
for (const game of gamesById.values()) {
  const okBlue = ROLES.every(r => game.blue[r]);
  const okRed = ROLES.every(r => game.red[r]);
  if (!okBlue || !okRed || game.unmapped.length) { dropped += 1; continue; }
  usable.push(game);
}
console.log(`对局：库内 ${gameRows.length}，可用 ${usable.length}，丢弃 ${dropped}（缺少位置/无法映射英雄）`);

// ---------- 基线列表 ----------
function rolePool(role) {
  const out = [];
  for (const [key, champ] of Object.entries(contract.champions)) {
    if (!champ.positions || !champ.positions.includes(role)) continue;
    const rd = champ.roles && champ.roles[role];
    const meta = (rd && rd.meta) || {};
    out.push({
      key,
      pickRate: typeof meta.pickRate === 'number' ? meta.pickRate : -1,
      winRate: typeof meta.winRate === 'number' ? meta.winRate : -1,
      tier: typeof meta.tier === 'number' ? meta.tier : 99,
      rank: typeof meta.rank === 'number' ? meta.rank : 9999,
    });
  }
  return out;
}
const pools = Object.fromEntries(ROLES.map(r => [r, rolePool(r)]));
const baselines = {
  pickRate: Object.fromEntries(ROLES.map(r => [r, [...pools[r]].sort((a, b) => b.pickRate - a.pickRate).map(x => x.key)])),
  winRate: Object.fromEntries(ROLES.map(r => [r, [...pools[r]].sort((a, b) => b.winRate - a.winRate).map(x => x.key)])),
  rank: Object.fromEntries(ROLES.map(r => [r, [...pools[r]].sort((a, b) => (a.tier - b.tier) || (a.rank - b.rank)).map(x => x.key)])),
  random: Object.fromEntries(ROLES.map(r => [r, pools[r].length])),
};

// ---------- 评估 ----------
function makeEngine(weights) {
  const custom = weights ? { ...rules, fit: { ...rules.fit, weights } } : rules;
  return BPLEngine.createEngine({ contract, rules: custom });
}

function evaluate(engine, gameList) {
  const stats = {
    n: 0,
    model: { top1: 0, top3: 0, top5: 0, rr: 0, rankSum: 0, misses: 0 },
    pickRate: { top1: 0, top3: 0, top5: 0, rr: 0, rankSum: 0 },
    winRate: { top1: 0, top3: 0, top5: 0, rr: 0, rankSum: 0 },
    rank: { top1: 0, top3: 0, top5: 0, rr: 0, rankSum: 0 },
    randomTop5: 0,
    byPhase: { early: { n: 0, top5: 0, rr: 0 }, late: { n: 0, top5: 0, rr: 0 } },
    byAllyCount: {},
    byConfidence: { HIGH: { n: 0, top5: 0 }, MEDIUM: { n: 0, top5: 0 }, LOW: { n: 0, top5: 0 } },
  };

  const bump = (bucket, rank, k = 5) => {
    if (!rank) return;
    if (rank <= 1) bucket.top1 += 1;
    if (rank <= 3) bucket.top3 += 1;
    if (rank <= k) bucket.top5 += 1;
    bucket.rr += 1 / rank;
    bucket.rankSum += rank;
  };

  for (const game of gameList) {
    const picked = { blue: {}, red: {} };
    for (let step = 0; step < ROLES.length; step++) {
      const role = ROLES[step];
      for (const side of ['blue', 'red']) {
        const other = side === 'blue' ? 'red' : 'blue';
        const actual = game[side][role];
        const pred = engine.predict({
          side, picks: picked[side], enemyPicks: picked[other], bans: [], role, limit: LIST_LIMIT,
        });
        const list = pred.byRole[role] || [];
        const keys = list.map(c => c.key);
        const rank = keys.indexOf(actual) + 1 || LIST_LIMIT + 1;

        stats.n += 1;
        bump(stats.model, rank);
        const taken = new Set([...Object.values(picked[side]), ...Object.values(picked[other])]);
        const rankIn = list => {
          const filtered = list.filter(k => !taken.has(k));
          const i = filtered.indexOf(actual);
          return i < 0 ? 999 : i + 1;
        };
        bump(stats.pickRate, rankIn(baselines.pickRate[role]));
        bump(stats.winRate, rankIn(baselines.winRate[role]));
        bump(stats.rank, rankIn(baselines.rank[role]));
        stats.randomTop5 += Math.min(5, baselines.random[role]) / baselines.random[role];

        const phase = step < 2 ? 'early' : 'late';
        stats.byPhase[phase].n += 1;
        if (rank <= 5) stats.byPhase[phase].top5 += 1;
        stats.byPhase[phase].rr += 1 / rank;

        const bucketKey = String(Object.keys(picked[side]).length);
        if (!stats.byAllyCount[bucketKey]) stats.byAllyCount[bucketKey] = { n: 0, top1: 0, top5: 0, rr: 0 };
        const b = stats.byAllyCount[bucketKey];
        b.n += 1;
        if (rank === 1) b.top1 += 1;
        if (rank <= 5) b.top5 += 1;
        b.rr += 1 / rank;

        const top = list[0];
        const conf = top ? top.fit.confidence : 'LOW';
        stats.byConfidence[conf].n += 1;
        if (rank <= 5) stats.byConfidence[conf].top5 += 1;

        picked[side][role] = actual;
      }
    }
  }

  const pct = (a, b) => (b ? (a / b) * 100 : 0);
  const summarize = b => ({
    top1: Number(pct(b.top1, stats.n).toFixed(1)),
    top3: Number(pct(b.top3, stats.n).toFixed(1)),
    top5: Number(pct(b.top5, stats.n).toFixed(1)),
    mrr: Number((b.rr / stats.n).toFixed(3)),
    meanRank: Number((b.rankSum / stats.n).toFixed(2)),
  });
  return {
    steps: stats.n,
    games: gameList.length,
    model: summarize(stats.model),
    baselines: {
      pickRate: summarize(stats.pickRate),
      winRate: summarize(stats.winRate),
      rank: summarize(stats.rank),
      randomTop5: Number(pct(stats.randomTop5, stats.n).toFixed(1)),
    },
    byPhase: {
      early: { n: stats.byPhase.early.n, top5: Number(pct(stats.byPhase.early.top5, stats.byPhase.early.n).toFixed(1)), mrr: Number((stats.byPhase.early.rr / stats.byPhase.early.n).toFixed(3)) },
      late: { n: stats.byPhase.late.n, top5: Number(pct(stats.byPhase.late.top5, stats.byPhase.late.n).toFixed(1)), mrr: Number((stats.byPhase.late.rr / stats.byPhase.late.n).toFixed(3)) },
    },
    byConfidence: Object.fromEntries(Object.entries(stats.byConfidence).map(([k, v]) => [k, { n: v.n, top5: Number(pct(v.top5, v.n).toFixed(1)) }])),
    byAllyCount: Object.fromEntries(Object.entries(stats.byAllyCount).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => [k, {
      n: v.n,
      top1: Number(pct(v.top1, v.n).toFixed(1)),
      top5: Number(pct(v.top5, v.n).toFixed(1)),
      mrr: Number((v.rr / v.n).toFixed(3)),
    }])),
  };
}

// ---------- 运行 ----------
const baseEngine = makeEngine(null);
const t0 = Date.now();
const result = evaluate(baseEngine, usable);
console.log(`评估完成：${result.games} 局 / ${result.steps} 次预测，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ---------- 可选：权重网格搜索（时间切分 70/30） ----------
let tuning = null;
if (process.argv.includes('--tune')) {
  const split = Math.floor(usable.length * 0.7);
  const train = usable.slice(0, split);
  const test = usable.slice(split);

  const normalize = w => {
    const keys = ['gap', 'combo', 'counter', 'meta', 'damage', 'popularity'];
    const sum = keys.reduce((acc, k) => acc + (w[k] || 0), 0);
    const out = {};
    keys.forEach(k => { out[k] = Math.round(((w[k] || 0) / sum) * 100); });
    const diff = 100 - keys.reduce((acc, k) => acc + out[k], 0);
    out.meta += diff;
    return out;
  };

  const grid = [];
  for (const gap of [20, 30, 40])
    for (const combo of [10, 20])
      for (const counter of [5, 15])
        for (const meta of [15, 25])
          for (const damage of [0, 10])
            for (const popularity of [0, 20, 40]) {
              grid.push(normalize({ gap, combo, counter, meta, damage, popularity }));
            }
  console.log(`\n权重网格：${grid.length} 组，训练 ${train.length} 局 / 验证 ${test.length} 局`);
  const rows = [];
  for (const w of grid) {
    const eng = makeEngine(w);
    const trainRes = evaluate(eng, train);
    rows.push({ weights: w, train: trainRes.model });
  }
  rows.sort((a, b) => (b.train.top5 - a.train.top5) || (b.train.mrr - a.train.mrr));
  const best = rows[0];
  const bestEngine = makeEngine(best.weights);
  const testBest = evaluate(bestEngine, test);
  const testCurrent = evaluate(baseEngine, test);
  tuning = {
    split: { trainGames: train.length, testGames: test.length },
    topCandidates: rows.slice(0, 10).map(r => ({ weights: r.weights, trainTop5: r.train.top5, trainMrr: r.train.mrr })),
    best: best.weights,
    test: testBest,
    testWithCurrent: testCurrent,
  };
  console.log(`\n最佳（训练集 top5）：${JSON.stringify(best.weights)}`);
  console.log(`  训练 top5 ${best.train.top5}% / MRR ${best.train.mrr}`);
  console.log(`  验证 top5 ${testBest.model.top5}% / MRR ${testBest.model.mrr}（当前权重 ${testCurrent.model.top5}% / ${testCurrent.model.mrr}）`);
  console.log('  前 5 名候选：');
  rows.slice(0, 5).forEach((r, i) => console.log(`   ${i + 1}. ${JSON.stringify(r.weights)} → train ${r.train.top5}% / ${r.train.mrr}`));
}


// ---------- 命名配置对比 ----------
if (process.argv.includes('--probe')) {
  const split = Math.floor(usable.length * 0.7);
  const train = usable.slice(0, split);
  const test = usable.slice(split);
  const configs = {
    '当前规则(35/20/15/20/10/0)': { gap: 35, combo: 20, counter: 15, meta: 20, damage: 10, popularity: 0 },
    'A 热门30(25/10/5/20/10/30)': { gap: 25, combo: 10, counter: 5, meta: 20, damage: 10, popularity: 30 },
    'B 纯净(25/10/0/25/0/40)': { gap: 25, combo: 10, counter: 0, meta: 25, damage: 0, popularity: 40 },
    'C 结构30(30/10/5/15/10/30)': { gap: 30, combo: 10, counter: 5, meta: 15, damage: 10, popularity: 30 },
    'D 训练最优(20/10/5/15/10/40)': { gap: 20, combo: 10, counter: 5, meta: 15, damage: 10, popularity: 40 },
    'E 协同15(25/15/5/15/10/30)': { gap: 25, combo: 15, counter: 5, meta: 15, damage: 10, popularity: 30 },
    'F 热度优先(20/5/0/20/5/50)': { gap: 20, combo: 5, counter: 0, meta: 20, damage: 5, popularity: 50 },
    'G 只热门度(0/0/0/0/0/100)': { gap: 0, combo: 0, counter: 0, meta: 0, damage: 0, popularity: 100 },
  };
  console.log('\n配置 | 全量Top1% | 全量Top3% | 全量Top5% | 全量MRR | 验证Top5% | 验证MRR');
  for (const [name, w] of Object.entries(configs)) {
    const eng = makeEngine(w);
    const all = evaluate(eng, usable);
    const tv = evaluate(eng, test);
    console.log(`${name} | ${all.model.top1} | ${all.model.top3} | ${all.model.top5} | ${all.model.mrr} | ${tv.model.top5} | ${tv.model.mrr}`);
  }
}

// ---------- 报告 ----------
const report = {
  generatedAt: new Date().toISOString(),
  db: dbPath,
  gamesInDb: gameRows.length,
  gamesUsable: usable.length,
  gamesDropped: dropped,
  steps: result.steps,
  weights: rules.fit.weights,
  model: result.model,
  baselines: result.baselines,
  byPhase: result.byPhase,
  byConfidence: result.byConfidence,
  tuning,
  note: '预测是"给定部分阵容后下一手最可能的适配英雄"的命中率评估，不代表胜率预测能力。角色顺序按 上→野→中→下→辅 模拟，不是真实 BP 顺序。',
};
mkdirSync(join(root, 'modeling/reports'), { recursive: true });
writeFileSync(join(root, 'modeling/reports/prediction_eval.json'), JSON.stringify(report, null, 2));

const md = [];
md.push('# 下一手预测 · 真实排位对局评估\n');
md.push(`- 生成时间：${report.generatedAt}`);
md.push(`- 数据：${report.gamesUsable} 局韩服单双排（OP.GG 官方 MCP 采集），共 ${report.steps} 次"下一手"预测`);
md.push(`- 模拟顺序：上单 → 打野 → 中单 → 下路 → 辅助，蓝红交替\n`);
md.push('## 命中率对比\n');
md.push('| 方案 | Top1 | Top3 | Top5 | MRR | 平均名次 |');
md.push('|---|---|---|---|---|---|');
const b = result.baselines;
md.push(`| **BP LAB 适配度** | **${result.model.top1}%** | **${result.model.top3}%** | **${result.model.top5}%** | **${result.model.mrr}** | ${result.model.meanRank} |`);
md.push(`| 基线：分路选取率 | ${b.pickRate.top1}% | ${b.pickRate.top3}% | ${b.pickRate.top5}% | ${b.pickRate.mrr} | ${b.pickRate.meanRank} |`);
md.push(`| 基线：分路胜率 | ${b.winRate.top1}% | ${b.winRate.top3}% | ${b.winRate.top5}% | ${b.winRate.mrr} | ${b.winRate.meanRank} |`);
md.push(`| 基线：分路排名 | ${b.rank.top1}% | ${b.rank.top3}% | ${b.rank.top5}% | ${b.rank.mrr} | ${b.rank.meanRank} |`);
md.push(`| 基线：随机猜测 Top5 | — | — | ${b.randomTop5}% | — | — |\n`);
md.push('## 分阶段\n');
md.push(`| 阶段 | 预测次数 | Top5 | MRR |`);
md.push(`|---|---|---|---|`);
md.push(`| 前两轮（上单/打野） | ${result.byPhase.early.n} | ${result.byPhase.early.top5}% | ${result.byPhase.early.mrr} |`);
md.push(`| 之后（中单/下路/辅助） | ${result.byPhase.late.n} | ${result.byPhase.late.top5}% | ${result.byPhase.late.mrr} |\n`);
md.push('## 按"该队已选人数"（信息量递增）\n');
md.push(`| 已选人数 | 预测次数 | Top1 | Top5 | MRR |`);
md.push(`|---|---|---|---|---|`);
for (const [k, v] of Object.entries(result.byAllyCount)) md.push(`| ${k} | ${v.n} | ${v.top1}% | ${v.top5}% | ${v.mrr} |`);
md.push('');
md.push('## 按置信度\n');
md.push(`| 置信度 | 预测次数 | Top5 |`);
md.push(`|---|---|---|`);
for (const [k, v] of Object.entries(result.byConfidence)) md.push(`| ${k} | ${v.n} | ${v.top5}% |`);
if (tuning) {
  md.push('\n## 权重微调（70/30 时间切分）\n');
  md.push(`训练 ${tuning.split.trainGames} 局 / 验证 ${tuning.split.testGames} 局。`);
  md.push(`\n最佳权重：\`${JSON.stringify(tuning.best)}\``);
  md.push(`\n| 数据集 | 当前权重 Top5 | 调参后 Top5 |`);
  md.push(`|---|---|---|`);
  md.push(`| 验证集 | ${tuning.testWithCurrent.model.top5}% | ${tuning.test.model.top5}% |`);
  md.push(`\n| 候选权重（训练集前 10） | 训练 Top5 | 训练 MRR |`);
  md.push(`|---|---|---|`);
  tuning.topCandidates.forEach(c => md.push(`| gap${c.weights.gap} combo${c.weights.combo} counter${c.weights.counter} meta${c.weights.meta} damage${c.weights.damage} pop${c.weights.popularity} | ${c.trainTop5}% | ${c.trainMrr} |`));
}
md.push(`\n> ${report.note}`);
writeFileSync(join(root, 'modeling/reports/prediction_eval.md'), md.join('\n'));

console.log('\n' + md.join('\n'));
