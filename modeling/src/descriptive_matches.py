#!/usr/bin/env python3
"""Descriptive statistics from a current-season match-level SQLite sample.

This is a real-data descriptive layer: no model, no causal claims.
"""
import argparse
import json
import statistics
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from load_db import load_matches
from metrics import wilson_interval


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "bp_lab_current_season.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "modeling" / "reports" / "current_season_descriptive.json"))
    args = ap.parse_args()
    matches = load_matches(args.db)
    champ = defaultdict(lambda: {"n": 0, "wins": 0})
    pairs = defaultdict(lambda: {"n": 0, "wins": 0})
    roles = ["top", "jungle", "mid", "adc", "support"]
    side = {"BLUE": {"n": 0, "wins": 0}, "RED": {"n": 0, "wins": 0}}
    for m in matches:
        side["BLUE"]["n"] += 1
        side["BLUE"]["wins"] += m["blue_win"]
        side["RED"]["n"] += 1
        side["RED"]["wins"] += 1 - m["blue_win"]
        for team, win in (("blue", m["blue_win"]), ("red", 1 - m["blue_win"])):
            picks = m[team]
            for r in roles:
                if picks.get(r):
                    key = (picks[r], r)
                    champ[key]["n"] += 1
                    champ[key]["wins"] += win
            for i in range(len(roles)):
                for j in range(i + 1, len(roles)):
                    a, b = roles[i], roles[j]
                    if picks.get(a) and picks.get(b):
                        key = tuple(sorted([(a, picks[a]), (b, picks[b])]))
                        pairs[key]["n"] += 1
                        pairs[key]["wins"] += win
    cr = []
    for (k, role), v in sorted(champ.items()):
        lo, hi = wilson_interval(v["wins"], v["n"])
        cr.append({"champion": k, "role": role, "n": v["n"], "wins": v["wins"],
                   "win_rate": round(v["wins"] / v["n"] * 100, 2), "wilson_95": [lo, hi]})
    pr = []
    for key, v in sorted(pairs.items(), key=lambda kv: -kv[1]["n"]):
        lo, hi = wilson_interval(v["wins"], v["n"])
        pr.append({"a": key[0][1], "a_role": key[0][0], "b": key[1][1], "b_role": key[1][0],
                   "n": v["n"], "wins": v["wins"], "win_rate": round(v["wins"] / v["n"] * 100, 2),
                   "wilson_95": [lo, hi]})
    out = {
        "meta": {"source": "OP.GG MCP current-season pilot", "matches": len(matches), "note": "top-player biased sample; descriptive only"},
        "side": {k: {**v, "win_rate": round(v["wins"] / v["n"] * 100, 2) if v["n"] else None} for k, v in side.items()},
        "championRole": cr,
        "pairs": pr,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    # markdown summary
    md = [f"# 当前赛季描述统计（小样本）", "", f"- 对局数：**{len(matches)}**",
          f"- 英雄-分路组合：**{len(cr)}**", f"- 双人组合：**{len(pr)}**",
          f"- 蓝方胜率：**{out['side']['BLUE']['win_rate']}%**", "",
          "> 样本来自少数英雄排行榜高分玩家的当前赛季对局，存在选择偏差，不能代表韩服 Master+ 全体。", ""]
    Path(args.out).with_suffix(".md").write_text("\n".join(md), encoding="utf-8")
    print("saved", args.out, "matches", len(matches), "champRoles", len(cr), "pairs", len(pr))


if __name__ == "__main__":
    main()
