#!/usr/bin/env python3
"""BP LAB · 真实 BP 顺序回测（LoL-Draft 2026，CC BY-SA 4.0）

数据：/tmp/lol_draft_2026.inter
  - 每场比赛 2 个 user（两队），每队 10 行：5 ban + 5 pick，timestamp 为全局操作序号（0–19）
  - 合并两队即可还原真实 20 手选禁顺序
  - 字段：item_id（英雄数字 id）、hero_name、action_type、patch、team_result、first_team

回测：
  按真实顺序逐手推进；每次「pick」动作发生时，用当前合法英雄集合生成排序，
  看真实英雄排在 Top-k。对比：
    M0 随机（理论值）
    M1 热门度（分路选取率）
    M2 热门度 + 版本表现（梯队/排名/胜率）
    M3 完整适配度（缺口/协同/对位/伤害/热门度，权重同产品）

限制：
  - 数据集没有「位置」，用英雄最热门分路近似（这是回测近似，不是真实分路）
  - 指标是「模仿真实选人」，不是「推荐是否提升胜率」

用法：python3 tests/eval_real_draft.py /tmp/lol_draft_2026.inter
"""
from __future__ import annotations

import csv
import json
import math
import random
import sys
from collections import defaultdict, Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
W = {"gap": 20, "combo": 10, "counter": 5, "meta": 15, "damage": 10, "popularity": 40}
DIMS = ["engage", "peel", "frontline", "poke", "waveclear", "dps", "burst", "splitpush", "dive", "scaling"]
ROLE_RANK = {"WEAK": 0, "MEDIUM": 1, "STRONG": 2}
MAX_ROLE_PICK = defaultdict(float)


