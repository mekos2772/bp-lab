#!/usr/bin/env python3
"""阶段倾向曲线：验证 + 校准 + 队伍级校验 + bootstrap（支持 --assert）。"""
from __future__ import annotations

import csv
import gzip
import json
import math
import random
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIMS = ["engage","peel","frontline","poke","waveclear","dps","burst","splitpush","dive","scaling"]
LV = {"STRONG": 1.0, "MEDIUM": 0.0, "WEAK": -1.0}
OK_STATUS = {"REVIEWED", "SPOT_CHECKED"}
EXPERT = {"poke": 0.35, "waveclear": 0.2, "burst": 0.2, "engage": 0.15, "peel": 0.1}

def load_traits():
    for name in ("champion_traits_v3.json", "champion_traits_v2.json"):
        p = ROOT / "data" / name
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8")), name
    raise SystemExit("no traits file")

def traits_vec(traits, key):
    ch = traits["champions"].get(key)
    if not ch:
        return None
    vec = []
    for d in DIMS:
        e = ch["default"].get(d) or {}
        if e.get("reviewStatus") not in OK_STATUS or e.get("level") not in LV:
            return None
        vec.append(LV[e["level"]])
    return vec

def pearson(xs, ys):
    n = len(xs)
    if n < 3: return None
    mx, my = sum(xs)/n, sum(ys)/n
    num = sum((x-mx)*(y-my) for x, y in zip(xs, ys))
    dx = sum((x-mx)**2 for x in xs); dy = sum((y-my)**2 for y in ys)
    return num/math.sqrt(dx*dy) if dx and dy else None

def ridge_fit(X, y, w, l2):
    p = len(X[0]) + 1
    Xa = [[1.0]+r for r in X]
    A = [[0.0]*p for _ in range(p)]; b = [0.0]*p
    for i in range(len(X)):
        for j in range(p):
            b[j] += w[i]*Xa[i][j]*y[i]
            for k in range(p):
                A[j][k] += w[i]*Xa[i][j]*Xa[i][k]
    for j in range(1, p): A[j][j] += l2
    M = [row[:] + [b[i]] for i, row in enumerate(A)]
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(M[r][c]))
        M[c], M[piv] = M[piv], M[c]
        if abs(M[c][c]) < 1e-12: continue
        d = M[c][c]
        for j in range(c, p+1): M[c][j] /= d
        for r in range(p):
            if r == c: continue
            f = M[r][c]
            if f:
                for j in range(c, p+1): M[r][j] -= f*M[c][j]
    return [M[i][p] for i in range(p)]

def predict(coef, vec):
    return coef[0] + sum(coef[j+1]*vec[j] for j in range(len(vec)))

def cv_corr(samples, folds=5, l2=10.0, seed=5):
    champs = sorted({s["key"] for s in samples})
    random.Random(seed).shuffle(champs)
    groups = [set(champs[i::folds]) for i in range(folds)]
    pred = [None]*len(samples)
    for f in range(folds):
        tr = [i for i, s in enumerate(samples) if s["key"] not in groups[f]]
        te = [i for i, s in enumerate(samples) if s["key"] in groups[f]]
        coef = ridge_fit([samples[i]["vec"] for i in tr], [samples[i]["y"] for i in tr],
                         [samples[i]["n"] for i in tr], l2)
        for i in te: pred[i] = predict(coef, samples[i]["vec"])
    return pearson(pred, [s["y"] for s in samples]), pred

