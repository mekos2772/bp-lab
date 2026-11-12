#!/usr/bin/env python3
"""Export backend-friendly CSV tables from bp_backend_features.json."""
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
d = json.loads((DATA / "bp_backend_features.json").read_text(encoding="utf-8"))
champs = d["champions"]

# 1) champion_role_features.csv
bucket_keys = ["<25", "25-30", "30-35", "35-40", "40+"]
with (DATA / "champion_role_features.csv").open("w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["champion_key", "ddragon_id", "champion_name", "title", "role", "damage_type",
                "play", "win_rate", "pick_rate", "ban_rate", "kda", "tier", "rank",
                "curve_lt25", "curve_25_30", "curve_30_35", "curve_35_40", "curve_40plus",
                "frontline", "backline", "engage", "peel", "poke", "splitpush", "dive", "waveclear"])
    for key, c in champs.items():
        traits = c.get("traits") or {}
        for role, r in c.get("roles", {}).items():
            s = r.get("summary") or {}
            curve = {p["key"]: p for p in (r.get("curve") or [])}
            w.writerow([key, c.get("ddragonId"), c.get("name"), c.get("title"), role, r.get("damageType"),
                        s.get("play"), s.get("winRate"), s.get("pickRate"), s.get("banRate"), s.get("kda"), s.get("tier"), s.get("rank"),
                        (curve.get("<25") or {}).get("rate"), (curve.get("25-30") or {}).get("rate"),
                        (curve.get("30-35") or {}).get("rate"), (curve.get("35-40") or {}).get("rate"),
                        (curve.get("40+") or {}).get("rate"),
                        traits.get("frontline"), traits.get("backline"), traits.get("engage"), traits.get("peel"),
                        traits.get("poke"), traits.get("splitpush"), traits.get("dive"), traits.get("waveclear")])

# 2) pair_features.csv (directed)
with (DATA / "pair_features.csv").open("w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["champion", "role", "partner", "partner_role", "play", "win", "win_rate", "score", "score_rank", "source"])
    for rec in d["pairs"].values():
        w.writerow([rec.get("champion"), rec.get("role"), rec.get("partner"), rec.get("partnerRole"),
                    rec.get("play"), rec.get("win"), rec.get("winRate"), rec.get("score"), rec.get("scoreRank"), rec.get("source")])

# 3) counter_features.csv
with (DATA / "counter_features.csv").open("w", newline="", encoding="utf-8-sig") as f:
    w = csv.writer(f)
    w.writerow(["champion", "role", "opponent", "play", "my_win_rate", "counter_win_rate", "direction", "source"])
    for champ, roles in d["counters"].items():
        for role, opps in roles.items():
            for opp, rec in opps.items():
                w.writerow([champ, role, opp, rec.get("play"), rec.get("myWinRate"), rec.get("counterWinRate"), rec.get("direction"), rec.get("source")])

print("exported CSV files")
for name in ["champion_role_features.csv", "pair_features.csv", "counter_features.csv"]:
    p = DATA / name
    print(name, p.stat().st_size)
