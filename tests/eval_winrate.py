#!/usr/bin/env python3
"""BP LAB · 胜率先验的严谨校验（比赛级差分回归）

数据：
  - 韩服高端排位 1,618 局（16.20–16.22）：data/ranked_drafts.sqlite
  - 职业 2026：data/pro_matches.sqlite（可按补丁切）

做法（对应 GPT 建议）：
  X_g = 蓝方五人报告胜率均值 − 红方五人报告胜率均值（百分点）
  logit P(蓝方胜) = α + β·X_g（职业数据按补丁去均值，等价于补丁固定效应）

  - 5 折交叉验证的 log-loss 增量（相对只用基准胜率的模型）
  - AUC、β/OR、比赛级 bootstrap 区间
  - 游戏级四分位：按 X_g 分档看实际胜率（bootstrap CI）
  - 对照：选取率差分、梯队差分是否有同样/更强的信号

用法：
  python3 tests/eval_winrate.py            # 两个数据集都跑
"""
from __future__ import annotations

import json
import math
import random
import sqlite3
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROLES = ["top", "jungle", "mid", "adc", "support"]
# 采集时存的是英雄英文名归一化，个别英雄与合约 key 不同
ALIAS = {"wukong": "monkeyking", "renataglasc": "renata", "nunuwillump": "nunu", "nunuandwillump": "nunu"}


def load_contract():
    c = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    wr = {}
    pr = {}
    for key, champ in c["champions"].items():
        for role, rd in (champ.get("roles") or {}).items():
            meta = rd.get("meta") or {}
            if isinstance(meta.get("winRate"), (int, float)):
                wr[(key, role)] = float(meta["winRate"])
            if isinstance(meta.get("pickRate"), (int, float)):
                pr[(key, role)] = float(meta["pickRate"])
    return wr, pr


def sigmoid(z):
    if z > 30:
        return 1.0
    if z < -30:
        return 0.0
    return 1.0 / (1.0 + math.exp(-z))


def fit_logit(xs, ys, l2=0.0, iters=50):
    """两参数 logistic（截距 + 斜率），Newton/IRLS。"""
    b0, b1 = 0.0, 0.0
    for _ in range(iters):
        g0 = g1 = 0.0
        h00 = h01 = h11 = 0.0
        for x, y in zip(xs, ys):
            p = sigmoid(b0 + b1 * x)
            w = p * (1 - p)
            e = y - p
            g0 += e
            g1 += e * x
            h00 += w
            h01 += w * x
            h11 += w * x * x
        # L2 只作用于斜率
        g1 -= l2 * b1
        h11 += l2
        det = h00 * h11 - h01 * h01
        if abs(det) < 1e-12:
            break
        d0 = (h11 * g0 - h01 * g1) / det
        d1 = (-h01 * g0 + h00 * g1) / det
        b0 += d0
        b1 += d1
        if abs(d0) < 1e-10 and abs(d1) < 1e-10:
            break
    # 标准误
    h00 = h01 = h11 = 0.0
    for x in xs:
        p = sigmoid(b0 + b1 * x)
        w = max(p * (1 - p), 1e-9)
        h00 += w
        h01 += w * x
        h11 += w * x * x
    det = h00 * h11 - h01 * h01
    se1 = math.sqrt(h11 / det) if det > 0 else float("nan")
    return b0, b1, se1


def logloss(ys, ps):
    eps = 1e-12
    return -sum(y * math.log(max(p, eps)) + (1 - y) * math.log(max(1 - p, eps)) for y, p in zip(ys, ps)) / len(ys)


def auc(ys, scores):
    pairs = sorted(zip(scores, ys))
    ranks = [0.0] * len(pairs)
    i = 0
    while i < len(pairs):
        j = i
        while j + 1 < len(pairs) and pairs[j + 1][0] == pairs[i][0]:
            j += 1
        avg = (i + j) / 2.0 + 1
        for k in range(i, j + 1):
            ranks[k] = avg
        i = j + 1
    pos = sum(1 for _, y in pairs if y == 1)
    neg = len(pairs) - pos
    if not pos or not neg:
        return float("nan")
    s = sum(r for r, (_, y) in zip(ranks, pairs) if y == 1)
    return (s - pos * (pos + 1) / 2) / (pos * neg)


