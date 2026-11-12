#!/usr/bin/env python3
"""BP LAB · 用 ChainCC 职业赛数据（CC BY 4.0）检验「早期强度」是否真实存在。

输入：chaincc-players-2026.csv.gz（每行 = 一名选手一局）
  patch / champion / position / result / gamelength
  golddiffat10|15, xpdiffat15, csdiffat15（相对同路对手）

输出：
  1) 按补丁-分路去均值后的「15 分钟对线经济差」英雄指标（含场次）
  2) 与旧时长曲线的「早期/后期」标签做相关，并用按局聚类 bootstrap 给区间

用法：python3 tests/eval_lane.py /tmp/cc_players.csv.gz
"""
from __future__ import annotations

import csv
import gzip
import json
import random
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
POS = {"top": "top", "jng": "jungle", "mid": "mid", "bot": "adc", "sup": "support"}
ALIAS = {"wukong": "monkeyking", "nunuwillump": "nunu", "renataglasc": "renata"}


def norm(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def load_data(path: str, contract: dict) -> list[dict]:
    by_norm = {}
    for key, champ in contract["champions"].items():
        by_norm[norm(champ.get("ddragonId") or key)] = key
        by_norm[norm(key)] = key

    rows = []
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        reader = csv.DictReader(fh)
        for r in reader:
            patch = r.get("patch") or ""
            if not patch.startswith("16."):
                continue
            try:
                gd15 = float(r.get("golddiffat15") or "")
            except ValueError:
                continue
            role = POS.get(r.get("position") or "")
            champ = by_norm.get(norm(r.get("champion")))
            champ = champ or by_norm.get(ALIAS.get(norm(r.get("champion")), ""))
            if not role or not champ:
                continue
            xd = r.get("xpdiffat15")
            rows.append({
                "game": r.get("game_id"),
                "patch": patch,
                "champion": champ,
                "role": role,
                "side": 1 if r.get("side") == "Blue" else -1,
                "win": 1 if r.get("result") == "TRUE" else 0,
                "gd15": gd15,
                "xd15": float(xd) if xd else None,
            })
    return rows


def build_metric(rows: list[dict]) -> dict[tuple[str, str], dict]:
    """按补丁 × 分路去均值，得到每英雄-分路的相对经济差。"""
    means = defaultdict(lambda: [0, 0.0])
    for r in rows:
        k = (r["patch"], r["role"])
        means[k][0] += 1
        means[k][1] += r["gd15"]
    mean_map = {k: v[1] / v[0] for k, v in means.items()}

    agg = defaultdict(lambda: {"n": 0, "s": 0.0, "games": set()})
    for r in rows:
        adj = r["gd15"] - mean_map[(r["patch"], r["role"])]
        a = agg[(r["champion"], r["role"])]
        a["n"] += 1
        a["s"] += adj
        a["games"].add(r["game"])
    return {
        k: {"champion": k[0], "role": k[1], "n": v["n"], "games": len(v["games"]), "mean": v["s"] / v["n"]}
        for k, v in agg.items()
    }


def curve_deltas(contract: dict, key: str, role: str):
    rd = (contract["champions"].get(key) or {}).get("roles", {}).get(role)
    if not rd or not rd.get("trend"):
        return None
    out = {}
    for b in rd["trend"]["buckets"]:
        out[b["key"]] = (
            float(b["rate"]) - float(b["average"] if b.get("average") is not None else 50)
            if b.get("flag") == "OK" and b.get("rate") is not None else None
        )
    return out


def mean(xs):
    xs = [x for x in xs if x is not None]
    return sum(xs) / len(xs) if xs else None


def pearson(xs, ys):
    n = len(xs)
    if n < 3:
        return None
    mx, my = sum(xs) / n, sum(ys) / n
    num = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    dx = sum((x - mx) ** 2 for x in xs)
    dy = sum((y - my) ** 2 for y in ys)
    return num / (dx ** 0.5 * dy ** 0.5) if dx and dy else None


def q(sorted_vals, p):
    if not sorted_vals:
        return None
    i = int(p * (len(sorted_vals) - 1))
    return sorted_vals[i]


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cc_players.csv.gz"
    contract = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    rows = load_data(path, contract)
    games = len({r["game"] for r in rows})
    print(f"载入 {len(rows)} 条 / {games} 局 / 补丁 {len({r['patch'] for r in rows})} 个")

    metric = build_metric(rows)
    reliable = {k: v for k, v in metric.items() if v["games"] >= 20}
    print(f"英雄-分路 {len(metric)} 个，其中 ≥20 局 {len(reliable)} 个")

    # 与旧曲线对比
    pairs = []
    for (champ, role), m in reliable.items():
        d = curve_deltas(contract, champ, role)
        if not d:
            continue
        early = mean([d.get("<25"), d.get("25-30")])
        late = mean([d.get("35-40"), d.get("40+")])
        if early is None or late is None:
            continue
        pairs.append({**m, "early": early, "late": late, "lateLean": late - early})

    corr_early = pearson([p["early"] for p in pairs], [p["mean"] for p in pairs])
    corr_lean = pearson([p["lateLean"] for p in pairs], [p["mean"] for p in pairs])
    print(f"\n可与旧曲线比较：{len(pairs)} 个英雄-分路")
    print(f"  相关：早期标签 vs 15 分钟经济差 = {corr_early:.3f}；后期倾向 vs 经济差 = {corr_lean:.3f}")

    pairs.sort(key=lambda p: -p["early"])
    third = max(1, len(pairs) // 3)
    for label, seg in (
        ("旧曲线早期最强 1/3", pairs[:third]),
        ("旧曲线中间 1/3", pairs[third:2 * third]),
        ("旧曲线早期最弱 1/3", pairs[2 * third:]),
    ):
        n = sum(x["n"] for x in seg)
        w = sum(x["mean"] * x["n"] for x in seg) / n if n else 0
        print(f"  {label}: {len(seg)} 个 / {n} 场 / 平均经济差 {w:+.1f}")

    # 聚类 bootstrap（按局重采样）
    by_game = defaultdict(list)
    for r in rows:
        by_game[r["game"]].append(r)
    game_list = list(by_game.values())
    stats = []
    rng = random.Random(42)
    for _ in range(300):
        sample = []
        for _ in range(len(game_list)):
            sample.extend(game_list[rng.randrange(len(game_list))])
        m = build_metric(sample)
        ps = []
        for (champ, role), v in m.items():
            if v["games"] < 20:
                continue
            d = curve_deltas(contract, champ, role)
            if not d:
                continue
            early = mean([d.get("<25"), d.get("25-30")])
            if early is None:
                continue
            ps.append((early, v["mean"]))
        c = pearson([p[0] for p in ps], [p[1] for p in ps])
        if c is not None:
            stats.append(c)
    stats.sort()
    if stats:
        print(f"  early 相关 95% CI: [{q(stats, 0.025):.3f}, {q(stats, 0.975):.3f}]（按局重采样 {len(stats)} 次）")

    # 当前窗口
    recent = [r for r in rows if r["patch"] in ("16.20", "16.21", "16.22")]
    rm = sorted(build_metric(recent).values(), key=lambda x: -x["games"])
    rm = [x for x in rm if x["games"] >= 8]
    print(f"\n当前窗口 16.20–16.22：{len(recent)} 条 / {len({r['game'] for r in recent})} 局，≥8 局的英雄-分路 {len(rm)} 个")
    if rm:
        print("  经济差@15 最高：", ", ".join(f"{x['champion']}/{x['role']} {x['mean']:+.0f}({x['games']})" for x in rm[:6]))
        print("  经济差@15 最低：", ", ".join(f"{x['champion']}/{x['role']} {x['mean']:+.0f}({x['games']})" for x in rm[-6:]))


if __name__ == "__main__":
    main()