def main():
    assert_mode = "--assert" in sys.argv
    traits, traits_name = load_traits()
    contract = json.loads((ROOT/"data/bp_contract.json").read_text(encoding="utf-8"))
    lane = json.loads((ROOT/"data/lane_stats.json").read_text(encoding="utf-8"))["champions"]

    samples = []
    for key, roles in lane.items():
        for role, v in roles.items():
            if v["n"] < 20: continue
            vec = traits_vec(traits, key)
            if vec is None: continue
            samples.append({"key": key, "role": role, "vec": vec, "y": v["gd15"], "n": v["n"]})
    print(f"标签文件：{traits_name}｜可校准英雄-分路：{len(samples)}")

    expert_pred = [sum(EXPERT.get(DIMS[j], 0) * s["vec"][j] for j in range(len(DIMS))) /
                   sum(EXPERT.values()) for s in samples]
    print(f"专家 early 分 vs 真实 15′ 经济差：corr = {pearson(expert_pred, [s['y'] for s in samples]):.3f}")

    best = None
    for l2 in (1, 3, 10, 30):
        c, _ = cv_corr(samples, l2=l2)
        print(f"  l2={l2:>2}: 按英雄分组 5 折 corr = {c:.3f}")
        if best is None or c > best[1]:
            best = (l2, c)
    l2, cv = best
    print(f"选中 l2={l2}，样本外 corr = {cv:.3f}")

    coef = ridge_fit([s["vec"] for s in samples], [s["y"] for s in samples],
                     [s["n"] for s in samples], l2)
    weights = {DIMS[j]: round(coef[j+1], 4) for j in range(len(DIMS))}
    print("校准权重：", json.dumps(weights, ensure_ascii=False))

    # bootstrap：英雄重采样
    rng = random.Random(11)
    champs = sorted({s["key"] for s in samples})
    cvs, sign_flip = [], defaultdict(int)
    for _ in range(300):
        pick = [champs[rng.randrange(len(champs))] for _ in range(len(champs))]
        res = []
        for k in pick:
            res.extend([s for s in samples if s["key"] == k])
        c, _ = cv_corr(res, l2=l2, seed=rng.randint(1, 10**6))
        if c is not None: cvs.append(c)
        co = ridge_fit([s["vec"] for s in res], [s["y"] for s in res], [s["n"] for s in res], l2)
        for j, d in enumerate(DIMS):
            if (co[j+1] > 0) != (coef[j+1] > 0): sign_flip[d] += 1
    cvs.sort()
    cv_lo = cvs[int(0.025*(len(cvs)-1))] if cvs else None
    print(f"bootstrap CV corr 95% CI: [{cv_lo:.3f}, {cvs[int(0.975*(len(cvs)-1))]:.3f}]（{len(cvs)} 次）")
    flips = {d: round(v/300, 2) for d, v in sign_flip.items() if v > 90}
    if flips: print("符号不稳定（>30% 翻转）：", flips)

    # 队伍级校验：ChainCC teams 的 golddiffat15
    teams_gz = ROOT/"data/raw/chaincc-teams-2026.csv.gz"
    team_ok = False
    if teams_gz.exists():
        dd = json.loads((ROOT/"data/raw/ddragon_championfull_16.22.1.json").read_text(encoding="utf-8"))["data"]
        norm = lambda s: "".join(ch for ch in (s or "").lower() if ch.isalnum())
        by = {}
        for k, ch in contract["champions"].items():
            by[norm(ch.get("ddragonId") or k)] = k; by[norm(k)] = k
        alias = {"wukong": "monkeyking", "nunuwillump": "nunu", "renataglasc": "renata"}
        def resolve(name):
            return by.get(norm(name)) or by.get(alias.get(norm(name), ""))
        def team_score(picks):
            vals = [predict(coef, traits_vec(traits, k)) for k in picks if traits_vec(traits, k)]
            return sum(vals)/len(vals) if vals else None
        games = defaultdict(dict)
        with gzip.open(teams_gz, "rt", encoding="utf-8", errors="replace") as fh:
            for r in csv.DictReader(fh):
                if not (r.get("patch") or "").startswith("16."): continue
                gd = r.get("golddiffat15")
                picks = [resolve(r.get(f"pick{i}")) for i in range(1, 6)]
                if not gd or any(p is None for p in picks): continue
                s = team_score(picks)
                if s is None: continue
                games[r["game_id"]][r["side"]] = (s, float(gd))
        pairs = [(g["Blue"][0]-g["Red"][0], g["Blue"][1]-g["Red"][1])
                 for g in games.values() if "Blue" in g and "Red" in g]
        if len(pairs) > 100:
            team_corr = pearson([a for a, b in pairs], [b for a, b in pairs])
            team_ok = True
            print(f"队伍级：校准 early 差 vs 真实 team golddiff@15 差 corr = {team_corr:.3f}（n={len(pairs)}）")

    # 中后期方向性检验
    con = sqlite3.connect(ROOT/"data/pro_matches.sqlite")
    rows = con.execute("SELECT game_id, winner_side, duration_s FROM games").fetchall()
    players = defaultdict(lambda: {"blue": [], "red": []})
    for gid, side, pos, key in con.execute("SELECT game_id, side, position, champion_key FROM players"):
        players[gid][side].append((pos, key))
    games2 = []
    for gid, winner, dur in rows:
        p = players.get(gid)
        if not p or len(p["blue"]) != 5 or len(p["red"]) != 5: continue
        def mean_of(picks):
            vals = []
            for _, k in picks:
                v = traits_vec(traits, k)
                if v is not None:
                    vals.append(predict(coef, v))
            return sum(vals)/len(vals) if vals else None
        b, r = mean_of(p["blue"]), mean_of(p["red"])
        if b is None or r is None: continue
        games2.append({"y": 1 if winner == "blue" else 0, "dur": dur/60, "d": b-r})
    print(f"\n职业对局可用：{len(games2)}")
    for label, lo, hi in [("<25", 0, 25), ("25-35", 25, 35), (">=35", 35, 999)]:
        seg = [g for g in games2 if lo <= g["dur"] < hi]
        if len(seg) >= 50:
            print(f"  {label} 分钟：corr(early 分差, 胜) = {pearson([g['d'] for g in seg], [g['y'] for g in seg]):+.3f}（n={len(seg)}）")

    # 稳定子集（bootstrap 符号不稳的维度剔除后）单独评估
    STABLE = ["engage", "frontline", "waveclear", "burst", "splitpush", "scaling"]
    sub = []
    for s_ in samples:
        idx = [DIMS.index(d) for d in STABLE]
        full = traits_vec(traits, s_["key"])
        if full is None: continue
        sub.append({"key": s_["key"], "role": s_["role"], "vec": [full[i] for i in idx], "y": s_["y"], "n": s_["n"]})
    sub_cv, _ = cv_corr(sub, l2=l2)
    print(f"稳定 6 维子集：样本外 corr = {sub_cv:.3f}（n={len(sub)}）")

    if assert_mode:
        ok = (cv >= 0.30 and (cv_lo or 0) >= 0.15 and team_ok)
        print("ASSERT", "PASS" if ok else "FAIL")
        sys.exit(0 if ok else 1)

if __name__ == "__main__":
    main()
