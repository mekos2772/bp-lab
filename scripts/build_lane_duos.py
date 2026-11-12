#!/usr/bin/env python3
"""生成「下路双人对线强度」：职业赛 15 分钟经济差（ADC + 辅助合计）。

输入：ChainCC players 2026（CC BY 4.0）
输出：data/lane_duos.json / .js
  { "ezreal|karma": {"n": 536, "gd15": 239.7, "lo":..., "hi":...}, ... }

说明：
  - 只统计同一局、同一方同时出现的 ADC+辅助组合
  - gd15 = 两人 15 分钟经济差之和（相对各自对位）
  - 按补丁×分路去均值后再相加（与 lane_stats.py 同口径）
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


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else "data/raw/chaincc-players-2026.csv.gz"
    contract = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    by_norm = {}
    for key, champ in contract["champions"].items():
        by_norm[norm(champ.get("ddragonId") or key)] = key
        by_norm[norm(key)] = key

    games = defaultdict(dict)
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            patch = r.get("patch") or ""
            if not patch.startswith("16."):
                continue
            role = POS.get(r.get("position") or "")
            champ = by_norm.get(norm(r.get("champion"))) or by_norm.get(ALIAS.get(norm(r.get("champion")), ""))
            gd = r.get("golddiffat15")
            if not role or not champ or not gd:
                continue
            games[(r["game_id"], r["side"])][role] = (champ, float(gd), patch)

    # 补丁×分路均值（用于去均值）
    sums = defaultdict(lambda: [0, 0.0])
    for (_, _), d in games.items():
        for role, (champ, gd, patch) in d.items():
            k = (patch, role)
            sums[k][0] += 1
            sums[k][1] += gd
    means = {k: v[1] / v[0] for k, v in sums.items()}

    # 双方下路配对（同一局 Blue vs Red）
    by_game = defaultdict(dict)
    for (gid, side), d in games.items():
        if "adc" in d and "support" in d:
            by_game[gid][side] = d

    duo = defaultdict(lambda: {"n": 0, "gd": 0.0, "vals": []})
    for gid, sides in by_game.items():
        for side in ("Blue", "Red"):
            d = sides.get(side)
            if not d:
                continue
            adc, adc_gd, p1 = d["adc"]
            sup, sup_gd, p2 = d["support"]
            if p1 != p2:
                continue
            adj = (adc_gd - means[(p1, "adc")]) + (sup_gd - means[(p2, "support")])
            rec = duo[(adc, sup)]
            rec["n"] += 1
            rec["gd"] += adj
            rec["vals"].append(adj)

    out = {}
    for (adc, sup), v in duo.items():
        if v["n"] < 10:
            continue
        vals = v["vals"]
        rng = random.Random(3)
        boots = []
        for _ in range(300):
            s = sum(vals[rng.randrange(len(vals))] for _ in range(len(vals)))
            boots.append(s / len(vals))
        boots.sort()
        out[f"{adc}|{sup}"] = {
            "n": v["n"],
            "gd15": round(v["gd"] / v["n"], 1),
            "lo": round(boots[int(0.025 * (len(boots) - 1))], 1),
            "hi": round(boots[int(0.975 * (len(boots) - 1))], 1),
        }

    doc = {
        "meta": {
            "schema": "lane_duos",
            "source": "ChainCC Open Dataset (CC BY 4.0)",
            "sourceUrl": "https://chaincc.lol/free/data",
            "scope": "职业比赛 2026（16.01–16.22），同一方 ADC+辅助合计，n>=10",
            "definition": "两人 15 分钟相对各自对位的经济差之和；按补丁×分路去均值",
            "caveat": "未控制打野/游走与队伍强弱，只能作为对线期关联参考",
        },
        "duos": out,
    }
    (ROOT / "data" / "lane_duos.json").write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (ROOT / "data" / "lane_duos.js").write_text("window.BP_LANE_DUOS = " + json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"duos {len(out)} -> data/lane_duos.json")
    for k in ("ezreal|karma", "xayah|rakan", "kaisa|nautilus", "caitlyn|lux"):
        if k in out:
            print(" ", k, out[k])


if __name__ == "__main__":
    main()
