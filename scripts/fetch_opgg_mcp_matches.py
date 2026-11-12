#!/usr/bin/env python3
"""Build a small CURRENT-SEASON match-level SQLite sample from OP.GG MCP.

This uses OP.GG MCP leaderboards + match history + full game detail.
It is not a substitute for Riot Match-V5 coverage, but it lets us test the
modeling pipeline on real current-season games without a Riot API key.
"""
import argparse
import hashlib
import json
import re
import sqlite3
import sys
import time
import threading
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "modeling" / "src"))

from fetch_opgg_mcp import MCPClient  # noqa: E402
from mcp_parse import parse_mcp_text, as_list  # noqa: E402

DEFAULT_DB = ROOT / "data" / "bp_lab_current_season.sqlite"
SCHEMA = ROOT / "modeling" / "schema.sql"
REGION = "KR"
# champion/role targets: current-season ranked ladder leaders
TARGETS = [
    ("top", "AATROX"), ("top", "JAX"),
    ("jungle", "LEE_SIN"), ("jungle", "VI"),
    ("mid", "AHRI"), ("mid", "SYNDRA"),
    ("adc", "KAISA"), ("adc", "JINX"),
    ("support", "NAUTILUS"), ("support", "RAKAN"),
]


def init_db(con):
    con.executescript(SCHEMA.read_text(encoding="utf-8"))
    con.commit()


def parse_iso(ts):
    try:
        return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return 0


def get_players(client, champion, top_n=3):
    text = client.call("lol_list_champion_leaderboard", {
        "region": REGION,
        "champion": champion,
        "desired_output_fields": [],
    })
    obj = parse_mcp_text(text)
    out = []
    for entry in as_list(getattr(obj, "leaderboard", [])):
        s = getattr(entry, "summoner", None)
        if not s:
            continue
        name, tag = getattr(s, "game_name", None), getattr(s, "tagline", None)
        if name and tag:
            out.append({"game_name": name, "tag_line": tag, "champion": champion})
        if len(out) >= top_n:
            break
    return out


def get_game_ids(client, player, limit=10):
    text = client.call("lol_list_summoner_matches", {
        "game_name": player["game_name"],
        "tag_line": player["tag_line"],
        "region": REGION,
        "limit": limit,
        "desired_output_fields": [],
    })
    obj = parse_mcp_text(text)
    out = []
    for g in as_list(getattr(getattr(obj, "data", None), "game_history", [])):
        if getattr(g, "game_type", "") != "SOLORANKED":
            continue
        out.append({"id": getattr(g, "id", None), "created_at": getattr(g, "created_at", None)})
    return out


_thread_local = threading.local()


def thread_client():
    if not hasattr(_thread_local, "client"):
        _thread_local.client = MCPClient()
    return _thread_local.client


def get_detail(client, game_id, created_at):
    text = client.call("lol_get_summoner_game_detail", {
        "region": REGION,
        "game_id": game_id,
        "created_at": created_at,
        "desired_output_fields": [],
    })
    obj = parse_mcp_text(text)
    return getattr(getattr(obj, "data", None), "game_detail", None)


def insert_detail(con, g):
    if not g:
        return None
    teams = as_list(getattr(g, "teams", []))
    participants = []
    blue_win = None
    for team in teams:
        key = getattr(team, "key", None)
        stat = getattr(team, "game_stat", None)
        is_win = getattr(stat, "is_win", None) if stat else None
        if key == "BLUE":
            blue_win = 1 if is_win else 0
        for p in as_list(getattr(team, "participants", [])):
            participants.append((key, p))
    if len(participants) != 10 or blue_win is None:
        return None
    game_id = getattr(g, "id", None)
    if not game_id:
        return None
    created = getattr(g, "created_at", None)
    duration = getattr(g, "game_length_second", 0) or 0
    raw = f"{game_id}|{created}|{duration}"
    con.execute(
        """INSERT OR IGNORE INTO matches
           (game_id, platform, region_route, queue_id, game_version_raw, patch_public, ddragon_version,
            start_ts_ms, duration_s, blue_win, ingestion_source, fetched_at, raw_sha256, quality_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (game_id, "kr", "asia", 420, "26.22", "26.22", "16.22.1", parse_iso(created or ""),
         float(duration), int(blue_win), "opgg-mcp", time.strftime("%Y-%m-%dT%H:%M:%S%z"),
         hashlib.sha256(raw.encode()).hexdigest(), "PASS")
    )
    for pid, (team_key, p) in enumerate(participants, 1):
        side = "BLUE" if team_key == "BLUE" else "RED"
        role = getattr(p, "position", None)
        role = {"MID": "MIDDLE", "BOT": "BOTTOM", "ADC": "BOTTOM", "SUP": "UTILITY"}.get(role, role)
        con.execute(
            """INSERT OR IGNORE INTO participants
               (game_id, participant_id, side, champion_id, declared_role, inferred_role, role_probability, puuid_hmac)
               VALUES (?,?,?,?,?,?,?,?)""",
            (game_id, pid, side, int(getattr(p, "champion_id", 0)), role, role, 1.0,
             hashlib.sha256(str(getattr(getattr(p, "summoner", None), "puuid", "")).encode()).hexdigest())
        )
    for team in teams:
        side = "BLUE" if getattr(team, "key", None) == "BLUE" else "RED"
        for i, cid in enumerate(as_list(getattr(team, "banned_champions", []))):
            try:
                cid = int(cid)
            except Exception:
                continue
            if cid > 0:
                con.execute(
                    """INSERT OR IGNORE INTO reported_bans (game_id, side, ban_turn_reported, champion_id)
                       VALUES (?,?,?,?)""", (game_id, side, i, cid)
                )
    return game_id


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(DEFAULT_DB))
    ap.add_argument("--players", type=int, default=2, help="top players per champion")
    ap.add_argument("--matches-per-player", type=int, default=10)
    args = ap.parse_args()
    db = Path(args.db)
    db.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(db)
    init_db(con)
    client = MCPClient()
    players = []
    for role, champ in TARGETS:
        try:
            ps = get_players(client, champ, top_n=args.players)
            for p in ps:
                p["role"] = role
            players.extend(ps)
            print("leaderboard", champ, len(ps), flush=True)
        except Exception as exc:  # noqa: BLE001
            print("leaderboard fail", champ, exc, flush=True)
        time.sleep(0.2)

    game_ids = {}
    for player in players:
        try:
            ids = get_game_ids(client, player, limit=args.matches_per_player)
            for g in ids:
                if g["id"]:
                    game_ids[g["id"]] = g
        except Exception as exc:  # noqa: BLE001
            print("matches fail", player, exc, flush=True)
        time.sleep(0.2)

    print("unique games", len(game_ids), flush=True)
    details = {}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {pool.submit(lambda gid, created: get_detail(thread_client(), gid, created), gid, g["created_at"]): gid for gid, g in game_ids.items()}
        for fut in as_completed(futures):
            gid = futures[fut]
            try:
                g = fut.result()
                if g:
                    details[gid] = g
            except Exception as exc:  # noqa: BLE001
                print("detail fail", gid, exc, flush=True)
            if len(details) % 20 == 0:
                print("details", len(details), flush=True)
    inserted = 0
    for gid, g in details.items():
        if insert_detail(con, g):
            inserted += 1
        if inserted % 20 == 0:
            con.commit()
    con.commit()
    print("inserted matches", inserted, "db", db, flush=True)


if __name__ == "__main__":
    main()
