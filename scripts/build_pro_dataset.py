#!/usr/bin/env python3
"""构建职业比赛数据集（来自 HuggingFace 的 gptilt/lol-esports-matches，数据源 Leaguepedia）。

只取"最近的比赛 + 世界赛"：
  - 2026 年所有职业比赛
  - 2025 年世界赛（World Championship）

输出 data/pro_matches.sqlite：
  games(game_id, tournament, patch, datetime_utc, duration_s, team_blue, team_red, winner_side, winner_team, game_number)
  players(game_id, side, position, champion_key, champion_name, slot)

用法：
  python3 scripts/build_pro_dataset.py --parquet /tmp/games.parquet --tournaments /tmp/tournaments.parquet
  # 如果本地没有 parquet，脚本会用 pyarrow 直接读（需要 pip install pyarrow）
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
from pathlib import Path

import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
ROLES = ["top", "jungle", "mid", "adc", "support"]

# Leaguepedia 英雄名 → Data Dragon key 的少量别名
# 注意：key 必须是 norm() 之后的形式
ALIASES = {
    "wukong": "monkeyking",
    "nunuwillump": "nunu",
    "nunuandwillump": "nunu",
    "renataglasc": "renata",
    "ksante": "ksante",
    "belveth": "belveth",
}

# 赛事分级（按赛事名匹配，用于单独看 Tier1 / 世界赛）
TIER_RULES = [
    ("WORLDS", ["World Championship"]),
    ("MSI", ["Mid-Season Invitational"]),
    ("T2", ["LCK CL/", "LCK Academy", "EMEA Masters", "Academy", "Challengers",
            "Prime League", "LFL", "Ultraliga", "NLC", "LVP", "Hitpoint", "Arabian",
            "LigaGG", "Game Changers", "College", "LPLOL", "Elite Series", "EBL"]),
    ("T1", ["LCK/2", "LPL/2", "LEC/2", "LCS/2", "LTA", "LCK/", "LPL/", "LEC/", "LCS/"]),
]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def parse_duration(text: str) -> float | None:
    if not text:
        return None
    text = text.strip()
    if ":" in text:
        parts = [p for p in text.split(":") if p.isdigit()]
        if len(parts) == 2:
            return int(parts[0]) * 60 + int(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + int(parts[2])
    try:
        return float(text)
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--parquet", default="/tmp/games.parquet")
    ap.add_argument("--tournaments", default="/tmp/tournaments.parquet")
    ap.add_argument("--out", default=str(DATA / "pro_matches.sqlite"))
    args = ap.parse_args()

    tours = pq.read_table(args.tournaments).to_pylist()
    by_id = {t.get("tournament_id"): t for t in tours}
    for t in tours[:2]:
        print("tournament sample:", {k: t.get(k) for k in ("tournament_id", "name", "year", "tier", "league")})

    # 目标：2026 全年 + 2025 世界赛
    def tier_of(tid: str) -> str:
        name = tid or ""
        for tier, patterns in TIER_RULES:
            if any(p in name for p in patterns):
                return tier
        return "OTHER"

    def year_of(t: dict) -> str:
        y = str(t.get("year") or "")
        if y:
            return y
        name = t.get("name") or ""
        m = re.search(r"(20\d\d)", name)
        if m:
            return m.group(1)
        start = str(t.get("date_start") or "")
        return start[:4] if start[:4].isdigit() else ""

    def wanted(tid: str) -> bool:
        t = by_id.get(tid) or {}
        year = year_of(t) if t else ""
        name = (t.get("name") or "") or (tid or "")
        blob = f"{tid} {name}"
        is_worlds = ("World Championship" in blob) or ("Worlds " in blob) or ("/Worlds" in blob)
        is_msi = ("Mid-Season Invitational" in blob) or ("MSI " in blob) or ("/MSI" in blob)
        if year == "2026":
            return True
        if is_worlds and year in ("2025", "2026"):
            return True
        if is_msi and year in ("2025", "2026"):
            return True
        return False

    games_tbl = pq.read_table(args.parquet)
    rows = games_tbl.to_pylist()
    print("total games in parquet:", len(rows))

    con = sqlite3.connect(args.out)
    con.executescript("""
    DROP TABLE IF EXISTS games;
    DROP TABLE IF EXISTS players;
    CREATE TABLE games(
      game_id TEXT PRIMARY KEY, tournament TEXT, tier TEXT, patch TEXT, datetime_utc TEXT,
      duration_s REAL, team_blue TEXT, team_red TEXT, winner_side TEXT, winner_team TEXT, game_number TEXT
    );
    CREATE TABLE players(
      game_id TEXT, side TEXT, position TEXT, champion_key TEXT, champion_name TEXT, slot INTEGER,
      PRIMARY KEY(game_id, side, position)
    );
    """)

    kept = 0
    skipped = 0
    unmapped = {}
    for r in rows:
        if not wanted(r.get("tournament")):
            continue
        b = r.get("picks_blue") or []
        red = r.get("picks_red") or []
        if len(b) != 5 or len(red) != 5:
            skipped += 1
            continue
        dur = parse_duration(r.get("gamelength"))
        if not dur or dur <= 0:
            skipped += 1
            continue
        winner = r.get("winner")
        if winner == r.get("team_blue"):
            side = "blue"
        elif winner == r.get("team_red"):
            side = "red"
        else:
            skipped += 1
            continue
        con.execute("INSERT OR REPLACE INTO games VALUES (?,?,?,?,?,?,?,?,?,?,?)", (
            r.get("game_id"), r.get("tournament"), tier_of(r.get("tournament")), r.get("patch"), r.get("datetime_utc"),
            float(dur), r.get("team_blue"), r.get("team_red"), side, winner, r.get("game_number"),
        ))
        for side_name, champs in (("blue", b), ("red", red)):
            for idx, champ in enumerate(champs):
                key = ALIASES.get(norm(champ), norm(champ))
                if not key:
                    unmapped[champ] = unmapped.get(champ, 0) + 1
                    continue
                con.execute("INSERT OR REPLACE INTO players VALUES (?,?,?,?,?,?)",
                            (r.get("game_id"), side_name, ROLES[idx], key, champ, idx))
        kept += 1
    con.commit()

    n_games = con.execute("SELECT COUNT(*) FROM games").fetchone()[0]
    n_players = con.execute("SELECT COUNT(*) FROM players").fetchone()[0]
    span = con.execute("SELECT MIN(datetime_utc), MAX(datetime_utc) FROM games").fetchone()
    by_tier = con.execute("SELECT tier, COUNT(*) FROM games GROUP BY 1 ORDER BY 2 DESC").fetchall()
    print(f"kept games {n_games} / players {n_players} (skipped {skipped})")
    print("by tier:", by_tier)
    print("span:", span)
    if unmapped:
        top = sorted(unmapped.items(), key=lambda kv: -kv[1])[:10]
        print("unmapped champion names:", top)
        Path(DATA / "pro_unmapped_champions.json").write_text(
            json.dumps(unmapped, ensure_ascii=False, indent=2), encoding="utf-8")
    con.close()


if __name__ == "__main__":
    main()