def norm(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def load_contract():
    c = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    dd = json.loads((ROOT / "data/ddragon_champion_index.json").read_text(encoding="utf-8"))
    by_norm = {}
    for key, champ in c["champions"].items():
        by_norm[norm(champ.get("ddragonId") or key)] = key
        by_norm[norm(key)] = key
    id2key = {}
    for cid, v in dd.items():
        k = by_norm.get(norm(v["ddragonId"]))
        if k:
            id2key[cid] = k
    return c, id2key


def build_feature_tables(contract):
    """预计算每个英雄的最热门分路、热门度、版本分、标签、协同、对位。"""
    tables = {}
    # 分路内最大选取率
    for key, champ in contract["champions"].items():
        for role, rd in (champ.get("roles") or {}).items():
            meta = rd.get("meta") or {}
            if isinstance(meta.get("pickRate"), (int, float)):
                MAX_ROLE_PICK[role] = max(MAX_ROLE_PICK[role], meta["pickRate"])

    # 分路内排名/胜率归一
    role_stats = defaultdict(list)
    for key, champ in contract["champions"].items():
        for role, rd in (champ.get("roles") or {}).items():
            meta = rd.get("meta") or {}
            if isinstance(meta.get("winRate"), (int, float)) and isinstance(meta.get("rank"), (int, float)):
                role_stats[role].append((key, meta["winRate"], meta["rank"]))
    norm_stats = {}
    for role, lst in role_stats.items():
        max_rank = max(r for _, _, r in lst) or 1
        wrs = [w for _, w, _ in lst]
        lo, hi = min(wrs), max(wrs)
        for key, wr, rank in lst:
            rank_pct = 1 - (rank - 1) / max(1, max_rank - 1)
            wr_pct = (wr - lo) / (hi - lo) if hi > lo else 0.5
            norm_stats[(key, role)] = 0.6 * rank_pct + 0.4 * wr_pct

    for key, champ in contract["champions"].items():
        roles = champ.get("roles") or {}
        # 最热门分路：pickRate 最高
        best_role, best_pick = None, -1
        for role, rd in roles.items():
            pr = (rd.get("meta") or {}).get("pickRate")
            if isinstance(pr, (int, float)) and pr > best_pick:
                best_role, best_pick = role, pr
        if best_role is None:
            continue
        rd = roles[best_role]
        synergy = {}
        for s in rd.get("synergies") or []:
            if s.get("key") and s.get("position"):
                synergy[(s["key"], s["position"])] = s
        counters = {x["key"]: x for x in (rd.get("counters") or []) if x.get("key")}
        traits = {}
        for d in DIMS:
            entry = (champ.get("traits") or {}).get("default", {}).get(d) or {}
            over = ((champ.get("traits") or {}).get("roles", {}).get(best_role) or {}).get(d)
            e = over or entry
            traits[d] = e.get("level") if e.get("level") in ROLE_RANK else "UNREVIEWED"
        tables[key] = {
            "role": best_role,
            "pickRate": best_pick if best_pick > 0 else 0,
            "metaScore": norm_stats.get((key, best_role), 0.5),
            "traits": traits,
            "synergy": synergy,
            "counters": counters,
            "damageType": rd.get("damageType"),
        }
    return tables


def load_games(path: str, id2key: dict):
    """返回 [(match_id, patch, [ (team, action, champion_key), ... ])]"""
    by_match = defaultdict(list)
    with open(path, encoding="utf-8") as f:
        for row in csv.DictReader(f, delimiter="\t"):
            mid = row["match_id:token"]
            team = 0 if row["user_id:token"].endswith("_0") else 1
            key = id2key.get(row["item_id:token"])
            by_match[mid].append({
                "team": team,
                "action": row["action_type:token"],
                "champ": key,
                "name": row["hero_name:token"],
                "ts": float(row["timestamp:float"]),
                "patch": row["patch:float"],
            })
    games = []
    for mid, rows in by_match.items():
        rows.sort(key=lambda r: r["ts"])
        if len(rows) != 20:
            continue
        seq = [(r["team"], r["action"], r["champ"]) for r in rows]
        if any(r["champ"] is None for r in rows):
            continue
        picks = Counter((t, a) for t, a, _ in seq)
        if picks[(0, "pick")] != 5 or picks[(1, "pick")] != 5:
            continue
        games.append((mid, rows[0]["patch"], seq))
    return games


def score_candidate(cand, f, ally_picks, enemy_picks, banned):
    """返回 0–1 的加权适配度（缺失项退出分母）。"""
    parts = {}
    # 1) 结构缺口
    deficits = []
    for d in DIMS:
        levels = [ROLE_RANK[f[a]["traits"][d]] for a in ally_picks if a in f and f[a]["traits"][d] in ROLE_RANK]
        if not levels:
            continue
        deficit = 2 - max(levels)
        if deficit > 0:
            deficits.append((d, deficit))
    total_def = sum(x[1] for x in deficits)
    if total_def:
        cand_rank = ROLE_RANK.get(f[cand]["traits"][deficits[0][0]], -1)
        gained = 0
        for d, deficit in deficits:
            lvl = ROLE_RANK.get(f[cand]["traits"][d], -1)
            if lvl >= 0:
                gained += min(deficit, lvl)
        parts["gap"] = gained / total_def
    # 2) 协同
    known = []
    c_role = f[cand]["role"]
    for a in ally_picks:
        if a not in f:
            continue
        s = f[cand]["synergy"].get((a, f[a]["role"]))
        if s and isinstance(s.get("winRate"), (int, float)):
            known.append(s["winRate"])
    if known:
        parts["combo"] = max(0.0, min(1.0, 0.5 + (sum(known) / len(known) - 50) / 12))
    # 3) 对位
    cs = []
    for e in enemy_picks:
        if e not in f:
            continue
        c = f[cand]["counters"].get(e)
        if c and isinstance(c.get("myWinRate"), (int, float)):
            cs.append(c["myWinRate"])
    if cs:
        parts["counter"] = max(0.0, min(1.0, 0.5 + (sum(cs) / len(cs) - 50) / 12))
    # 4) 版本
    parts["meta"] = f[cand]["metaScore"]
    # 5) 伤害结构
    dmg = [f[a]["damageType"] for a in ally_picks if a in f and f[a]["damageType"]]
    if len(dmg) >= 2:
        ap = sum(1 for x in dmg if x == "AP")
        ad = sum(1 for x in dmg if x == "AD")
        if ap == 0 or ad == 0:
            need = "AP" if ap == 0 else "AD"
            ct = f[cand]["damageType"]
            parts["damage"] = 1.0 if ct == need else (0.75 if ct == "BOTH" else 0.0)
        else:
            parts["damage"] = 0.5
    # 6) 热门度
    role = f[cand]["role"]
    mx = MAX_ROLE_PICK.get(role) or 1
    parts["popularity"] = min(1.0, f[cand]["pickRate"] / mx)

    covered = sum(W[k] for k in parts)
    if covered == 0:
        return -1
    return sum(W[k] * v for k, v in parts.items()) / covered


def rank_of(cands, scores, actual):
    order = sorted(cands, key=lambda c: -scores[c])
    try:
        return order.index(actual) + 1
    except ValueError:
        return len(order) + 1


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/lol_draft_2026.inter"
    contract, id2key = load_contract()
    f = build_feature_tables(contract)
    games = load_games(path, id2key)
    print(f"有效对局 {len(games)}，补丁 {sorted({g[1] for g in games})[:6]}...")

    # 同补丁经验热门度：先统计每个补丁里各英雄被 pick 的次数
    patch_counts = defaultdict(Counter)
    patch_games = Counter()
    for mid, patch, seq in games:
        pkey = str(int(patch))
        patch_games[pkey] += 1
        for team, action, champ in seq:
            if action == "pick":
                patch_counts[pkey][champ] += 1

    metrics = {name: {"n": 0, "top1": 0, "top3": 0, "top5": 0, "rr": 0.0}
               for name in ("pop", "emp", "emp_meta", "full_emp")}
    random_top5 = 0.0
    by_patch = defaultdict(lambda: {"n": 0, "full_top5": 0, "pop_top5": 0})

    for mid, patch, seq in games:
        picked = {0: [], 1: []}
        banned = set()
        legal_count = 0
        for team, action, champ in seq:
            if action == "ban":
                banned.add(champ)
                continue
            legal = [c for c in f if c not in banned and c not in picked[0] and c not in picked[1]]
            legal_count = len(legal)
            if champ not in legal:
                # 数据/映射异常，跳过这一手
                picked[team].append(champ)
                continue
            ally = picked[team]
            enemy = picked[1 - team]
            pkey = str(int(patch))
            denom = max(1, patch_games[pkey] - 1)
            game_picks = set(picked[0]) | set(picked[1])
            emp_scores = {}
            for c in legal:
                cnt = patch_counts[pkey][c] - (1 if c in game_picks else 0)
                emp_scores[c] = cnt / denom
            pop_scores = {c: f[c]["pickRate"] for c in legal}
            emp_meta_scores = {c: 0.7 * emp_scores[c] * denom / max(1, max(emp_scores.values())) + 0.3 * f[c]["metaScore"] for c in legal} if emp_scores else {}
            full_emp_scores = {}
            for c in legal:
                ctx = score_candidate(c, f, ally, enemy, banned)
                # 组合：经验热门度为主，上下文只做增量
                full_emp_scores[c] = 0.8 * (emp_scores[c] * denom / max(1, max(emp_scores.values()))) + 0.2 * max(0.0, ctx)
            for name, scores in (("pop", pop_scores), ("emp", emp_scores), ("emp_meta", emp_meta_scores), ("full_emp", full_emp_scores)):
                r = rank_of(legal, scores, champ)
                m = metrics[name]
                m["n"] += 1
                if r == 1:
                    m["top1"] += 1
                if r <= 3:
                    m["top3"] += 1
                if r <= 5:
                    m["top5"] += 1
                m["rr"] += 1.0 / r
            random_top5 += min(5, legal_count) / legal_count
            bp = by_patch[str(int(patch))]
            bp["n"] += 1
            bp["full_top5"] += 1 if rank_of(legal, full_emp_scores, champ) <= 5 else 0
            bp["pop_top5"] += 1 if rank_of(legal, emp_scores, champ) <= 5 else 0

            picked[team].append(champ)

    n = metrics["emp"]["n"]
    print(f"\n预测次数 {n}（每局 10 手 pick）")
    print(f"{'模型':10} {'Top1':>6} {'Top3':>6} {'Top5':>6} {'MRR':>6}")
    for name, label in (("pop", "M1 快照热门度"), ("emp", "M1' 同补丁经验热门"), ("emp_meta", "M2' 经验+版本"), ("full_emp", "M3' 经验+上下文")):
        m = metrics[name]
        print(f"{label:10} {m['top1']/n*100:5.1f}% {m['top3']/n*100:5.1f}% {m['top5']/n*100:5.1f}% {m['rr']/n:6.3f}")
    print(f"{'M0 随机':10} {'—':>6} {'—':>6} {random_top5/n*100:5.1f}% {'—':>6}")

    print("\n按补丁（Top5）：")
    for p in sorted(by_patch)[-6:]:
        v = by_patch[p]
        print(f"  {p}: n={v['n']:5d}  热门度 {v['pop_top5']/v['n']*100:5.1f}%  完整 {v['full_top5']/v['n']*100:5.1f}%")


if __name__ == "__main__":
    main()
