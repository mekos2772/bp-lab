#!/usr/bin/env python3
"""DEPRECATED (v2.2)：本脚本产出的复合指数已被《BP LAB v2.2》明令禁止（§6 不允许无依据的
统一体系强度指数；§2.4 不允许把五人胜率均值当队伍战力）。保留仅作历史记录，
data/bp_composite_index.json/.js 已删除，前端不再引用。

Fallback heuristic: combine current-season win-rate ranking with time-profile shape.

This is NOT a probability model. It is a transparent "退一步" index for product use
when match-level data is unavailable.

Score_100 = 0.70 * win-rate percentile within role
          + 0.30 * time-profile score (50 + 5 * (bucket win rate - champion mean))
"""
import json
import math
from collections import defaultdict
from pathlib import Path
import statistics

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
OUT = ROOT / "modeling" / "reports"


def main():
    mcp = json.loads((DATA / "opgg_mcp.json").read_text(encoding="utf-8"))
    curves = json.loads((DATA / "champions.json").read_text(encoding="utf-8"))
    curve_by_key = {c["key"]: c for c in curves["champions"]}
    role_rows = defaultdict(list)
    for key, roles in mcp["champions"].items():
        for role, data in roles.items():
            s = data.get("summary") or {}
            if not s.get("play") or s.get("winRate") is None:
                continue
            role_rows[role].append((key, role, data, curve_by_key.get(key)))
    out_champs = {}
    for role, rows in role_rows.items():
        rates = [r[2]["summary"]["winRate"] for r in rows if r[2]["summary"].get("winRate") is not None]
        rates_sorted = sorted(rates)
        n = len(rates_sorted)
        ranks = [int(r[2]["summary"].get("rank") or 9999) for r in rows]
        max_rank = max(ranks) if ranks else 1
        for key, role2, data, champ_curve in rows:
            s = data["summary"]
            wr = float(s["winRate"])
            rank = int(s.get("rank") or 9999)
            win_pct = sum(1 for x in rates_sorted if x < wr) / max(n - 1, 1)
            rank_pct = 1.0 - (rank - 1) / max(max_rank - 1, 1) if rank < 9999 else 0.0
            # 70% win-rate level, 30% OP.GG rank percentile (avoid rounded-rate ties)
            pct = 0.70 * win_pct + 0.30 * rank_pct
            curve = (champ_curve or {}).get("curves", {}).get(role2) if champ_curve else None
            mean_rate = statistics.mean([p["rate"] for p in curve]) if curve else wr
            time_scores = {}
            composite = {}
            if curve:
                for p in curve:
                    b = p["key"]
                    shape = float(p["rate"]) - mean_rate
                    time_scores[b] = round(50 + shape * 5, 2)
                    # 0.70 level + 0.30 time shape; level is percentile, not probability
                    composite[b] = round(0.70 * (pct * 100) + 0.30 * time_scores[b], 2)
            out_champs.setdefault(key, {"key": key, "name": champ_curve.get("name") if champ_curve else key,
                                       "title": champ_curve.get("title") if champ_curve else "",
                                       "roles": {}})["roles"][role2] = {
                "summary": s,
                "winRatePercentile": round(win_pct * 100, 1),
                "rankPercentile": round(rank_pct * 100, 1),
                "levelPercentile": round(pct * 100, 1),
                "timeProfile": time_scores,
                "composite": composite,
                "timeMeanWinRate": round(mean_rate, 2),
            }
    # role-level top 10
    top = {}
    for role, rows in role_rows.items():
        ranked = []
        for key, _, data, champ_curve in rows:
            c = out_champs.get(key, {}).get("roles", {}).get(role, {})
            if c.get("levelPercentile") is not None:
                ranked.append((c["levelPercentile"], key, c["summary"]["winRate"], c["summary"].get("play")))
        top[role] = [{"champion": out_champs[k]["name"], "key": k, "percentile": p, "win_rate": wr, "play": n}
                     for p, k, wr, n in sorted(ranked, reverse=True)[:10]]
    payload = {
        "meta": {
            "name": "BP LAB composite index (fallback heuristic)",
            "method": "level = 0.70*win-rate percentile + 0.30*OP.GG role-rank percentile; composite = 0.70*level + 0.30*time-shape",
            "warning": "NOT a probability, NOT causal; current-season MCP summary + legacy duration curve shape. Use for display only.",
            "mcpSource": mcp.get("meta", {}),
            "curveSource": curves.get("meta", {}),
            "champions": len(out_champs),
            "roleEntries": sum(len(v["roles"]) for v in out_champs.values()),
        },
        "champions": out_champs,
        "topByRole": top,
    }
    (DATA / "bp_composite_index.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA / "bp_composite_index.js").write_text("window.BP_COMPOSITE = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    md = ["# 复合指数（退一步方案）", "", "> 不是概率、不是因果；只用于没有比赛级数据时的方向性展示。", "",
          "公式：`level = 0.70 × 同分路胜率百分位 + 0.30 × OP.GG 分路排名百分位`；`composite = 0.70 × level + 0.30 × 时间形状分`。", "",
          "## 各分路 percentile Top 10", ""]
    for role, rows in top.items():
        md += [f"### {role}", "", "| 英雄 | 胜率 | 同分路百分位 |", "|---|---:|---:|"]
        for r in rows:
            md.append(f"| {r['champion']} | {r['win_rate']}% | {r['percentile']} |")
        md.append("")
    (OUT / "composite_index.md").write_text("\n".join(md), encoding="utf-8")
    print("saved", DATA / "bp_composite_index.json", "champions", len(out_champs), "roleEntries", sum(len(v["roles"]) for v in out_champs.values()))


if __name__ == "__main__":
    main()
