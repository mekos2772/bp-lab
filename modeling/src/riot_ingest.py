#!/usr/bin/env python3
"""Minimal Riot Match-V5 ingestion scaffold for BP LAB.

Requires a Riot API key in RIOT_API_KEY. This is intentionally conservative:
it stores only match detail / participants / reported bans from the standard schema.

Example:
  RIOT_API_KEY=... python modeling/src/riot_ingest.py --out data/bp_lab.sqlite --pages 2 --matches-per-player 10
"""
import argparse
import hashlib
import json
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
DEFAULT_SCHEMA = ROOT / "modeling" / "schema.sql"


class RiotClient:
    def __init__(self, api_key, platform="kr", region="asia", sleep=0.15):
        self.api_key = api_key
        self.platform = platform
        self.region = region
        self.sleep = sleep

    def _get(self, url, tries=4):
        last = None
        for attempt in range(tries):
            req = urllib.request.Request(url, headers={"X-Riot-Token": self.api_key})
            try:
                with urllib.request.urlopen(req, timeout=45) as r:
                    return json.loads(r.read().decode("utf-8"))
            except urllib.error.HTTPError as e:
                last = e
                if e.code == 429:
                    retry = int(e.headers.get("Retry-After", "1"))
                    time.sleep(max(retry, 1) + attempt)
                    continue
                if e.code in (500, 502, 503, 504):
                    time.sleep(1 + attempt)
                    continue
                raise
            except Exception as exc:  # noqa: BLE001
                last = exc
                time.sleep(1 + attempt)
        raise RuntimeError(f"request failed: {url}: {last}")

    def league_master_entries(self, queue="RANKED_SOLO_5x5", page=1):
        url = f"https://{self.platform}.api.riotgames.com/lol/league-exp/v4/entries/{queue}/MASTER/I?page={page}"
        return self._get(url)

    def summoner_by_id(self, summoner_id):
        url = f"https://{self.platform}.api.riotgames.com/lol/summoner/v4/summoners/{summoner_id}"
        return self._get(url)

    def match_ids(self, puuid, count=10):
        url = f"https://{self.region}.api.riotgames.com/lol/match/v5/matches/by-puuid/{puuid}/ids?queue=420&count={count}"
        return self._get(url)

    def match_detail(self, match_id):
        url = f"https://{self.region}.api.riotgames.com/lol/match/v5/matches/{match_id}"
        return self._get(url)


def ensure_schema(con, schema_path=DEFAULT_SCHEMA):
    con.executescript(Path(schema_path).read_text(encoding="utf-8"))
    con.commit()


def parse_patch(game_version):
    # 16.22.1 -> 16.22; public patch mapping must be verified separately.
    parts = (game_version or "").split(".")
    return ".".join(parts[:2]) if len(parts) >= 2 else None


def insert_match(con, detail):
    info = detail.get("info", {})
    metadata = detail.get("metadata", {})
    participants = info.get("participants", [])
    teams = info.get("teams", [])
    blue_win = next((1 if t.get("win") else 0 for t in teams if t.get("teamId") == 100), None)
    if blue_win is None:
        blue_win = 0
    game_id = metadata.get("matchId") or detail.get("matchId")
    raw_sha = hashlib.sha256(json.dumps(detail, sort_keys=True).encode()).hexdigest()
    side_count = {"BLUE": 0, "RED": 0}
    for p in participants:
        side_count["BLUE" if p.get("teamId") == 100 else "RED"] += 1
    quality = "PASS" if len(participants) == 10 and side_count["BLUE"] == 5 and side_count["RED"] == 5 else "FAIL"
    con.execute(
        """INSERT OR IGNORE INTO matches
           (game_id, platform, region_route, queue_id, game_version_raw, patch_public, ddragon_version,
            start_ts_ms, duration_s, blue_win, ingestion_source, fetched_at, raw_sha256, quality_status)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (game_id, "kr", "asia", int(info.get("queueId", 0)), str(info.get("gameVersion", "")),
         parse_patch(info.get("gameVersion")), None, int(info.get("gameCreation", 0)),
         float(info.get("gameDuration", 0)), blue_win, "riot-match-v5",
         time.strftime("%Y-%m-%dT%H:%M:%S%z"), raw_sha, quality)
    )
    for p in participants:
        side = "BLUE" if p.get("teamId") == 100 else "RED"
        role = p.get("teamPosition") or p.get("individualPosition") or None
        con.execute(
            """INSERT OR IGNORE INTO participants
               (game_id, participant_id, side, champion_id, declared_role, inferred_role, role_probability, puuid_hmac)
               VALUES (?,?,?,?,?,?,?,?)""",
            (game_id, int(p.get("participantId", 0)), side, int(p.get("championId", 0)), role, role, 1.0,
             hashlib.sha256(str(p.get("puuid", "")).encode()).hexdigest())
        )
    for t in teams:
        side = "BLUE" if t.get("teamId") == 100 else "RED"
        for i, ban in enumerate(t.get("bans", [])):
            champion_id = int(ban.get("championId", -1))
            if champion_id > 0:
                con.execute(
                    """INSERT OR IGNORE INTO reported_bans (game_id, side, ban_turn_reported, champion_id)
                       VALUES (?,?,?,?)""",
                    (game_id, side, i, champion_id)
                )
    return game_id, quality


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(ROOT / "data" / "bp_lab.sqlite"))
    ap.add_argument("--pages", type=int, default=1)
    ap.add_argument("--matches-per-player", type=int, default=10)
    ap.add_argument("--max-players", type=int, default=200)
    args = ap.parse_args()
    key = os.environ.get("RIOT_API_KEY")
    if not key:
        raise SystemExit("RIOT_API_KEY is not set; cannot call Riot API.")
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(out)
    ensure_schema(con)
    client = RiotClient(key)
    players = []
    for page in range(1, args.pages + 1):
        entries = client.league_master_entries(page=page)
        for e in entries[: args.max_players]:
            players.append(e)
            if len(players) >= args.max_players:
                break
        if len(players) >= args.max_players:
            break
    match_ids = []
    for e in players:
        try:
            s = client.summoner_by_id(e["summonerId"])
            ids = client.match_ids(s["puuid"], count=args.matches_per_player)
            match_ids.extend(ids)
        except Exception as exc:  # noqa: BLE001
            print("player skip", e.get("summonerName"), exc, file=sys.stderr)
    seen = set()
    inserted = 0
    for mid in match_ids:
        if mid in seen:
            continue
        seen.add(mid)
        try:
            detail = client.match_detail(mid)
            insert_match(con, detail)
            inserted += 1
            if inserted % 20 == 0:
                con.commit()
                print("inserted", inserted, flush=True)
            time.sleep(0.15)
        except Exception as exc:  # noqa: BLE001
            print("match skip", mid, exc, file=sys.stderr)
    con.commit()
    print("done matches", inserted, "db", out)


if __name__ == "__main__":
    main()
