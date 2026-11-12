#!/usr/bin/env python3
"""Descriptive statistics from OP.GG MCP data.

This is descriptive only: every rate carries n + Wilson 95% CI.
No prediction / no causal claim.
"""
import json
import math
import statistics
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"
OUT = ROOT / "modeling" / "reports"
OUT.mkdir(parents=True, exist_ok=True)


def wilson(wins, n, z=1.96):
    if n <= 0:
        return (None, None)
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
    return (round(max(0, centre - margin) * 100, 2), round(min(1, centre + margin) * 100, 2))


def main():
    mcp = json.loads((DATA / "opgg_mcp.json").read_text(encoding="utf-8"))
    features = json.loads((DATA / "bp_backend_features.json").read_text(encoding="utf-8"))
    curves = json.loads((DATA / "champions.json").read_text(encoding="utf-8"))

    champion_rows = []
    for key, roles in mcp.get("champions", {}).items():
        for role, data in roles.items():
            s = data.get("summary") or {}
            n = int(s.get("play") or 0)
            wr = s.get("winRate")
            if n <= 0 or wr is None:
                continue
            wins = round(n * float(wr) / 100.0)
            lo, hi = wilson(wins, n)
            champion_rows.append({
                "champion": key,
                "role": role,
                "n": n,
                "win_rate": round(float(wr), 2),
                "wilson_95": [lo, hi],
                "pick_rate": s.get("pickRate"),
                "ban_rate": s.get("banRate"),
                "tier": s.get("tier"),
                "rank": s.get("rank"),
                "damage_type": data.get("damageType"),
                "source": "OP.GG MCP",
            })

    pair_unique = {}
    for rec in features.get("pairs", {}).values():
        a = (rec.get("champion"), rec.get("role"))
        b = (rec.get("partner"), rec.get("partnerRole"))
        if not a[0] or not b[0]:
            continue
        sig = tuple(sorted([a, b]))
        pair_unique[sig] = rec
    pair_rows = []
    for sig, rec in pair_unique.items():
        n = int(rec.get("play") or 0)
        wins = int(rec.get("win") or 0)
        if n <= 0:
            continue
        lo, hi = wilson(wins, n)
        pair_rows.append({
            "a": sig[0][0],
            "a_role": sig[0][1],
            "b": sig[1][0],
            "b_role": sig[1][1],
            "n": n,
            "wins": wins,
            "win_rate": round(wins / n * 100, 2),
            "wilson_95": [lo, hi],
            "score": rec.get("score"),
            "score_rank": rec.get("scoreRank"),
            "source": "OP.GG MCP",
        })

    # curve data-quality check (same numbers referenced in audit)
    bucket_extremes = {}
    forty_plus_over5 = 0
    zero_buckets = 0
    hundred_buckets = 0
    for champ in curves.get("champions", []):
        for role, curve in (champ.get("curves") or {}).items():
            for point in curve:
                delta = float(point.get("rate", 0)) - float(point.get("average", 50))
                if point.get("key") == "40+" and abs(delta) > 5:
                    forty_plus_over5 += 1
                if point.get("rate") == 0:
                    zero_buckets += 1
                if point.get("rate") == 100:
                    hundred_buckets += 1

    def stats(rows, field="n"):
        vals = sorted(r[field] for r in rows)
        q = lambda p: vals[min(len(vals) - 1, int(len(vals) * p))] if vals else None
        return {
            "count": len(vals),
            "median": q(0.5),
            "p25": q(0.25),
            "p75": q(0.75),
            "min": vals[0] if vals else None,
            "max": vals[-1] if vals else None,
            "ge_50": sum(1 for v in vals if v >= 50),
            "ge_100": sum(1 for v in vals if v >= 100),
            "ge_500": sum(1 for v in vals if v >= 500),
        }

    report = {
        "meta": {
            "title": "OP.GG MCP descriptive statistics",
            "createdAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z"),
            "note": "Descriptive only. Rates are historical group statistics, not predictions or causal effects.",
            "mcpMeta": mcp.get("meta", {}),
        },
        "coverage": {
            "championRoles": stats(champion_rows),
            "uniquePairs": stats(pair_rows),
            "curveQuality": {
                "fortyPlusOver5pp": forty_plus_over5,
                "zeroRateBuckets": zero_buckets,
                "hundredRateBuckets": hundred_buckets,
            },
        },
        "championRole": sorted(champion_rows, key=lambda r: (r["champion"], r["role"])),
        "pairs": sorted(pair_rows, key=lambda r: (-r["n"], r["a"], r["b"])),
    }
    (OUT / "opgg_mcp_descriptive.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    # Markdown summary
    c = report["coverage"]["championRoles"]
    p = report["coverage"]["uniquePairs"]
    q = report["coverage"]["curveQuality"]
    md = [
        "# OP.GG MCP 描述统计报告",
        "",
        "> 仅描述历史样本，不是预测，也不是因果结论。",
        "",
        "## 覆盖",
        "",
        f"- 英雄-分路条目：**{c['count']}**；样本中位数 **{c['median']}**；≥50 场 {c['ge_50']} 条；≥500 场 {c['ge_500']} 条",
        f"- 去重双人组合：**{p['count']}**；样本中位数 **{p['median']}**；≥50 场 {p['ge_50']} 条；≥500 场 {p['ge_500']} 条",
        f"- 40+ 分钟桶相对 50% 偏差 >5pp 的英雄曲线：**{q['fortyPlusOver5pp']}** 条",
        f"- 0% / 100% 胜率桶：**{q['zeroRateBuckets']} / {q['hundredRateBuckets']}** 个",
        "",
        "## 数据限制",
        "",
        "- OP.GG MCP 没有 `region` 参数，当前为默认区域聚合，不能保证是韩服 KR。",
        "- OP.GG MCP 没有游戏时长桶；时长曲线来自旧的 OP.GG 网页快照。",
        "- `summary.winRate` 是页面级汇总，按样本量近似还原 wins；不是逐局复算。",
        "- Pair `winRate` 是原始双人胜率，不是扣主效应后的协同残差。",
        "- 低样本桶/组合必须显示 `n` 与 CI，不能按排名直接比较。",
        "",
    ]
    (OUT / "opgg_mcp_descriptive.md").write_text("\n".join(md), encoding="utf-8")
    print("saved", OUT / "opgg_mcp_descriptive.json")
    print("championRoles", c)
    print("uniquePairs", p)
    print("curveQuality", q)


if __name__ == "__main__":
    main()
