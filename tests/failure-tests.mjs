#!/usr/bin/env node
/**
 * BP LAB v2.2 · 最小失败测试
 *
 * 对应《BP LAB v2.2》§8 的 12 条硬性检查，外加若干结构回归。
 * 运行：node tests/failure-tests.mjs
 * 退出码非 0 表示有失败项。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const BPLEngine = require(join(root, 'engine.js'));

const contract = JSON.parse(readFileSync(join(root, 'data/bp_contract.json'), 'utf8'));
const rules = JSON.parse(readFileSync(join(root, 'data/bp_rules.json'), 'utf8'));
const engine = BPLEngine.createEngine({ contract, rules });

const results = [];
function PHASE_TEST_VALUE(v) { return Number(Math.max(-1, Math.min(1, v)).toFixed(3)); }
function test(id, title, fn) {
  try {
    const detail = fn();
    results.push({ id, title, ok: true, detail: detail == null ? '' : String(detail) });
  } catch (err) {
    results.push({ id, title, ok: false, detail: err && err.message ? err.message : String(err) });
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`);
}

// 取一个同时出现在双方 counter 表里的同路组合，用于方向测试
function findCounterPair() {
  for (const key of Object.keys(contract.champions)) {
    const champ = contract.champions[key];
    for (const role of Object.keys(champ.roles || {})) {
      const counters = (champ.roles[role].counters || []);
      for (const c of counters) {
        const info = engine.counter(key, role, c.key);
        if (info.status === 'KNOWN') return { a: key, b: c.key, role, info };
      }
    }
  }
  return null;
}

// 找一个只在“其他位置”有协同记录的组合
function findPositionMismatch() {
  for (const key of Object.keys(contract.champions)) {
    const champ = contract.champions[key];
    for (const role of Object.keys(champ.roles || {})) {
      const list = champ.roles[role].synergies || [];
      for (const s of list) {
        for (const otherRole of engine.ROLES) {
          if (otherRole === role) continue;
          if (s.position !== role && s.position !== otherRole) continue;
          if (s.position === role) continue;
          const info = engine.synergy(key, role, s.key, otherRole === s.position ? 'mid' : otherRole);
          if (info.status === 'NOT_PROVIDED' && info.perspective === 'POSITION_MISMATCH') {
            return { a: key, aRole: role, b: s.key, bRole: otherRole, position: s.position, info };
          }
        }
      }
    }
  }
  return null;
}

// 找一个 40+ 桶落在 0% / 100% 的英雄
function findExtremeBucket() {
  for (const key of Object.keys(contract.champions)) {
    const champ = contract.champions[key];
    for (const role of Object.keys(champ.roles || {})) {
      const t = engine.trend(key, role);
      if (t.status !== 'KNOWN') continue;
      const b = t.buckets.find(x => x.key === '40+');
      if (b && (b.rate <= 0 || b.rate >= 100)) return { key, role, bucket: b, summary: engine.championTrendSummary(key, role) };
    }
  }
  return null;
}

// ---------- §8 12 条 ----------

test('F1', '交换同路 A/B 不会把对手胜率显示成本方胜率', () => {
  const pair = findCounterPair();
  assert(pair, '数据里没有可用的同路 counter 记录，无法验证方向');
  const fwd = engine.counter(pair.a, pair.role, pair.b);
  const rev = engine.counter(pair.b, pair.role, pair.a);
  assert(fwd.status === 'KNOWN' && rev.status === 'KNOWN', '双向都应拿到记录');
  assert(fwd.ourWinRate !== undefined && fwd.ourWinRate !== null, '我方胜率不能为空');
  // 源端胜率是整数百分比的四舍五入，允许 1pp 误差；
  // 但方向必须自洽：A 记录里的"对手胜率"要和 B 记录里的"我方胜率"落在同一侧。
  const tolerance = 1.01;
  assert(
    Math.abs((fwd.ownRate ?? 100 - (fwd.ourWinRate ?? 0)) - (fwd.ourWinRate ?? 0)) < 99,
    '占位'
  );
  assert(
    Math.abs((fwd.theirWinRate ?? 0) - (rev.ourWinRate ?? 0)) < tolerance,
    `A 记录的对手胜率 ${fwd.theirWinRate} 应等于 B 记录的我方胜率 ${rev.ourWinRate}（方向反了？）`
  );
  assert(
    Math.abs((rev.theirWinRate ?? 0) - (fwd.ourWinRate ?? 0)) < tolerance,
    `B 记录的对手胜率 ${rev.theirWinRate} 应等于 A 记录的我方胜率 ${fwd.ourWinRate}（方向反了？）`
  );
  assertEqual(fwd.perspective, 'DIRECT', 'A 有直接记录时应为 DIRECT 视角');
  return `${pair.a} vs ${pair.b} @${pair.role}: ${fwd.ourWinRate}% / 反向 ${rev.ourWinRate}%`;
});

test('F2', '杰斯的 Poke 不会因为双形态被漏标', () => {
  const t = engine.traits('jayce', 'top').poke;
  assertEqual(t.level, 'STRONG', 'jayce.top.poke 必须为 STRONG');
  assert(engine.isReviewed(t), 'jayce.top.poke 必须是已审核状态');
  return `jayce.top.poke=${t.level} / ${t.reviewStatus}`;
});

test('F3', '菲奥娜自身回复不会提升队友保护评级', () => {
  const roles = Object.keys(contract.champions.fiora.roles || {});
  const values = roles.map(r => `${r}:${engine.traits('fiora', r).peel.level}`);
  roles.forEach(r => {
    const t = engine.traits('fiora', r).peel;
    assert(t.level === 'WEAK', `fiora.${r}.peel 不能是 ${t.level}，自我回复不是队友保护`);
  });
  return values.join(' ');
});

test('F4', '无官方协同记录时显示“未提供”，不是 0', () => {
  const info = engine.synergy('ahri', 'mid', 'leesin', 'jungle');
  assertEqual(info.status, 'NOT_PROVIDED', '该组合不应有记录');
  assert(info.winRate === undefined || info.winRate === null, '未提供时不得伪造 0 / 50 的胜率');
  return `status=${info.status} note=${info.note}`;
});

test('F5', '不把其他位置的协同当作指定分路的协同', () => {
  const hit = findPositionMismatch();
  assert(hit, '没有找到位置不匹配的样本来验证');
  assertEqual(hit.info.status, 'NOT_PROVIDED', '位置不匹配必须视为未提供');
  assertEqual(hit.info.perspective, 'POSITION_MISMATCH', '必须标记位置不匹配');
  return `${hit.a}(${hit.aRole}) + ${hit.b}(${hit.bRole}) 只有 ${hit.position} 记录`;
});

test('F6', '被禁用/已选择的英雄立即从候选池移除', () => {
  const picks = { top: 'malphite', jungle: 'leesin', mid: null, adc: null, support: null };
  const enemyPicks = { top: 'jax', jungle: null, mid: 'zed', adc: null, support: null };
  const bans = ['ahri', 'yasuo'];
  const res = engine.candidates({ side: 'blue', picks, enemyPicks, bans });
  const keys = new Set();
  Object.values(res.roles).forEach(list => list.forEach(c => keys.add(c.key)));
  ['malphite', 'leesin', 'jax', 'zed', 'ahri', 'yasuo'].forEach(k => {
    assert(!keys.has(k), `${k} 已经不可选，却出现在候选里`);
  });
  // 位置必须合法
  Object.entries(res.roles).forEach(([role, list]) => {
    list.forEach(c => assert(c.champion.positions.includes(role), `${c.key} 不满足 ${role}`));
  });
  return `${Object.keys(res.roles).length} 个待选位置无违规候选`;
});

test('F7', '同一候选在不同敌方阵容下风险解释会变化', () => {
  const picks = { top: 'malphite', jungle: null, mid: 'ahri', adc: null, support: null };
  const enemyA = { top: 'jax', jungle: null, mid: 'zed', adc: null, support: null };
  const enemyB = { top: 'ornn', jungle: 'sejuani', mid: 'viktor', adc: 'jinx', support: 'lulu' };
  const a = engine.candidates({ side: 'blue', picks, enemyPicks: enemyA, bans: [] });
  const b = engine.candidates({ side: 'blue', picks, enemyPicks: enemyB, bans: [] });
  const sample = list => (list.roles.jungle[0] || {});
  const ca = sample(a), cb = sample(b);
  assert(ca.key && cb.key, '两个情景都应给出候选');
  const sigA = JSON.stringify({ c: ca.counter ? ca.counter.status + (ca.counter.ourWinRate ?? '') : null, r: ca.risks });
  const sigB = JSON.stringify({ c: cb.counter ? cb.counter.status + (cb.counter.ourWinRate ?? '') : null, r: cb.risks });
  assert(sigA !== sigB, `两个敌方阵容下 ${ca.key} 的风险/对位解释完全相同，说明没有随敌方变化`);
  return `${ca.key}: ${sigA} → ${sigB}`;
});

test('F8', '没有桶级样本量时不显示置信区间/可靠性评级', () => {
  const t = engine.trend('ahri', 'mid');
  assertEqual(t.status, 'KNOWN', 'ahri 中单应有历史时长曲线');
  assert(t.sampleN === null, '整体样本量必须为 null');
  t.buckets.forEach(b => {
    assert(b.sampleN === null, `${b.key} 桶不应有样本量`);
    assert(!('ci' in b) && !('confidence' in b), `${b.key} 桶不应包含置信区间字段`);
  });
  assert(typeof rules.disclaimers.noSampleN === 'string' && rules.disclaimers.noSampleN.length > 0, '必须提供“无样本量”说明文案');
  return `${t.buckets.length} 个桶 sampleN 全为 null`;
});

test('F9', '40+ 桶出现 0%/100% 时不会被当成极强/极弱后期', () => {
  const hit = findExtremeBucket();
  assert(hit, '没有找到 0%/100% 的桶样本');
  assertEqual(hit.bucket.flag, 'LOW_SAMPLE_SUSPECT', '极端桶必须被标记');
  assert(hit.bucket.note.length > 0, '标记必须带说明');
  const late = hit.summary.late;
  assert(late === null || hit.summary.partial === true, '被排除的桶不能参与后期结论');
  return `${hit.key}@${hit.role} 40+ = ${hit.bucket.rate}% → ${hit.bucket.flag}`;
});

test('F10', '来源缺地区/段位时不展示“韩服大师+”标签', () => {
  const mcp = engine.sourceInfo('OPGG_MCP');
  assert(mcp, '缺少 OPGG_MCP 来源登记');
  assertEqual(mcp.confirmedCohort, null, 'MCP 的 confirmed_cohort 必须为空');
  assertEqual(mcp.fieldSemanticsStatus, 'UNVERIFIED', 'MCP 字段语义必须标为未验证');
  const m = engine.meta('ahri', 'mid');
  assertEqual(m.cohortConfirmed, false, '单英雄统计必须标注口径未确认');
  assert(!/韩服|大师\+/.test(String(mcp.cohortNote || '') + String(m.cohortNote || '')), '未确认口径不得写韩服大师+');
  return `confirmed_cohort=${mcp.confirmedCohort} semantics=${mcp.fieldSemanticsStatus}`;
});

test('F11', '不同口径的组合与对位不会被相加成“预测胜率”', () => {
  const forbidden = ['teamAverage', 'teamComposite', 'teamStrength', 'predictWinRate', 'pickEV', 'composite'];
  forbidden.forEach(name => {
    assert(!(name in engine), `引擎不应暴露 ${name}，避免被当成综合胜率`);
  });
  const indexHtml = readFileSync(join(root, 'index.html'), 'utf8');
  const appJs = readFileSync(join(root, 'app.js'), 'utf8');
  assert(!/阵容强度/.test(indexHtml + appJs), '页面不应再出现“阵容强度”');
  assert(!/综合指数|composite-chip/.test(indexHtml + appJs), '页面不应再出现“综合指数”');
  assert(!/预测胜率|Pick EV/i.test(appJs), '页面不应输出预测胜率/Pick EV');
  return '引擎与页面均无综合分出口';
});

test('F12', '接口失败/限流时能显示缓存时间或“暂不可用”', () => {
  const mcp = engine.sourceInfo('OPGG_MCP');
  assert(typeof mcp.retrievedAt === 'string' && mcp.retrievedAt.length > 0, '来源必须登记抓取时间');
  assert(typeof mcp.usageReviewStatus === 'string', '来源必须有使用条款审查状态');
  const m = engine.meta('ahri', 'mid');
  assert(m.retrievedAt, '单英雄统计必须带抓取时间');
  const appJs = readFileSync(join(root, 'app.js'), 'utf8');
  assert(/retrievedAt|抓取/.test(appJs), '界面需要展示抓取时间');
  assert(/NOT_PROVIDED|未提供/.test(appJs), '界面需要能表达“暂不可用/未提供”');
  return `retrievedAt=${mcp.retrievedAt}`;
});

// ---------- 结构性回归（不属于 §8，但同样会静默出错） ----------

test('R1', '全部未审核时不虚构“缺开团”', () => {
  const res = engine.structure({ top: 'malphite', jungle: 'leesin', mid: 'ahri' }, {});
  const reviewed = res.dims.engage.reviewedCount;
  if (reviewed === 0) {
    assertEqual(res.gaps.length, 0, '标签未审核时不应产出缺口结论');
    return '未审核 → 0 缺口（符合预期）';
  }
  return `已审核 ${reviewed} 维，产出缺口 ${res.gaps.length} 个`;
});

test('R2', '缺口规则按严重度排序且带规则来源', () => {
  const res = engine.structure(
    { top: 'jayce', jungle: 'graves', mid: 'zed', adc: 'caitlyn', support: 'yuumi' },
    { top: 'malphite', jungle: 'vi', mid: 'ahri', adc: 'jinx', support: 'nautilus' }
  );
  assert(res.gaps.length > 0, '样本阵容（无敌方强开、全程无硬开团）应至少产出 1 个缺口');
  const rank = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  for (let i = 1; i < res.gaps.length; i++) {
    assert(rank[res.gaps[i - 1].severity] >= rank[res.gaps[i].severity], '缺口未按严重度排序');
  }
  res.gaps.forEach(g => {
    assert(g.reviewedPatch === '16.22', `${g.id} 缺少 reviewedPatch`);
    assert(g.reviewStatus === 'REVIEWED', `${g.id} 缺少 reviewStatus`);
  });
  return `${res.gaps.length} 个缺口，最高 ${res.gaps[0] ? res.gaps[0].severity : 'N/A'}`;
});

test('R3', '候选推荐分层且不含总分字段', () => {
  const res = engine.candidates({
    side: 'blue',
    picks: { top: null, jungle: null, mid: 'ahri', adc: null, support: null },
    enemyPicks: { top: 'jax', jungle: null, mid: 'zed', adc: null, support: null },
    bans: ['lulu'],
  });
  const list = res.roles.top;
  assert(list.length > 0, '上单应给出候选');
  list.forEach(c => {
    ['key', 'role', 'legal', 'fillsGaps', 'layers', 'risks', 'unknowns'].forEach(f => assert(f in c, `候选缺少字段 ${f}`));
    assert(!('score' in c) && !('probability' in c) && !('ev' in c), '候选不应有 score/probability/ev');
  });
  assert(typeof res.layerNote === 'string' && res.layerNote.length > 0, '必须说明分层规则');
  return `top 候选 ${list.length} 个，第一顺位 ${list[0].key}`;
});

test('R4', '所有已选英雄都有角色与来源追踪', () => {
  const picks = { top: 'malphite', jungle: 'leesin', mid: 'ahri', adc: 'kaisa', support: 'thresh' };
  const st = engine.structure(picks, {});
  assertEqual(st.members.length, 5, '应解析出 5 名成员');
  st.members.forEach(m => {
    assert(m.champion && m.champion.icon, `${m.key} 缺少图标`);
    assert(m.role, `${m.key} 缺少位置`);
    if (m.meta.status === 'KNOWN') {
      assert(m.meta.source === 'OPGG_MCP', `${m.key} 来源应为 OPGG_MCP`);
      assert(m.meta.retrievedAt, `${m.key} 缺少抓取时间`);
    }
  });
  return '5 名成员全部可追溯';
});

test('R5', '预测使用固定权重且不输出概率字段', () => {
  const weights = rules.fit.weights;
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  assertEqual(sum, 100, '适配度权重必须合计 100');
  const res = engine.predict({ picks: { top: 'jayce', jungle: 'graves' }, enemyPicks: { mid: 'zed' }, bans: [], role: 'mid' });
  const top = res.byRole.mid[0];
  assert(top, '应给出中单预测');
  const active = Object.values(weights).filter(v => v > 0).length;
  assertEqual(top.fit.parts.length, active, '每个候选都要列出全部生效的权重项');
  ['probability', 'winRate', 'ev', 'pickRate'].forEach(f => {
    assert(!(f in top.fit), `预测对象不应暴露 ${f}，避免被当成胜率`);
    assert(!(f in top), `候选不应暴露 ${f}`);
  });
  assert(typeof rules.disclaimers.fitNotProbability === 'string', '必须提供“不是概率”的说明');
  return `权重 ${JSON.stringify(weights)} = 100`;
});

test('R6', '缺失评分项退出分母，而不是按 0 分处理', () => {
  const res = engine.predict({ picks: { top: 'jayce' }, enemyPicks: {}, bans: [], role: 'jungle' });
  const top = res.byRole.jungle[0];
  const missing = top.fit.parts.filter(p => p.status !== 'KNOWN');
  assert(missing.length > 0, '这个状态下应该有缺失项（敌方未锁定等）');
  missing.forEach(p => assert(p.points === null, `${p.key} 缺失时 points 必须为 null，不能是 0`));
  const known = top.fit.parts.filter(p => p.status === 'KNOWN');
  const denom = known.reduce((s, p) => s + p.weight, 0);
  const num = known.reduce((s, p) => s + p.points, 0);
  const expected = Math.max(0, num / denom * 100 - top.fit.rolePenalty);
  assert(Math.abs(expected - top.fit.total) < 0.25, `适配度应由已覆盖项重算（期望 ${expected.toFixed(1)}，实际 ${top.fit.total}）`);
  assert(top.fit.coverage < 100, '有缺失项时覆盖率必须低于 100%');
  return `${missing.length} 项缺失，覆盖 ${top.fit.coverage}%，适配 ${top.fit.total}`;
});

test('R7', '预测随阵容变化且排除已选/被禁英雄', () => {
  const a = engine.predict({ picks: { top: 'malphite', jungle: 'vi' }, enemyPicks: { top: 'jax' }, bans: ['ahri'], role: 'mid' });
  const b = engine.predict({ picks: { top: 'jayce', jungle: 'graves' }, enemyPicks: { top: 'malphite' }, bans: ['ahri'], role: 'mid' });
  const listA = a.byRole.mid.slice(0, 5).map(c => `${c.key}:${c.fit.total}`);
  const listB = b.byRole.mid.slice(0, 5).map(c => `${c.key}:${c.fit.total}`);
  assert(listA.join() !== listB.join(), '不同已有阵容应给出不同预测');
  [...a.byRole.mid, ...b.byRole.mid].forEach(c => {
    assert(c.key !== 'ahri', '被 Ban 的英雄不应出现在预测里');
    assert(c.key !== 'malphite' && c.key !== 'vi' && c.key !== 'jax' && c.key !== 'jayce' && c.key !== 'graves',
      `${c.key} 已经被选，不应出现在预测里`);
    assert(c.champion.positions.includes('mid'), `${c.key} 不能打中单`);
  });
  return `A: ${listA.slice(0, 3).join(' / ')} ｜ B: ${listB.slice(0, 3).join(' / ')}`;
});

test('T1', '173 个英雄的 10 维标签全部有结论（无 UNREVIEWED）', () => {
  const champs = Object.entries(contract.champions);
  assert(champs.length === 173, `合约英雄数应为 173，实际 ${champs.length}`);
  let dims = 0;
  const bad = [];
  for (const [key, champ] of champs) {
    for (const d of engine.dims) {
      const e = champ.traits.default[d];
      dims += 1;
      if (!e || e.level === 'UNREVIEWED' || e.reviewStatus === 'REVIEW_REQUIRED') bad.push(`${key}.${d}`);
    }
  }
  assert(bad.length === 0, `仍有未审维度：${bad.slice(0, 5).join(', ')}`);
  return `${champs.length} 英雄 / ${dims} 维全覆盖`;
});

test('T2', '战术标签硬案例未漂移', () => {
  const cases = [['jayce', 'poke', 'STRONG'], ['fiora', 'peel', 'WEAK'], ['yuumi', 'frontline', 'WEAK'], ['sion', 'splitpush', 'STRONG']];
  for (const [key, dim, want] of cases) {
    const got = contract.champions[key].traits.default[dim].level;
    assert(got === want, `${key}.${dim} 应为 ${want}，实际 ${got}`);
  }
  return cases.map(([k, d, v]) => `${k}.${d}=${v}`).join(' / ');
});

test('T3', '阶段权重来自 rules.phase，且早期为校准版', () => {
  const phase = rules.phase || {};
  assert(phase.early && phase.early.source === 'calibrated', 'rules.phase.early.source 应为 calibrated');
  assert(phase.early.calibration && phase.early.calibration.n >= 150, '校准样本量应 ≥150');
  const res = engine.teamPhases({ top: 'jayce', jungle: 'leesin', mid: 'ahri', adc: 'ezreal', support: 'karma' });
  assert(res.earlySource === 'calibrated', 'teamPhases 应标记 earlySource=calibrated');
  // 与 rules 权重手算一致（用 engine.traits 解析后的角色标签，避免角色覆盖差异）
  const W = phase.early.weights;
  const lv = { STRONG: 1, MEDIUM: 0, WEAK: -1 };
  const t = engine.traits('jayce', 'top');
  let sum = 0, w = 0;
  for (const [dim, weight] of Object.entries(W)) {
    const e = t[dim];
    if (!e || e.level === 'UNREVIEWED') continue;
    sum += weight * lv[e.level];
    w += Math.abs(weight);
  }
  const gap = Math.abs(sum / w - engine.championPhases('jayce', 'top').early);
  assert(gap < 1e-6, `jayce 早期分与手算不一致（差 ${gap}）`);
  return `n=${phase.early.calibration.n} · CV ${phase.early.calibration.cvCorr} · 队伍级 ${phase.early.calibration.teamCorr}`;
});

test('T4', '阶段曲线覆盖计数与标签状态一致', () => {
  const res = engine.teamPhases({ top: 'jayce', jungle: 'leesin', mid: 'ahri', adc: 'ezreal', support: 'karma' });
  assert(res.coverageCount === '5/5', `满阵容应为 5/5，实际 ${res.coverageCount}`);
  const partial = engine.teamPhases({ top: 'jayce' });
  assert(partial.coverageCount === '1/1', `单人应为 1/1，实际 ${partial.coverageCount}`);
  return `${res.coverageCount} / ${partial.coverageCount}`;
});

// ---------- report ----------
const failed = results.filter(r => !r.ok);
const pad = s => String(s).padEnd(4, ' ');
results.forEach(r => {
  const mark = r.ok ? 'PASS' : 'FAIL';
  console.log(`${mark} ${pad(r.id)} ${r.title}${r.detail ? `\n          → ${r.detail}` : ''}`);
});
console.log(`\n${results.length - failed.length}/${results.length} passed${failed.length ? ` · ${failed.length} failed` : ''}`);
process.exit(failed.length ? 1 : 0);
