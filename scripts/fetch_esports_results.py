#!/usr/bin/env python3
"""从 OP.GG MCP 抓最近职业比赛结果（含队名/比分），供首页展示。

输出：data/esports_results.json / .js
字段：id, league, name, homeTeam{name,acronym}, awayTeam{...}, homeScore, awayScore,
      scheduledAt, status, details
"""
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from fetch_opgg_mcp import MCPClient  # noqa: E402

LEAGUES = ["LCK", "LPL", "LEC", "LCS", "WORLDS", "MSI", "PCS", "VCS", "CBLOL", "LJL"]
KEEP = 8


def main():
    c = MCPClient()
    out = {}
    fixtures = []
    for lg in LEAGUES:
        try:
            txt = c.call("lol_esports_list_schedules", {"mode": "result", "league": lg})
            arr = json.loads(txt) if txt.strip().startswith("[") else []
        except Exception as e:  # noqa: BLE001
            print(lg, "result ERR", str(e)[:100])
            arr = []
        try:
            txt2 = c.call("lol_esports_list_schedules", {"mode": "schedule", "league": lg})
            up = json.loads(txt2) if txt2.strip().startswith("[") else []
        except Exception as e:  # noqa: BLE001
            print(lg, "schedule ERR", str(e)[:100])
            up = []
        for m in arr:
            mid = m.get("id")
            if mid in out:
                continue
            out[mid] = {
                "id": mid,
                "league": m.get("league") or lg,
                "name": m.get("name"),
                "status": m.get("status"),
                "scheduledAt": m.get("scheduledAt"),
                "homeScore": m.get("homeScore"),
                "awayScore": m.get("awayScore"),
                "homeTeam": {
                    "name": (m.get("homeTeam") or {}).get("name"),
                    "code": (m.get("homeTeam") or {}).get("acronym"),
                },
                "awayTeam": {
                    "name": (m.get("awayTeam") or {}).get("name"),
                    "code": (m.get("awayTeam") or {}).get("acronym"),
                },
                "details": m.get("details"),
            }
        for m in up:
            fixtures.append({
                "id": m.get("id"), "league": m.get("league") or lg, "name": m.get("name"),
                "status": m.get("status"), "scheduledAt": m.get("scheduledAt"),
                "homeTeam": {"name": (m.get("homeTeam") or {}).get("name"), "code": (m.get("homeTeam") or {}).get("acronym")},
                "awayTeam": {"name": (m.get("awayTeam") or {}).get("name"), "code": (m.get("awayTeam") or {}).get("acronym")},
                "details": m.get("details"),
            })
        print(lg, "ok", len(arr), "upcoming", len(up))

    rows = sorted(out.values(), key=lambda x: x.get("scheduledAt") or "", reverse=True)
    fixtures.sort(key=lambda x: x.get("scheduledAt") or "")
    doc = {
        "meta": {
            "source": "OP.GG MCP · lol_esports_list_schedules (mode=result / schedule)",
            "fetchedAt": datetime.now().isoformat(timespec="seconds"),
            "leagues": LEAGUES,
            "note": "队名/比分来自 OP.GG；BP 未提供",
        },
        "results": rows[:40],
        "fixtures": fixtures[:20],
        "matches": rows[:40],
    }
    (ROOT / "data/esports_results.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    (ROOT / "data/esports_results.js").write_text(
        "window.BP_ESPORTS_RESULTS = " + json.dumps(doc, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print("saved", len(doc["matches"]), "matches")


if __name__ == "__main__":
    main()