def cv_delta_logloss(xs, ys, folds=5, seed=7):
    idx = list(range(len(xs)))
    random.Random(seed).shuffle(idx)
    size = len(idx) // folds
    base_total = model_total = 0.0
    for f in range(folds):
        test = set(idx[f * size:(f + 1) * size] if f < folds - 1 else idx[f * size:])
        tr = [i for i in idx if i not in test]
        b0, b1, _ = fit_logit([xs[i] for i in tr], [ys[i] for i in tr])
        pbase = sum(ys[i] for i in tr) / len(tr)
        for i in test:
            base_total += -(ys[i] * math.log(max(pbase, 1e-12)) + (1 - ys[i]) * math.log(max(1 - pbase, 1e-12)))
            p = sigmoid(b0 + b1 * xs[i])
            model_total += -(ys[i] * math.log(max(p, 1e-12)) + (1 - ys[i]) * math.log(max(1 - p, 1e-12)))
    n = len(idx)
    return (base_total - model_total) / n  # 正数表示模型更好


def load_ranked(wr, pr):
    con = sqlite3.connect(ROOT / "data" / "ranked_drafts.sqlite")
    games = []
    rows = con.execute("SELECT game_id, blue_win FROM matches").fetchall()
    players = defaultdict(lambda: {"blue": [], "red": []})
    for gid, side, pos, key in con.execute("SELECT game_id, side, position, champion_key FROM players"):
        players[gid][side.lower()].append((pos, ALIAS.get(key, key)))
    skipped = 0
    for gid, bw in rows:
        p = players.get(gid)
        if not p or len(p["blue"]) != 5 or len(p["red"]) != 5:
            skipped += 1
            continue
        vals_b, vals_r, pv_b, pv_r = [], [], [], []
        ok = True
        for pos, key in p["blue"]:
            if (key, pos) not in wr:
                ok = False
                break
            vals_b.append(wr[(key, pos)])
            pv_b.append(pr.get((key, pos), 0.0))
        for pos, key in p["red"]:
            if (key, pos) not in wr:
                ok = False
                break
            vals_r.append(wr[(key, pos)])
            pv_r.append(pr.get((key, pos), 0.0))
        if not ok:
            skipped += 1
            continue
        games.append({
            "x": sum(vals_b) / 5 - sum(vals_r) / 5,
            "pick": sum(pv_b) / 5 - sum(pv_r) / 5,
            "y": int(bw),
            "patch": "16.2x",
        })
    return games, skipped


def load_pro(wr, pr):
    con = sqlite3.connect(ROOT / "data" / "pro_matches.sqlite")
    rows = con.execute("SELECT game_id, winner_side, patch FROM games").fetchall()
    players = defaultdict(lambda: {"blue": [], "red": []})
    for gid, side, pos, key in con.execute("SELECT game_id, side, position, champion_key FROM players"):
        players[gid][side].append((pos, ALIAS.get(key, key)))
    games = []
    skipped = 0
    for gid, winner_side, patch in rows:
        p = players.get(gid)
        if not p or len(p["blue"]) != 5 or len(p["red"]) != 5:
            skipped += 1
            continue
        vb, vr, pb, prr = [], [], [], []
        ok = True
        for pos, key in p["blue"]:
            if (key, pos) not in wr:
                ok = False
                break
            vb.append(wr[(key, pos)])
            pb.append(pr.get((key, pos), 0.0))
        for pos, key in p["red"]:
            if (key, pos) not in wr:
                ok = False
                break
            vr.append(wr[(key, pos)])
            prr.append(pr.get((key, pos), 0.0))
        if not ok:
            skipped += 1
            continue
        games.append({
            "x": sum(vb) / 5 - sum(vr) / 5,
            "pick": sum(pb) / 5 - sum(prr) / 5,
            "y": 1 if winner_side == "blue" else 0,
            "patch": patch or "NA",
        })
    return games, skipped


