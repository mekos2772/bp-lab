#!/usr/bin/env python3
"""采集真实排位对局（韩服单双排）用于评估 BP LAB 的"下一手预测"命中率。

数据来源：OP.GG 官方 MCP Server（排行榜 → 召唤师近期对局 → 对局详情）。
- 不做网页抓取；只用官方 MCP 的 tools/call。
- 低并发（默认 3 个 worker，列表请求之间 sleep），支持 --max-games 截断。
- 只保留 SOLORANKED + 召唤师峡谷 + 双方 5 人都有明确 position 的对局。

输出：data/ranked_drafts.sqlite
  matches(game_id, created_at, queue, duration_s, blue_win, avg_tier, source, fetched_at)
  players(game_id, side, position, champion_id, champion_key, champion_name, win)
  bans(game_id, side, idx, champion_id)
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
sys.path.insert(0, str(ROOT / "modeling" / "src"))

from fetch_opgg_mcp import MCPClient  # noqa: E402
from mcp_parse import parse_mcp_text, as_list  # noqa: E402

DB_PATH = ROOT / "data" / "ranked_drafts.sqlite"
REGION = "KR"

# 每个分路取 4 个高热度英雄，再各取若干名高分段玩家的近期对局
TARGETS = [
    ("top", ["AATROX", "JAX", "DARIUS", "MALPHITE"]),
    ("jungle", ["LEE_SIN", "VI", "SEJUANI", "MAOKAI"]),
    ("mid", ["AHRI", "SYNDRA", "VIKTOR", "AKALI"]),
    ("adc", ["KAISA", "JINX", "CAITLYN", "XAYAH"]),
    ("support", ["NAUTILUS", "RAKAN", "THRESH", "LULU"]),
]

POSITION_MAP = {
    "TOP": "top",
    "JUNGLE": "jungle",
    "MID": "mid",
    "MIDDLE": "mid",
    "BOT": "adc",
    "BOTTOM": "adc",
    "ADC": "adc",
    "SUPPORT": "support",
    "UTILITY": "support",
}

SCHEMA = """
CREATE TABLE IF NOT EXISTS matches(
  game_id TEXT PRIMARY KEY,
  created_at TEXT,
  queue TEXT,
  duration_s REAL,
  blue_win INTEGER,
  avg_tier TEXT,
  source TEXT,
  fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS players(
  game_id TEXT NOT NULL,
  side TEXT NOT NULL,
  position TEXT NOT NULL,
  champion_id INTEGER,
  champion_key TEXT,
  champion_name TEXT,
  win INTEGER,
  PRIMARY KEY(game_id, side, position)
);
CREATE TABLE IF NOT EXISTS bans(
  game_id TEXT NOT NULL,
  side TEXT NOT NULL,
  idx INTEGER NOT NULL,
  champion_id INTEGER,
  PRIMARY KEY(game_id, side, idx)
);
CREATE TABLE IF NOT EXISTS collection_log(
  ts TEXT, event TEXT, detail TEXT
);
"""


def norm_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


_thread_local = threading.local()


def thread_client() -> MCPClient:
    if not hasattr(_thread_local, "client"):
        _thread_local.client = MCPClient()
    return _thread_local.client


def get_players(client: MCPClient, champion: str, top_n: int):
    text = client.call("lol_list_champion_leaderboard", {
        "region": REGION, "champion": champion, "desired_output_fields": [],
    })
    obj = parse_mcp_text(text)
    out = []
    for entry in as_list(getattr(obj, "leaderboard", [])):
        s = getattr(entry, "summoner", None)
        if not s:
            continue
        name, tag = getattr(s, "game_name", None), getattr(s, "tagline", None)
        if name and tag:
            out.append({"game_name": name, "tag_line": tag})
        if len(out) >= top_n:
            break
    return out


def get_games(client: MCPClient, player, limit):
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
        gid = getattr(g, "id", None)
        if gid:
            out.append({"id": gid, "created_at": getattr(g, "created_at", None)})
    return out


def get_detail(client: MCPClient, gid: str, created_at):
    text = client.call("lol_get_summoner_game_detail", {
        "region": REGION,
        "game_id": gid,
        "created_at": created_at,
        "desired_output_fields": [],
    })
    obj = parse_mcp_text(text)
    return getattr(getattr(obj, "data", None), "game_detail", None)


def insert_game(con: sqlite3.Connection, gid: str, created_at, g) -> bool:
    if not g:
        return False
    teams = as_list(getattr(g, "teams", []))
    if len(teams) != 2:
        return False
    rows = []
    blue_win = None
    for team in teams:
        side = "BLUE" if getattr(team, "key", None) == "BLUE" else "RED"
        stat = getattr(team, "game_stat", None)
        is_win = getattr(stat, "is_win", None) if stat else None
        if side == "BLUE":
            blue_win = 1 if is_win else 0
        for p in as_list(getattr(team, "participants", [])):
            pos = POSITION_MAP.get(str(getattr(p, "position", "")).upper())
            cid = getattr(p, "champion_id", None)
            cname = getattr(p, "champion_name", None)
            if not pos or not cid:
                continue
            rows.append((side, pos, int(cid), norm_key(cname), cname, 1 if is_win else 0))
    if blue_win is None or len(rows) != 10:
        return False
    if len({r[1] for r in rows} & set(POSITION_MAP.values())) < 5:
        return False

    tier_info = getattr(g, "average_tier_info", None)
    avg_tier = None
    if tier_info:
        avg_tier = f"{getattr(tier_info, 'tier', '')} {getattr(tier_info, 'division', '')}".strip()

    con.execute(
        "INSERT OR IGNORE INTO matches VALUES (?,?,?,?,?,?,?,?)",
        (gid, created_at, "SOLORANKED", float(getattr(g, "game_length_second", 0) or 0),
         blue_win, avg_tier, "opgg-mcp", time.strftime("%Y-%m-%dT%H:%M:%S%z")),
    )
    for side, pos, cid, ckey, cname, win in rows:
        con.execute(
            "INSERT OR IGNORE INTO players VALUES (?,?,?,?,?,?,?)",
            (gid, side, pos, cid, ckey, cname, win),
        )
    for team in teams:
        side = "BLUE" if getattr(team, "key", None) == "BLUE" else "RED"
        for i, cid in enumerate(as_list(getattr(team, "banned_champions", []))):
            try:
                cid = int(cid)
            except Exception:
                continue
            if cid > 0:
                con.execute("INSERT OR IGNORE INTO bans VALUES (?,?,?,?)", (gid, side, i, cid))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--players-per-champion", type=int, default=4)
    ap.add_argument("--matches-per-player", type=int, default=20)
    ap.add_argument("--max-games", type=int, default=600)
    ap.add_argument("--workers", type=int, default=3)
    args = ap.parse_args()

    con = sqlite3.connect(DB_PATH)
    con.executescript(SCHEMA)
    con.commit()

    existing = {r[0] for r in con.execute("SELECT game_id FROM matches")}
    print(f"existing games: {len(existing)}", flush=True)

    client = MCPClient()
    players = []
    for role, champs in TARGETS:
        for champ in champs:
            try:
                ps = get_players(client, champ, args.players_per_champion)
                for p in ps:
                    p["from"] = f"{role}:{champ}"
                players.extend(ps)
                print(f"leaderboard {role}/{champ}: {len(ps)}", flush=True)
            except Exception as exc:  # noqa: BLE001
                print(f"leaderboard fail {champ}: {exc}", flush=True)
            time.sleep(0.15)

    # 去重玩家
    seen, uniq = set(), []
    for p in players:
        k = (p["game_name"], p["tag_line"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(p)
    print(f"unique players: {len(uniq)}", flush=True)

    candidates = {}
    for idx, p in enumerate(uniq, 1):
        try:
            for g in get_games(client, p, args.matches_per_player):
                if g["id"] not in existing:
                    candidates[g["id"]] = g
        except Exception as exc:  # noqa: BLE001
            print(f"matches fail {p['game_name']}: {exc}", flush=True)
        time.sleep(0.12)
        if idx % 10 == 0:
            print(f"  listed {idx}/{len(uniq)} players, candidates={len(candidates)}", flush=True)
    print(f"candidate games: {len(candidates)}", flush=True)

    ids = list(candidates.items())[: args.max_games]
    inserted = 0
    failed = 0
    started = time.time()
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(lambda gid=gid, created=meta["created_at"]: (gid, created, get_detail(thread_client(), gid, created))): gid
            for gid, meta in ids
        }
        for done, fut in enumerate(as_completed(futures), 1):
            try:
                gid, created, g = fut.result()
            except Exception as exc:  # noqa: BLE001
                failed += 1
                if failed % 20 == 0:
                    print(f"detail fail #{failed}: {exc}", flush=True)
                continue
            if insert_game(con, gid, created, g):
                inserted += 1
            else:
                failed += 1
            if done % 25 == 0:
                con.commit()
                print(f"progress {done}/{len(ids)} inserted={inserted} elapsed={time.time()-started:.0f}s", flush=True)
    con.execute("INSERT INTO collection_log VALUES (?,?,?)",
                (time.strftime("%Y-%m-%dT%H:%M:%S%z"), "run_done",
                 json.dumps({"requested": len(ids), "inserted": inserted, "failed": failed})))
    con.commit()
    total = con.execute("SELECT COUNT(*) FROM matches").fetchone()[0]
    print(f"done: inserted {inserted}, failed {failed}, total games {total}", flush=True)


if __name__ == "__main__":
    main()
