#!/usr/bin/env python3
"""从 ChainCC 职业赛数据生成前端用的「15 分钟对线表现」指标。

输入：chaincc-players-2026.csv.gz（CC BY 4.0，https://chaincc.lol/free/data）
处理：按 (patch, role) 去均值，得到每个英雄-分路相对同补丁同分路的 15 分钟经济差/经验差。
输出：data/lane_stats.json

字段：
  champion, role, n（场次）, games（去重对局数）,
  gd15（平均经济差）, gd15_lo/gd15_hi（按局 bootstrap 95% CI）,
  xd15, cs15, patches（覆盖的补丁数）,
  scope: "pro_2026"
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
    path = sys.argv[1] if len(sys.argv) > 1 else "/tmp/cc_players.csv.gz"
    contract = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    by_norm = {}
    for key, champ in contract["champions"].items():
        by_norm[norm(champ.get("ddragonId") or key)] = key
        by_norm[norm(key)] = key

    rows = []
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        for r in csv.DictReader(fh):
            patch = r.get("patch") or ""
            if not patch.startswith("16."):
                continue
            try:
                gd = float(r.get("golddiffat15") or "")
            except ValueError:
                continue
            role = POS.get(r.get("position") or "")
            champ = by_norm.get(norm(r.get("champion"))) or by_norm.get(ALIAS.get(norm(r.get("champion")), ""))
            if not role or not champ:
                continue
            rows.append({
                "game": r["game_id"], "patch": patch, "champion": champ, "role": role,
                "gd": gd,
                "xd": float(r["xpdiffat15"]) if r.get("xpdiffat15") else None,
                "cs": float(r["csdiffat15"]) if r.get("csdiffat15") else None,
            })

    # 补丁 × 分路均值（含经验/补兵也按同口径去均值）
    adj = defaultdict(lambda: {"n": 0, "gd": 0.0, "games": set(), "xd": 0.0, "xdn": 0,
                               "cs": 0.0, "csn": 0, "patches": set(), "vals": []})
    means = defaultdict(lambda: [0, 0.0, 0.0, 0, 0.0, 0])
    for r in rows:
        m = means[(r["patch"], r["role"])]
        m[0] += 1; m[1] += r["gd"]
        if r["xd"] is not None: m[2] += r["xd"]; m[3] += 1
        if r["cs"] is not None: m[4] += r["cs"]; m[5] += 1

    for r in rows:
        m = means[(r["patch"], r["role"])]
        gdm = m[1] / m[0]
        xdm = m[2] / m[3] if m[3] else 0.0
        csm = m[4] / m[5] if m[5] else 0.0
        a = adj[(r["champion"], r["role"])]
        a["n"] += 1
        a["gd"] += r["gd"] - gdm
        a["games"].add(r["game"])
        a["patches"].add(r["patch"])
        if r["xd"] is not None:
            a["xd"] += r["xd"] - xdm; a["xdn"] += 1
        if r["cs"] is not None:
            a["cs"] += r["cs"] - csm; a["csn"] += 1
        a["vals"].append((r["game"], r["gd"] - gdm))

    # 按局 bootstrap（简单实现：每局整体重抽）
    by_game = defaultdict(list)
    for (champ, role), a in adj.items():
        for game, v in a["vals"]:
            by_game[(champ, role, game)] = v

    out = {}
    for (champ, role), a in adj.items():
        if a["n"] < 20:
            continue
        vals = a["vals"]
        # 聚类 bootstrap：按 game 分组后重采样
        games = defaultdict(list)
        for game, v in vals:
            games[game].append(v)
        game_vals = list(games.values())
        rng = random.Random(7)
        boots = []
        for _ in range(400):
            sample = []
            for _ in range(len(game_vals)):
                sample.extend(game_vals[rng.randrange(len(game_vals))])
            boots.append(sum(sample) / len(sample))
        boots.sort()
        out.setdefault(champ, {})[role] = {
            "n": a["n"],
            "games": len(a["games"]),
            "gd15": round(a["gd"] / a["n"], 1),
            "gd15_lo": round(boots[int(0.025 * (len(boots) - 1))], 1),
            "gd15_hi": round(boots[int(0.975 * (len(boots) - 1))], 1),
            "xd15": round(a["xd"] / a["xdn"], 1) if a["xdn"] else None,
            "cs15": round(a["cs"] / a["csn"], 1) if a["csn"] else None,
            "patchCount": len(a["patches"]),
            "scope": "pro_2026",
            "note": "职业赛 2026 全年（16.01–16.22），已按补丁×分路去均值；不等于单挑能力",
        }

    doc = {
        "meta": {
            "schema": "lane_stats",
            "source": "ChainCC Open Dataset (CC BY 4.0)",
            "sourceUrl": "https://chaincc.lol/free/data",
            "generatedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
            "scope": "职业比赛 2026（16.01–16.22），n>=20 场",
            "definition": "golddiffat15 = 15 分钟时相对同路对手的经济差；已按 (patch, role) 去均值",
            "caveat": "未调整选手/队伍水平与对位克制，只能作为关联参考，不能解释为英雄的因果早期强度",
        },
        "champions": out,
    }
    path_out = ROOT / "data" / "lane_stats.json"
    path_out.write_text(json.dumps(doc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    js = ROOT / "data" / "lane_stats.js"
    js.write_text("window.BP_LANE_STATS = " + json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"champions {len(out)} / role entries {sum(len(v) for v in out.values())} -> {path_out}")


if __name__ == "__main__":
    main()