def demean_by_patch(games, field):
    sums = defaultdict(float)
    counts = defaultdict(int)
    for g in games:
        sums[g["patch"]] += g[field]
        counts[g["patch"]] += 1
    return [g[field] - sums[g["patch"]] / counts[g["patch"]] for g in games]


def quartile_report(games, field="x"):
    xs = [g[field] for g in games]
    ys = [g["y"] for g in games]
    order = sorted(range(len(games)), key=lambda i: xs[i])
    q = len(order) // 4
    out = []
    for k in range(4):
        lo = k * q
        hi = (k + 1) * q if k < 3 else len(order)
        idx = order[lo:hi]
        out.append({
            "range": (round(xs[idx[0]], 2), round(xs[idx[-1]], 2)),
            "n": len(idx),
            "rate": sum(ys[i] for i in idx) / len(idx) * 100,
        })
    # Q4-Q1 差 + bootstrap
    diff = out[3]["rate"] - out[0]["rate"]
    boot = []
    rng = random.Random(11)
    for _ in range(1000):
        sample = [idx_s for idx_s in order]
        pick = [sample[rng.randrange(len(sample))] for _ in range(len(sample))]
        pick.sort(key=lambda i: xs[i])
        qq = len(pick) // 4
        lo_idx = pick[:qq]
        hi_idx = pick[-qq:]
        boot.append((sum(ys[i] for i in hi_idx) / len(hi_idx) - sum(ys[i] for i in lo_idx) / len(lo_idx)) * 100)
    boot.sort()
    return out, round(diff, 1), (round(boot[25], 1), round(boot[974], 1))


def run(name, games, patch_adjust):
    if not games:
        print(f"\n=== {name} ===\n无可用对局")
        return
    ys = [g["y"] for g in games]
    xs_raw = [g["x"] for g in games]
    xs = demean_by_patch(games, "x") if patch_adjust else [x - sum(xs_raw) / len(xs_raw) for x in xs_raw]
    picks = demean_by_patch(games, "pick") if patch_adjust else [p - sum(g["pick"] for g in games) / len(games) for p in [g["pick"] for g in games]]
    b0, b1, se = fit_logit(xs, ys)
    delta = cv_delta_logloss(xs, ys)
    delta_pick = cv_delta_logloss(picks, ys)
    ps = [sigmoid(b0 + b1 * x) for x in xs]
    a = auc(ys, xs)
    q, qdiff, qci = quartile_report(games)
    print(f"\n=== {name} ===  对局 {len(games)}｜蓝方胜率 {sum(ys)/len(ys)*100:.1f}%")
    print(f"  β = {b1:.4f} / pp（SE {se:.4f}，z={b1/se:.2f}）→ OR = {math.exp(b1):.3f} / pp")
    print(f"  AUC = {a:.3f}｜5 折 CV log-loss 改善 = {delta:.5f}/局（热门度差分对照 {delta_pick:.5f}）")
    rates = " / ".join(f"{x['rate']:.1f}%" for x in q)
    print(f"  四分位：{rates}  Q4−Q1 = {qdiff:+.1f}pp（95% CI {qci[0]}~{qci[1]}）")
    print(f"  分档明细：{[ (x['range'], x['n'], round(x['rate'],1)) for x in q ]}")


def main():
    wr, pr = load_contract()
    ranked, rs = load_ranked(wr, pr)
    pro, ps = load_pro(wr, pr)
    print(f"合同胜率覆盖：{len(wr)} 个英雄-分路")
    print(f"排位：可用 {len(ranked)} 局（跳过 {rs}）；职业：可用 {len(pro)} 局（跳过 {ps}）")
    run("韩服高端排位 16.20–16.22", ranked, patch_adjust=False)
    run("职业 2026 全部", pro, patch_adjust=True)
    recent = [g for g in pro if g["patch"] in ("26.20", "26.21", "26.22", "16.20", "16.21", "16.22")]
    if recent:
        run("职业 26.20–26.22", recent, patch_adjust=False)


if __name__ == "__main__":
    main()
