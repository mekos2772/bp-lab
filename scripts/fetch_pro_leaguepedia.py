#!/usr/bin/env python3
"""在后台慢慢重试 Leaguepedia Cargo 查询（匿名 cargo 有严格限流）。

策略：每 180 秒试一次；成功后立刻拉取所需的几张表并落盘，然后退出。
抓取内容：
  1) 最近赛事列表（找 2026 世界赛 / LCK / LPL 的准确名称）
  2) ScoreboardGames（比赛列表：队伍、胜者、时长、日期、补丁）
  3) ScoreboardPlayers（每个选手使用的英雄与位置）
输出：data/pro_leaguepedia_raw.json
"""
from __future__ import annotations

import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "pro_leaguepedia_raw.json"
API = "https://lol.fandom.com/api.php"
UA = {"User-Agent": "BP-LAB-research/1.0 (local analysis; low volume)"}
SLEEP = 180
MAX_ROUNDS = 20


def cargo(fields, tables, where=None, order_by=None, limit=500, offset=0):
    params = {
        "action": "cargoquery", "format": "json", "limit": limit, "offset": offset,
        "tables": tables, "fields": fields,
    }
    if where:
        params["where"] = where
    if order_by:
        params["order_by"] = order_by
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode("utf-8", errors="replace"))
    if "error" in data:
        raise RuntimeError(data["error"].get("code", "error"))
    return [row["title"] for row in data.get("cargoquery", [])]


def main():
    if OUT.exists():
        print("already have", OUT, flush=True)
        return

    for round_no in range(1, MAX_ROUNDS + 1):
        try:
            print(f"[round {round_no}] probing cargo ...", flush=True)
            tours = cargo("Name,DateStart,League,Year", "Tournaments",
                          order_by="DateStart DESC", limit=30)
            print(f"  ok: {len(tours)} tournaments", flush=True)
            break
        except Exception as exc:  # noqa: BLE001
            print(f"  failed: {str(exc)[:80]} — sleep {SLEEP}s", flush=True)
            time.sleep(SLEEP)
    else:
        print("gave up", flush=True)
        return

    result = {"fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "tournaments": tours,
              "games": [], "players": []}

    # 目标赛事：2026 世界赛 + 2026 主要联赛（按名称匹配）
    targets = [t for t in tours
               if t.get("Year") == "2026" and any(k in (t.get("Name") or "")
                                                  for k in ("World Championship", "LCK", "LPL", "LEC", "LCS", "MSI"))]
    result["targets"] = targets
    print("targets:", [t.get("Name") for t in targets], flush=True)

    for t in targets[:4]:
        name = (t.get("Name") or "").replace("'", "\\'")
        try:
            time.sleep(4)
            games = cargo("GameId,Tournament,Team1,Team2,WinTeam,Gamelength,DateTime_UTC,Patch,OverviewPage",
                          "ScoreboardGames", where=f"Tournament='{name}'", limit=500)
            print(f"  {t.get('Name')}: {len(games)} games", flush=True)
            result["games"].extend(games)
            if not games:
                continue
            ids = [g.get("GameId") for g in games if g.get("GameId")]
            # ScoreboardPlayers 一次查一个赛事的全部英雄（用 OverviewPage 或 GameId IN）
            chunk = ids[:200]
            time.sleep(4)
            players = cargo("GameId,Link,Champion,Team,Role,Side",
                            "ScoreboardPlayers", where="GameId IN (" + ",".join(f"'{i}'" for i in chunk) + ")",
                            limit=500)
            print(f"  players: {len(players)}", flush=True)
            result["players"].extend(players)
        except Exception as exc:  # noqa: BLE001
            print(f"  {t.get('Name')} failed: {str(exc)[:100]}", flush=True)
            time.sleep(8)

    OUT.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    print("saved", OUT, "games", len(result["games"]), "players", len(result["players"]), flush=True)


if __name__ == "__main__":
    main()
