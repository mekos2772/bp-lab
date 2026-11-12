"""Load match records from the BP LAB SQLite schema."""
import sqlite3
from collections import defaultdict

ROLE_MAP = {
    "TOP": "top", "JUNGLE": "jungle", "MIDDLE": "mid", "MID": "mid",
    "BOTTOM": "adc", "BOT": "adc", "UTILITY": "support", "SUPPORT": "support",
}


def load_matches(db_path, quality_status="PASS"):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        """SELECT m.game_id, m.patch_public, m.start_ts_ms, m.duration_s, m.blue_win
           FROM matches m
           WHERE m.quality_status = ? AND m.blue_win IS NOT NULL
           ORDER BY m.start_ts_ms""", (quality_status,)
    ).fetchall()
    parts = defaultdict(list)
    for p in con.execute(
        """SELECT game_id, side, champion_id, inferred_role, declared_role
           FROM participants"""
    ):
        parts[p["game_id"]].append(p)
    out = []
    for m in rows:
        blue, red = {}, {}
        ok = True
        for p in parts.get(m["game_id"], []):
            role = ROLE_MAP.get((p["inferred_role"] or p["declared_role"] or "").upper())
            if not role:
                ok = False
                break
            target = blue if p["side"] == "BLUE" else red
            if role in target:
                ok = False
                break
            target[role] = str(p["champion_id"])
        if not ok or len(blue) != 5 or len(red) != 5:
            continue
        out.append({
            "match_id": m["game_id"],
            "patch": m["patch_public"] or "UNKNOWN",
            "start_ts_ms": m["start_ts_ms"],
            "duration_s": m["duration_s"],
            "blue": blue,
            "red": red,
            "blue_win": int(m["blue_win"]),
        })
    con.close()
    return out
