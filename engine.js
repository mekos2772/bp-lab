/* BP LAB v2.2 · 组合分析引擎
 *
 * 纯函数，不依赖 DOM，浏览器与 Node（测试）共用。
 *
 * 硬性约束（对应 docs/BP_LAB_v2.2_OPGG轻量化方案.md）：
 *  - 不输出任何"阵容综合强度 / 预测胜率 / Pick EV"数字。
 *  - 未知值返回 UNKNOWN / null，绝不回退成 0、50 或中性加分。
 *  - 时长曲线只描述"最终比赛时长条件胜率"，不当作局中即时战斗力。
 *  - 每个统计都带上来源与口径确认状态。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BPLEngine = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const LEVEL_RANK = { WEAK: 0, MEDIUM: 1, STRONG: 2 };
  const LEVEL_KEYS = ['WEAK', 'MEDIUM', 'STRONG', 'UNREVIEWED'];
  const ROLES = ['top', 'jungle', 'mid', 'adc', 'support'];
  const ROLE_LABELS = { top: '上单', jungle: '打野', mid: '中单', adc: '下路', support: '辅助' };
  const SEVERITY_RANK = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  const UNKNOWN_TRAIT = Object.freeze({
    level: 'UNREVIEWED',
    reviewStatus: 'REVIEW_REQUIRED',
    evidence: [],
  });

  function rankOf(level) {
    return Object.prototype.hasOwnProperty.call(LEVEL_RANK, level) ? LEVEL_RANK[level] : -1;
  }

  function atLeast(level, threshold) {
    const a = rankOf(level);
    const b = rankOf(threshold);
    return a >= 0 && b >= 0 && a >= b;
  }

  function isReviewed(entry) {
    return !!entry && entry.level !== 'UNREVIEWED' && entry.reviewStatus !== 'REVIEW_REQUIRED';
  }

  function createEngine(options) {
    const contract = options && options.contract;
    const rules = options && options.rules;
    if (!contract) throw new Error('BPLEngine: 缺少 contract');
    if (!rules) throw new Error('BPLEngine: 缺少 rules');

    const champions = contract.champions || {};
    const sources = contract.sources || {};
    const dims = (rules.dimensions || []).map(d => d.key);
    const dimMeta = {};
    (rules.dimensions || []).forEach(d => { dimMeta[d.key] = d; });
    const levelLabels = rules.levelLabels || {};
    const disclaimers = rules.disclaimers || {};
    const candidateCfg = rules.candidate || {};

    // ---------- 基础查询 ----------
    function champ(key) {
      return Object.prototype.hasOwnProperty.call(champions, key) ? champions[key] : null;
    }

    function roleData(key, role) {
      const c = champ(key);
      if (!c) return null;
      return c.roles && c.roles[role] ? c.roles[role] : null;
    }

    function allChampions() {
      return Object.keys(champions).map(k => champions[k]);
    }

    function sourceInfo(sourceKey) {
      return sources[sourceKey] || null;
    }

    function meta(key, role) {
      const rd = roleData(key, role);
      if (!rd || !rd.meta || rd.meta.source == null) {
        return { status: 'NOT_PROVIDED', source: null, note: '源端未提供该英雄在该分路的统计' };
      }
      return {
        status: 'KNOWN',
        winRate: rd.meta.winRate,
        pickRate: rd.meta.pickRate,
        banRate: rd.meta.banRate,
        tier: rd.meta.tier,
        rank: rd.meta.rank,
        play: rd.meta.play,
        kda: rd.meta.kda,
        source: rd.meta.source,
        sourceLabel: (sourceInfo(rd.meta.source) || {}).label || rd.meta.source,
        cohortConfirmed: rd.meta.cohortConfirmed,
        cohortNote: (sourceInfo(rd.meta.source) || {}).cohortNote,
        sampleN: rd.meta.play == null ? null : rd.meta.play,
        sampleNDefinition: '分路对局场次（源端 play 字段）',
        retrievedAt: rd.meta.retrievedAt,
        fieldSemanticsStatus: (sourceInfo(rd.meta.source) || {}).fieldSemanticsStatus,
      };
    }

    // ---------- 战术标签 ----------
    function traits(key, role) {
      const c = champ(key);
      const out = {};
      const defaultTraits = (c && c.traits && c.traits.default) || {};
      const overrides = (c && c.traits && c.traits.roles && c.traits.roles[role]) || {};
      dims.forEach(d => {
        const base = defaultTraits[d] || UNKNOWN_TRAIT;
        const over = overrides[d];
        out[d] = over
          ? { level: over.level, reviewStatus: over.reviewStatus, evidence: over.evidence || [], roleOverridden: true }
          : { level: base.level, reviewStatus: base.reviewStatus, evidence: base.evidence || [], roleOverridden: false };
      });
      return out;
    }

    function traitFor(key, role, dimension) {
      return traits(key, role)[dimension] || UNKNOWN_TRAIT;
    }

    // ---------- 时长条件趋势 ----------
    function trend(key, role) {
      const rd = roleData(key, role);
      if (!rd || !rd.trend) {
        return {
          status: 'NOT_PROVIDED',
          source: null,
          semantics: null,
          sampleN: null,
          buckets: [],
          usable: [],
          flagged: [],
          note: '该英雄在该分路没有最终时长条件统计',
          disclaimer: disclaimers.legacyTrend,
        };
      }
      const t = rd.trend;
      const buckets = (t.buckets || []).map(b => ({
        key: b.key,
        label: b.label,
        rate: b.rate,
        average: b.average,
        rank: b.rank,
        sampleN: b.sampleN == null ? null : b.sampleN,
        flag: b.flag || 'OK',
        note: b.note || '',
      }));
      const usable = buckets.filter(b => b.flag === 'OK' && typeof b.rate === 'number');
      const flagged = buckets.filter(b => b.flag !== 'OK');
      return {
        status: 'KNOWN',
        source: t.source,
        sourceLabel: (sourceInfo(t.source) || {}).label || t.source,
        semantics: t.semantics,
        confirmedCohort: t.confirmedCohort || null,
        fieldSemanticsStatus: (sourceInfo(t.source) || {}).fieldSemanticsStatus,
        sampleN: t.sampleN == null ? null : t.sampleN,
        buckets,
        usable,
        flagged,
        partial: flagged.length > 0,
        note: disclaimers.noSampleN,
        disclaimer: disclaimers.legacyTrend,
      };
    }

    /**
     * 单英雄的阶段参考值。只使用未被标记的时长桶，并显式告知排除了哪些桶。
     * 这是"该英雄自己的条件趋势"，不是队伍强度。
     */
    function championTrendSummary(key, role) {
      const t = trend(key, role);
      if (t.status !== 'KNOWN') return { status: 'NOT_PROVIDED', early: null, mid: null, late: null, excluded: [], partial: false };
      const pick = keys => {
        const vals = t.buckets
          .filter(b => keys.includes(b.key) && b.flag === 'OK' && typeof b.rate === 'number')
          .map(b => Number(b.rate) - Number(b.average == null ? 50 : b.average));
        if (!vals.length) return null;
        return vals.reduce((a, b) => a + b, 0) / vals.length;
      };
      return {
        status: 'KNOWN',
        early: pick(['<25']),
        mid: pick(['25-30', '30-35']),
        late: pick(['35-40', '40+']),
        excluded: t.flagged.map(b => b.key),
        partial: t.flagged.length > 0,
        source: t.source,
      };
    }

    // ---------- 协同 / 对位 ----------
    function synergyEntry(keyA, roleA, keyB, roleB) {
      const rd = roleData(keyA, roleA);
      const list = ((rd && rd.synergies) || []);
      const exact = list.find(x => x.key === keyB && x.position === roleB);
      if (exact) {
        return {
          status: 'KNOWN',
          perspective: 'DIRECT',
          winRate: exact.winRate,
          play: exact.play,
          position: exact.position,
          scoreRank: exact.scoreRank,
          lowSample: typeof exact.play === 'number' && exact.play < 50,
          source: 'OPGG_MCP',
        };
      }
      const otherPosition = list.find(x => x.key === keyB);
      if (otherPosition) {
        return {
          status: 'NOT_PROVIDED',
          perspective: 'POSITION_MISMATCH',
          note: `源端只有 ${keyB} 在 ${otherPosition.position || '未知位置'} 的协同记录，不能当作 ${ROLE_LABELS[roleB] || roleB} 的协同统计`,
          position: otherPosition.position,
        };
      }
      return null;
    }

    function synergy(keyA, roleA, keyB, roleB) {
      const forward = synergyEntry(keyA, roleA, keyB, roleB);
      if (forward && forward.status === 'KNOWN') return forward;
      const backward = synergyEntry(keyB, roleB, keyA, roleA);
      if (backward && backward.status === 'KNOWN') return Object.assign({}, backward, { perspective: 'REVERSED' });
      if (forward) return forward;   // 位置不匹配，保留原因
      if (backward) return backward;
      return {
        status: 'NOT_PROVIDED',
        perspective: 'NONE',
        note: '官方协同统计中没有该组合记录',
      };
    }

    /**
     * 同路对位。方向必须可辨：记录永远属于"被分析英雄"的视角。
     * 若只找到对手的分析记录，则反向换算，并标记 perspective=REVERSED。
     */
    function counter(key, role, oppKey) {
      const roleEntry = roleData(key, role);
      const own = ((roleEntry && roleEntry.counters) || []).find(x => x.key === oppKey);
      if (own) {
        return {
          status: 'KNOWN',
          perspective: 'DIRECT',
          ourWinRate: own.myWinRate,
          theirWinRate: own.counterWinRate,
          play: own.play,
          direction: own.direction,
          source: 'OPGG_MCP',
          lowSample: typeof own.play === 'number' && own.play < 50,
        };
      }
      const oppEntry = roleData(oppKey, role);
      const mirrored = ((oppEntry && oppEntry.counters) || []).find(x => x.key === key);
      if (mirrored) {
        return {
          status: 'KNOWN',
          perspective: 'REVERSED',
          ourWinRate: typeof mirrored.counterWinRate === 'number' ? mirrored.counterWinRate : null,
          theirWinRate: mirrored.myWinRate,
          play: mirrored.play,
          direction: mirrored.direction === 'strong' ? 'weak' : mirrored.direction === 'weak' ? 'strong' : mirrored.direction,
          source: 'OPGG_MCP',
          lowSample: typeof mirrored.play === 'number' && mirrored.play < 50,
          note: '该数值来自对手视角记录的反向换算',
        };
      }
      return {
        status: 'NOT_PROVIDED',
        perspective: 'NONE',
        ourWinRate: null,
        theirWinRate: null,
        note: '该分路没有返回双方的 counter 统计',
      };
    }

    // ---------- 阵容结构 ----------
    function members(picks) {
      const out = [];
      ROLES.forEach(role => {
        const key = picks && picks[role];
        if (!key) return;
        const c = champ(key);
        if (!c) return;
        const rd = roleData(key, role);
        out.push({
          role,
          key,
          champion: c,
          traits: traits(key, role),
          damageType: (rd && rd.damageType) || null,
          meta: meta(key, role),
        });
      });
      return out;
    }

    function dimStatus(memberList, dimension) {
      const counts = { WEAK: 0, MEDIUM: 0, STRONG: 0, UNREVIEWED: 0 };
      const contributors = [];
      memberList.forEach(m => {
        const entry = m.traits[dimension] || UNKNOWN_TRAIT;
        counts[entry.level] = (counts[entry.level] || 0) + 1;
        if (isReviewed(entry)) contributors.push({ role: m.role, key: m.key, name: m.champion.name, level: entry.level, evidence: entry.evidence });
      });
      const reviewedCount = contributors.length;
      let status = 'UNKNOWN';
      if (reviewedCount > 0) {
        const best = contributors.reduce((a, b) => (rankOf(b.level) > rankOf(a.level) ? b : a));
        status = best.level;
      }
      return { dimension, counts, reviewedCount, status, contributors };
    }

    function damageMix(memberList) {
      const counts = { AP: 0, AD: 0, BOTH: 0, UNKNOWN: 0 };
      memberList.forEach(m => {
        if (m.damageType === 'AP') counts.AP += 1;
        else if (m.damageType === 'AD') counts.AD += 1;
        else if (m.damageType === 'BOTH') counts.BOTH += 1;
        else counts.UNKNOWN += 1;
      });
      const pure = counts.AP + counts.AD;
      const single = pure >= 2 && (counts.AP === 0 || counts.AD === 0);
      const label = counts.BOTH > 0 || (counts.AP > 0 && counts.AD > 0)
        ? '混合伤害'
        : counts.AP > 0 ? '纯魔法伤害' : counts.AD > 0 ? '纯物理伤害' : '伤害类型未知';
      return { counts, single, label, source: 'OPGG_MCP', note: '源端返回的英雄-分路伤害类型，未独立复核' };
    }

    function evaluateGapRule(rule, memberList, enemyList) {
      const cond = rule.condition || {};
      const dimsOf = list => {
        const map = {};
        dims.forEach(d => { map[d] = dimStatus(list, d); });
        return map;
      };
      const own = dimsOf(memberList);

      if (cond.type === 'NO_LEVEL_AT_LEAST') {
        const target = own[cond.dimension];
        if (!target || target.reviewedCount === 0) return null;  // 未知不等于缺失
        const has = target.contributors.some(c => atLeast(c.level, cond.level));
        if (has) return null;
        return {
          id: rule.id,
          severity: rule.severity,
          dimension: cond.dimension,
          dimensionLabel: (dimMeta[cond.dimension] || {}).label || cond.dimension,
          threshold: cond.level,
          title: rule.title,
          detail: rule.detail,
          evidence: target.contributors,
          reviewStatus: rule.reviewStatus,
          reviewedPatch: rule.reviewedPatch,
        };
      }

      if (cond.type === 'ENEMY_AT_LEAST_AND_NO_OWN') {
        if (!enemyList || !enemyList.length) return null;
        const enemyDims = dimsOf(enemyList);
        const enemyTarget = enemyDims[cond.enemyDimension];
        const ownTarget = own[cond.ownDimension];
        if (!enemyTarget || enemyTarget.reviewedCount === 0) return null;
        if (!ownTarget || ownTarget.reviewedCount === 0) return null;
        const enemyHas = enemyTarget.contributors.some(c => atLeast(c.level, cond.enemyLevel));
        if (!enemyHas) return null;
        const ownHas = ownTarget.contributors.some(c => atLeast(c.level, cond.ownLevel));
        if (ownHas) return null;
        return {
          id: rule.id,
          severity: rule.severity,
          dimension: cond.ownDimension,
          dimensionLabel: (dimMeta[cond.ownDimension] || {}).label || cond.ownDimension,
          title: rule.title,
          detail: rule.detail,
          evidence: ownTarget.contributors,
          enemyEvidence: enemyTarget.contributors,
          reviewStatus: rule.reviewStatus,
          reviewedPatch: rule.reviewedPatch,
        };
      }

      if (cond.type === 'DAMAGE_MIX_SINGLE') {
        const mix = damageMix(memberList);
        const reviewedDamage = mix.counts.AP + mix.counts.AD + mix.counts.BOTH;
        if (reviewedDamage < (cond.minReviewed || 3)) return null;
        if (!mix.single) return null;
        return {
          id: rule.id,
          severity: rule.severity,
          dimension: 'damageMix',
          dimensionLabel: '伤害类型组成',
          title: rule.title,
          detail: rule.detail,
          evidence: memberList.map(m => ({ role: m.role, name: m.champion.name, level: m.damageType })),
          reviewStatus: rule.reviewStatus,
          reviewedPatch: rule.reviewedPatch,
        };
      }

      return null;
    }

    function structure(picks, enemyPicks) {
      const memberList = members(picks);
      const enemyList = enemyPicks ? members(enemyPicks) : null;
      const dimsOut = {};
      dims.forEach(d => { dimsOut[d] = dimStatus(memberList, d); });
      const gaps = [];
      if (memberList.length >= 3) {
        (rules.gapRules || []).forEach(rule => {
          const hit = evaluateGapRule(rule, memberList, enemyList);
          if (hit) gaps.push(hit);
        });
        gaps.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
      }
      const reviewedMembers = memberList.filter(m => Object.keys(m.traits).some(d => isReviewed(m.traits[d]))).length;
      return {
        members: memberList,
        dims: dimsOut,
        gaps,
        gapGate: memberList.length >= 3 ? 'EVALUATED' : 'NEEDS_3_PICKS',
        damageMix: damageMix(memberList),
        reviewedMembers,
        unreviewedMembers: memberList.length - reviewedMembers,
        ruleVersion: (rules.meta || {}).ruleVersion,
      };
    }

    function evaluateConflictRule(rule, allyStructure, enemyStructure) {
      const when = rule.when || {};
      const allyDims = allyStructure.dims;
      const enemyDims = enemyStructure.dims;

      const check = (dimsMap, spec) => {
        if (!spec) return true;
        return Object.keys(spec).every(dim => {
          const stat = dimsMap[dim];
          if (!stat || stat.reviewedCount === 0) return false;
          return stat.contributors.some(c => atLeast(c.level, spec[dim]));
        });
      };

      if (when.allyAtLeast && !check(allyDims, when.allyAtLeast)) return null;
      if (when.enemyAtLeast) {
        if (!enemyStructure.members.length) return null;
        if (!check(enemyDims, when.enemyAtLeast)) return null;
      }
      if (when.allyMissing) {
        const missing = when.allyMissing.every(dim => {
          const stat = allyDims[dim];
          if (!stat || stat.reviewedCount === 0) return false;
          return !stat.contributors.some(c => atLeast(c.level, 'MEDIUM'));
        });
        if (!missing) return null;
      }
      if (when.allyDamageSingle && !allyStructure.damageMix.single) return null;

      return {
        id: rule.id,
        severity: rule.severity,
        title: rule.title,
        reason: rule.reason,
        counterexample: rule.counterexample,
        reviewStatus: rule.reviewStatus,
        reviewedPatch: rule.reviewedPatch,
      };
    }

    function conflicts(allyStructure, enemyStructure) {
      if (!allyStructure || !allyStructure.members.length) return [];
      const enemy = enemyStructure || { members: [], dims: {} };
      return (rules.conflictRules || [])
        .map(rule => evaluateConflictRule(rule, allyStructure, enemy))
        .filter(Boolean)
        .sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0));
    }

    // ---------- 候选推荐（分层，不给总分） ----------
    function collectCandidates(ctx) {
      const side = ctx.side;
      const allyPicks = ctx.picks || {};
      const enemyPicks = ctx.enemyPicks || {};
      const bans = new Set(ctx.bans || []);
      const used = new Set([
        ...Object.values(allyPicks).filter(Boolean),
        ...Object.values(enemyPicks).filter(Boolean),
        ...bans,
      ]);
      const allyStructure = structure(allyPicks, enemyPicks);
      const enemyStructure = structure(enemyPicks, allyPicks);
      const enemyConflicts = conflicts(allyStructure, enemyStructure);
      const openRoles = ROLES.filter(r => !allyPicks[r]);
      const gapDims = [];
      allyStructure.gaps.forEach(g => {
        if (g.severity === 'HIGH' || g.severity === 'MEDIUM') {
          if (dims.includes(g.dimension) && !gapDims.includes(g.dimension)) gapDims.push(g.dimension);
        }
      });

      const out = [];
      openRoles.forEach(role => {
        allChampions().forEach(c => {
          if (used.has(c.key)) return;
          if (!c.positions || !c.positions.includes(role)) return;
          const t = traits(c.key, role);
          const filled = [];
          gapDims.forEach(d => {
            if (atLeast((t[d] || UNKNOWN_TRAIT).level, 'MEDIUM')) filled.push(d);
          });
          const m = meta(c.key, role);
          const enemyKey = enemyPicks[role] || null;
          const counterInfo = enemyKey ? counter(c.key, role, enemyKey) : null;
          const partnerKeys = ROLES.filter(r => r !== role && allyPicks[r]).map(r => ({ role: r, key: allyPicks[r] }));
          const combo = partnerKeys
            .map(p => ({ partner: p, data: synergy(c.key, role, p.key, p.role) }))
            .filter(x => x.data.status === 'KNOWN');

          const risks = [];
          const unknowns = [];
          const unreviewedDims = dims.filter(d => !isReviewed(t[d]));
          if (unreviewedDims.length) {
            unknowns.push(`该英雄有 ${unreviewedDims.length}/10 维战术标签未审核，阵容缺口判断不完整`);
          }
          if (m.status !== 'KNOWN') unknowns.push('源端未提供该英雄在该分路的统计');
          else if (!m.cohortConfirmed) unknowns.push('该分路统计的地区/段位口径未确认');
          if (enemyKey && counterInfo && counterInfo.status === 'KNOWN' && typeof counterInfo.ourWinRate === 'number' && counterInfo.ourWinRate < 50) {
            risks.push(`同路对位劣势（我方 ${counterInfo.ourWinRate}% vs ${counterInfo.theirWinRate}%，${counterInfo.play} 场）`);
          }
          if (enemyKey && counterInfo && counterInfo.status === 'NOT_PROVIDED') {
            unknowns.push('该位置没有返回同路对位统计');
          }
          enemyConflicts.forEach(cf => {
            risks.push(...[]);  // 反向冲突已在队伍层面提示，候选卡片不重复堆叠
          });

          out.push({
            key: c.key,
            role,
            champion: c,
            legal: true,
            fillsGaps: filled,
            meta: m,
            counter: counterInfo,
            combos: combo,
            risks,
            unknowns,
            unreviewedDims,
            layers: {
              LEGAL: 'PASS',
              GAP: filled.length ? `FILLS:${filled.join(',')}` : 'NO_FILL',
              META: m.status === 'KNOWN' ? `TIER_${m.tier == null ? 'NA' : m.tier}·RANK_${m.rank == null ? 'NA' : m.rank}` : 'NOT_PROVIDED',
              RISK: risks.length ? `${risks.length}_RISK` : unknowns.length ? `${unknowns.length}_UNKNOWN` : 'NONE',
            },
          });
        });
      });

      const gapPriority = candidateCfg.gapPriority || { HIGH: 3, MEDIUM: 2, LOW: 1 };
      const severityOf = dim => {
        const g = allyStructure.gaps.filter(x => x.dimension === dim);
        if (!g.length) return 0;
        return Math.max(...g.map(x => gapPriority[x.severity] || 0));
      };
      const gapScore = c => c.fillsGaps.reduce((sum, d) => sum + severityOf(d), 0);
      const tierScore = c => (c.meta && c.meta.tier != null ? c.meta.tier : 99);
      const winScore = c => (c.meta && c.meta.winRate != null ? -c.meta.winRate : 0);

      out.sort((a, b) => {
        const gs = gapScore(b) - gapScore(a);
        if (gs) return gs;
        const ts = tierScore(a) - tierScore(b);
        if (ts) return ts;
        const ws = winScore(a) - winScore(b);
        if (ws) return ws;
        return a.champion.name.localeCompare(b.champion.name, 'zh-CN');
      });

      const limit = candidateCfg.maxCandidates || 5;
      const grouped = {};
      ROLES.forEach(r => { grouped[r] = out.filter(c => c.role === r).slice(0, limit); });
      return {
        side,
        roles: grouped,
        gaps: allyStructure.gaps,
        conflicts: enemyConflicts,
        allyStructure,
        enemyStructure,
        rankingNote: disclaimers.noPrediction,
        layerNote: '按 硬性约束 → 阵容缺口补位 → 同口径官方统计 → 风险与未知 分层排序，不计算综合分',
      };
    }

    // ---------- 规则型阶段倾向（不是胜率） ----------
    // 权重唯一来源：data/bp_rules.json 的 phase 段（可由 tests/eval_phase.py 重新校准）。
    // 缺失时回退到旧常量，避免旧缓存页面崩溃。
    const PHASE_FALLBACK = {
      early: { scaling: -0.283, engage: -0.253, waveclear: -0.123, burst: 0.120, splitpush: 0.101,
               frontline: -0.093, poke: -0.078, peel: 0.030, dps: 0.013, dive: -0.002 },
      mid: { engage: 0.2, frontline: 0.15, waveclear: 0.15, dps: 0.15, burst: 0.15, peel: 0.2 },
      late: { scaling: 0.35, dps: 0.3, frontline: 0.15, splitpush: 0.1, peel: 0.1 },
    };
    const phaseCfg = (rules && rules.phase) || {};
    const PHASE_W = {
      early: (phaseCfg.early && phaseCfg.early.weights) || PHASE_FALLBACK.early,
      mid: (phaseCfg.mid && phaseCfg.mid.weights) || PHASE_FALLBACK.mid,
      late: (phaseCfg.late && phaseCfg.late.weights) || PHASE_FALLBACK.late,
    };
    const LEVEL_VAL = { STRONG: 1, MEDIUM: 0, WEAK: -1 };
    const COVERAGE_DIMS = ['engage', 'peel', 'frontline', 'waveclear', 'poke', 'splitpush'];

    function phaseValue(traitsOfChamp, phase) {
      let sum = 0;
      let w = 0;
      Object.entries(PHASE_W[phase]).forEach(([dim, weight]) => {
        const entry = traitsOfChamp[dim] || UNKNOWN_TRAIT;
        if (!isReviewed(entry)) return;
        sum += weight * (LEVEL_VAL[entry.level] || 0);
        w += Math.abs(weight);   // 早期权重含负号，按绝对值归一
      });
      return w > 0 ? sum / w : null;
    }

    /** 单个英雄-分路的规则型阶段倾向（-1 ~ +1，覆盖率另报）。 */
    function championPhases(key, role) {
      const t = traits(key, role);
      const out = {
        early: phaseValue(t, 'early'),
        mid: phaseValue(t, 'mid'),
        late: phaseValue(t, 'late'),
        coverage: dims.filter(d => isReviewed(t[d])).length,
      };
      return out;
    }

    /**
     * 队伍规则型阶段倾向：成员均值 + 能力覆盖加成 − 重复惩罚。
     * 明确是"规则解释"，不是胜率、不是预测。
     */
    function teamPhases(picks) {
      const memberList = members(picks);
      if (!memberList.length) return null;
      const phases = { early: [], mid: [], late: [] };
      memberList.forEach(m => {
        const p = championPhases(m.key, m.role);
        ['early', 'mid', 'late'].forEach(k => { if (p[k] != null) phases[k].push(p[k]); });
      });
      const avg = {};
      ['early', 'mid', 'late'].forEach(k => {
        avg[k] = phases[k].length ? phases[k].reduce((a, b) => a + b, 0) / phases[k].length : null;
      });
      // 能力覆盖：某个维度至少一人达到 STRONG/MEDIUM
      const covered = [];
      COVERAGE_DIMS.forEach(d => {
        if (memberList.some(m => atLeast((m.traits[d] || UNKNOWN_TRAIT).level, 'MEDIUM'))) covered.push(d);
      });
      const coverageBonus = Math.min(0.15, covered.length * 0.025);
      // 重复惩罚：同一维度 3 人以上 STRONG 视为冗余
      let redundancy = 0;
      dims.forEach(d => {
        const strong = memberList.filter(m => (m.traits[d] || UNKNOWN_TRAIT).level === 'STRONG').length;
        if (strong >= 3) redundancy += 0.03;
      });
      const out = { coverage: covered, coverageBonus: Number(coverageBonus.toFixed(3)), redundancy: Number(redundancy.toFixed(3)) };
      ['early', 'mid', 'late'].forEach(k => {
        out[k] = avg[k] == null ? null : Number(Math.max(-1, Math.min(1, avg[k] + coverageBonus - redundancy)).toFixed(3));
      });
      out.reviewed = memberList.filter(m => dims.some(d => isReviewed(m.traits[d]))).length;
      out.coverageCount = `${out.reviewed}/${memberList.length}`;
      out.earlySource = (phaseCfg.early && phaseCfg.early.source) || 'fallback';
      out.earlyCalibration = (phaseCfg.early && phaseCfg.early.calibration) || null;
      out.label = '阶段倾向（早期已校准 · 中后期规则推断，非胜率）';
      return out;
    }

    // ---------- 下一手预测：适配度拆解 ----------
    // 每一项都来自可追溯来源；缺失项不计 0 分，而是退出分母后按覆盖权重重算。
    // 输出是"适配度"排序，不是胜率、不是概率。
    const fitCfg = rules.fit || {};
    const FIT_WEIGHTS = fitCfg.weights || { gap: 40, combo: 20, counter: 15, meta: 15, damage: 10 };
    const FIT_LABELS = fitCfg.labels || {};
    const FIT_CONF = fitCfg.confidence || { HIGH: 0.85, MEDIUM: 0.6 };
    const FIT_ROLE_PENALTY = typeof fitCfg.rolePenalty === 'number' ? fitCfg.rolePenalty : 5;
    const GAP_WEIGHT = { HIGH: 3, MEDIUM: 2, LOW: 1 };
    const FIT_TOTAL_WEIGHT = Object.keys(FIT_WEIGHTS).reduce((sum, k) => sum + FIT_WEIGHTS[k], 0);
    const roleIndexCache = Object.create(null);

    const clamp01 = v => Math.max(0, Math.min(1, v));

    /** 同分路内把"排名 + 胜率"归一成 0–1 的可比分数（只在同一分路内比较）。 */
    function roleMetaIndex(role) {
      if (roleIndexCache[role]) return roleIndexCache[role];
      const entries = [];
      allChampions().forEach(c => {
        const rd = c.roles && c.roles[role];
        if (!rd || !rd.meta || rd.meta.winRate == null) return;
        entries.push({
          key: c.key,
          winRate: Number(rd.meta.winRate),
          pickRate: typeof rd.meta.pickRate === 'number' ? Number(rd.meta.pickRate) : 0,
          rank: rd.meta.rank == null ? null : Number(rd.meta.rank),
        });
      });
      const map = new Map();
      if (!entries.length) { roleIndexCache[role] = map; return map; }
      let maxPickRate = 0;
      entries.forEach(e => { if (e.pickRate > maxPickRate) maxPickRate = e.pickRate; });
      const winRates = entries.map(e => e.winRate);
      const minW = Math.min.apply(null, winRates);
      const maxW = Math.max.apply(null, winRates);
      const ranks = entries.filter(e => e.rank != null).map(e => e.rank);
      const maxRank = ranks.length ? Math.max.apply(null, ranks) : 1;
      entries.forEach(e => {
        const rankPct = e.rank == null || maxRank <= 1 ? 0.5 : 1 - (e.rank - 1) / (maxRank - 1);
        const wrPct = maxW > minW ? (e.winRate - minW) / (maxW - minW) : 0.5;
        map.set(e.key, {
          rankPct: rankPct,
          wrPct: wrPct,
          score: 0.6 * rankPct + 0.4 * wrPct,
          pickRatePct: maxPickRate > 0 ? e.pickRate / maxPickRate : 0,
        });
      });
      roleIndexCache[role] = map;
      return map;
    }

    /** 伤害类型是否补上了队伍的单一伤害短板。 */
    function damageFitStatus(memberList, candidateDamageType) {
      if (memberList.length < 2) {
        return { status: 'NEEDS_3_PICKS', raw: null, note: '需要至少 2 名已选英雄才能判断伤害结构' };
      }
      const mix = damageMix(memberList);
      if (!mix.single) {
        return { status: 'NEUTRAL', raw: null, note: '队伍伤害类型尚未单一化，不作为区分项' };
      }
      const need = mix.counts.AP === 0 ? 'AP' : mix.counts.AD === 0 ? 'AD' : null;
      if (!need) return { status: 'NEUTRAL', raw: null, note: '无法判断缺少的伤害类型' };
      if (!candidateDamageType) {
        return { status: 'UNKNOWN', raw: null, note: '该候选没有伤害类型数据' };
      }
      if (candidateDamageType === need) return { status: 'KNOWN', raw: 1, note: `补上缺少的 ${need} 伤害` };
      if (candidateDamageType === 'BOTH') return { status: 'KNOWN', raw: 0.75, note: '混合伤害，部分补足' };
      return { status: 'KNOWN', raw: 0, note: `仍是 ${candidateDamageType}，没有改善单一伤害` };
    }

    /**
     * 按已选英雄的"维度最强值"算结构缺口（不要求 3 人，1 人起就能给出方向）。
     * 未审核维度直接跳过——未知不当作弱。
     */
    function dimensionDeficits(memberList) {
      const out = [];
      dims.forEach(d => {
        const levels = memberList
          .map(m => m.traits[d] || UNKNOWN_TRAIT)
          .filter(e => isReviewed(e))
          .map(e => rankOf(e.level));
        if (!levels.length) return;
        const best = Math.max.apply(null, levels);
        const deficit = 2 - best;
        if (deficit > 0) {
          out.push({ dimension: d, deficit: deficit, best: best, label: (dimMeta[d] || {}).label || d });
        }
      });
      return out;
    }

    /**
     * 预测当前这一手的候选英雄。
     * @param {{side?:string, picks?:object, enemyPicks?:object, bans?:string[], role?:string, limit?:number}} ctx
     */
    function predict(ctx) {
      const opts = ctx || {};
      const allyPicks = opts.picks || {};
      const enemyPicks = opts.enemyPicks || {};
      const bans = new Set(opts.bans || []);
      const used = new Set([
        ...Object.values(allyPicks).filter(Boolean),
        ...Object.values(enemyPicks).filter(Boolean),
        ...bans,
      ]);
      const openRoles = opts.role ? [opts.role] : ROLES.filter(r => !allyPicks[r]);
      const allyStructure = structure(allyPicks, enemyPicks);
      const activeGaps = allyStructure.gaps.filter(g => g.severity === 'HIGH' || g.severity === 'MEDIUM');
      const gapWeightTotal = activeGaps.reduce((sum, g) => sum + (GAP_WEIGHT[g.severity] || 0), 0);
      const limit = opts.limit || 8;
      const items = [];

      openRoles.forEach(role => {
        const index = roleMetaIndex(role);
        allChampions().forEach(c => {
          if (used.has(c.key)) return;
          if (!c.positions || !c.positions.includes(role)) return;

          const t = traits(c.key, role);
          const parts = [];

          // 1) 阵容缺口 / 结构补位
          //    3 人以上：用正式缺口规则（HIGH/MEDIUM）
          //    不足 3 人：用"各维度最强值"的缺口，1 人起就能给出方向
          if (activeGaps.length) {
            const filled = activeGaps.filter(g => atLeast((t[g.dimension] || UNKNOWN_TRAIT).level, 'MEDIUM'));
            const gained = filled.reduce((sum, g) => sum + (GAP_WEIGHT[g.severity] || 0), 0);
            parts.push({
              key: 'gap',
              weight: FIT_WEIGHTS.gap,
              status: 'KNOWN',
              raw: gapWeightTotal > 0 ? gained / gapWeightTotal : null,
              evidence: filled.length ? filled.map(g => g.title) : ['没有补上当前缺口'],
            });
          } else if (allyStructure.members.length >= 1) {
            const deficits = dimensionDeficits(allyStructure.members);
            const totalDeficit = deficits.reduce((sum, d) => sum + d.deficit, 0);
            if (!totalDeficit) {
              parts.push({ key: 'gap', weight: FIT_WEIGHTS.gap, status: 'NEUTRAL', raw: null, evidence: ['已选英雄在已审核维度上都不弱'] });
            } else {
              const gained = deficits.reduce((sum, d) => {
                const cand = (t[d.dimension] || UNKNOWN_TRAIT);
                if (!isReviewed(cand)) return sum;           // 候选未审核：这项不加也不减
                return sum + Math.min(d.deficit, rankOf(cand.level));
              }, 0);
              const filledNames = deficits
                .filter(d => isReviewed(t[d.dimension] || UNKNOWN_TRAIT) && atLeast(t[d.dimension].level, 'MEDIUM'))
                .map(d => `${d.label}（当前${['弱', '中', '强'][d.best]}）`);
              parts.push({
                key: 'gap',
                weight: FIT_WEIGHTS.gap,
                status: 'KNOWN',
                raw: gained / totalDeficit,
                evidence: filledNames.length ? filledNames : ['没有补上当前短板'],
                partial: allyStructure.members.length < 3,
              });
            }
          } else {
            parts.push({ key: 'gap', weight: FIT_WEIGHTS.gap, status: 'UNKNOWN', raw: null, evidence: ['还没有已选英雄，无法判断结构需求'] });
          }

          // 2) 与已选队友的官方协同
          const partners = ROLES
            .filter(r => r !== role && allyPicks[r])
            .map(r => ({ role: r, key: allyPicks[r] }));
          const knownPairs = partners
            .map(pair => ({ partner: pair, data: synergy(c.key, role, pair.key, pair.role) }))
            .filter(x => x.data.status === 'KNOWN' && typeof x.data.winRate === 'number');
          if (knownPairs.length) {
            const meanDelta = knownPairs.reduce((sum, x) => sum + (Number(x.data.winRate) - 50), 0) / knownPairs.length;
            parts.push({
              key: 'combo',
              weight: FIT_WEIGHTS.combo,
              status: 'KNOWN',
              raw: clamp01(0.5 + meanDelta / 12),
              evidence: knownPairs.map(x => {
                const pc = champ(x.partner.key);
                return `${pc ? pc.name : x.partner.key} ${x.data.winRate}% / ${x.data.play} 场`;
              }),
              pairs: knownPairs,
            });
          } else {
            parts.push({
              key: 'combo', weight: FIT_WEIGHTS.combo, status: 'UNKNOWN', raw: null,
              evidence: [partners.length ? '官方协同统计里没有这些组合' : '还没有已选队友'],
            });
          }

          // 3) 同路对位（敌方该位置已锁定才算）
          const enemyKey = enemyPicks[role] || null;
          if (!enemyKey) {
            parts.push({ key: 'counter', weight: FIT_WEIGHTS.counter, status: 'UNKNOWN', raw: null, evidence: ['敌方该位置未锁定'] });
          } else {
            const info = counter(c.key, role, enemyKey);
            if (info.status === 'KNOWN' && typeof info.ourWinRate === 'number') {
              parts.push({
                key: 'counter', weight: FIT_WEIGHTS.counter, status: 'KNOWN',
                raw: clamp01(0.5 + (info.ourWinRate - 50) / 12),
                evidence: [`${info.ourWinRate}% / ${info.play} 场${info.perspective === 'REVERSED' ? '（反向记录）' : ''}`],
              });
            } else {
              parts.push({ key: 'counter', weight: FIT_WEIGHTS.counter, status: 'UNKNOWN', raw: null, evidence: ['该位置没有返回对位统计'] });
            }
          }

          // 4) 同口径官方分路表现
          const idx = index.get(c.key) || null;
          if (idx) {
            parts.push({
              key: 'meta', weight: FIT_WEIGHTS.meta, status: 'KNOWN', raw: idx.score,
              evidence: [`排名分位 ${(idx.rankPct * 100).toFixed(0)}%`, `胜率分位 ${(idx.wrPct * 100).toFixed(0)}%`],
            });
          } else {
            parts.push({ key: 'meta', weight: FIT_WEIGHTS.meta, status: 'UNKNOWN', raw: null, evidence: ['源端未提供该分路统计'] });
          }

          // 5) 分路热门度（默认权重 0，只有调参后启用）
          if (FIT_WEIGHTS.popularity) {
            if (idx) {
              parts.push({
                key: 'popularity', weight: FIT_WEIGHTS.popularity, status: 'KNOWN',
                raw: clamp01(idx.pickRatePct),
                evidence: [`分路选取率相对最高值 ${(idx.pickRatePct * 100).toFixed(0)}%`],
              });
            } else {
              parts.push({ key: 'popularity', weight: FIT_WEIGHTS.popularity, status: 'UNKNOWN', raw: null, evidence: ['源端未提供该分路统计'] });
            }
          }

          // 6) 伤害类型平衡
          const rd = roleData(c.key, role);
          const dmg = damageFitStatus(allyStructure.members, (rd && rd.damageType) || null);
          parts.push({ key: 'damage', weight: FIT_WEIGHTS.damage, status: dmg.status, raw: dmg.raw, evidence: [dmg.note] });

          // 汇总：缺失项退出分母
          let covered = 0;
          let acc = 0;
          parts.forEach(p => {
            if (p.status === 'KNOWN' && typeof p.raw === 'number') {
              covered += p.weight;
              acc += p.weight * Math.max(0, Math.min(1, p.raw));
            }
          });
          const coverage = FIT_TOTAL_WEIGHT ? covered / FIT_TOTAL_WEIGHT : 0;
          const rawTotal = covered > 0 ? (acc / covered) * 100 : null;
          // 非首选分路：显式扣分，不在隐藏处做手脚
          const primaryRole = (c.positions && c.positions[0]) || null;
          const rolePenalty = rawTotal != null && primaryRole && primaryRole !== role ? FIT_ROLE_PENALTY : 0;
          const total = rawTotal == null ? null : Math.max(0, Math.min(100, rawTotal - rolePenalty));
          const confidence = coverage >= FIT_CONF.HIGH ? 'HIGH' : coverage >= FIT_CONF.MEDIUM ? 'MEDIUM' : 'LOW';

          const partsOut = parts.map(p => ({
            key: p.key,
            label: FIT_LABELS[p.key] || p.key,
            weight: p.weight,
            status: p.status,
            raw: p.raw,
            points: p.status === 'KNOWN' && typeof p.raw === 'number' ? Number((p.weight * p.raw).toFixed(1)) : null,
            evidence: p.evidence || [],
            partial: !!p.partial,
          }));

          const risks = [];
          const unknowns = [];
          if (coverage < FIT_CONF.HIGH) unknowns.push(`覆盖 ${(coverage * 100).toFixed(0)}% 的评分权重，其余项源端未提供`);
          if (enemyKey) {
            const info = counter(c.key, role, enemyKey);
            if (info.status === 'KNOWN' && typeof info.ourWinRate === 'number' && info.ourWinRate < 50) {
              risks.push(`同路对位劣势 ${info.ourWinRate}% / ${info.play} 场`);
            }
          }
          const unreviewed = dims.filter(d => !isReviewed(t[d]));
          if (unreviewed.length) unknowns.push(`${unreviewed.length}/10 维战术标签未审核`);
          if (!idx) unknowns.push('该分路没有官方统计');
          if (rolePenalty) unknowns.push(`非首选分路（主 ${ROLE_LABELS[primaryRole] || primaryRole}），适配度 −${FIT_ROLE_PENALTY}`);

          items.push({
            key: c.key,
            role,
            champion: c,
            fit: {
              total: total == null ? null : Number(total.toFixed(1)),
              rawTotal: rawTotal == null ? null : Number(rawTotal.toFixed(1)),
              rolePenalty,
              coverage: Number((coverage * 100).toFixed(0)),
              confidence,
              parts: partsOut,
            },
            reasons: partsOut.filter(p => p.status === 'KNOWN' && p.raw > 0.55).map(p => p.label),
            risks,
            unknowns,
          });
        });
      });

      items.sort((a, b) => {
        const at = a.fit.total == null ? -1 : a.fit.total;
        const bt = b.fit.total == null ? -1 : b.fit.total;
        if (bt !== at) return bt - at;
        return a.champion.name.localeCompare(b.champion.name, 'zh-CN');
      });

      const byRole = {};
      openRoles.forEach(role => {
        byRole[role] = items.filter(x => x.role === role).slice(0, limit);
      });

      return {
        roles: openRoles,
        byRole,
        top: items.slice(0, limit),
        gaps: activeGaps,
        modelVersion: fitCfg.version || 'fit-v2.2.1',
        weights: FIT_WEIGHTS,
        note: disclaimers.fitNotProbability,
      };
    }

    return {
      contract,
      rules,
      ROLES,
      ROLE_LABELS,
      dims,
      dimMeta,
      levelLabels,
      disclaimers,
      champ,
      roleData,
      allChampions,
      sourceInfo,
      meta,
      traits,
      traitFor,
      trend,
      championTrendSummary,
      synergy,
      counter,
      structure,
      conflicts,
      members,
      damageMix,
      candidates: collectCandidates,
      championPhases,
      teamPhases,
      predict,
      levelRank: rankOf,
      atLeast,
      isReviewed,
    };
  }

  return {
    createEngine,
    LEVEL_RANK,
    LEVEL_KEYS,
    ROLES,
    ROLE_LABELS,
    rankOf,
    atLeast,
  };
});
