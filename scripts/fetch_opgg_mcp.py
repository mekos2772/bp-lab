#!/usr/bin/env python3
"""Fetch champion stats/counters/synergies from OP.GG MCP Server (official)."""
import concurrent.futures as cf
import csv
import json
import re
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ENDPOINT = "https://mcp-api.op.gg/mcp"
HEADERS = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "User-Agent": "BP-LAB/1.0",
}
TIER = "master_plus"
LANG = "zh_CN"

ANALYSIS_FIELDS = [
    "data.summary.average_stats.{play,win_rate,pick_rate,ban_rate,kda,tier,rank}",
    "data.damage_type",
    "data.strong_counters[].{champion_name,play,my_win_rate,counter_win_rate}",
    "data.weak_counters[].{champion_name,play,my_win_rate,counter_win_rate}",
    "data.synergies.top[].{synergy_champion_id,synergy_champion_name,synergy_position,play,win,win_rate,score,score_rank}",
    "data.synergies.jungle[].{synergy_champion_id,synergy_champion_name,synergy_position,play,win,win_rate,score,score_rank}",
    "data.synergies.adc[].{synergy_champion_id,synergy_champion_name,synergy_position,play,win,win_rate,score,score_rank}",
    "data.synergies.support[].{synergy_champion_id,synergy_champion_name,synergy_position,play,win,win_rate,score,score_rank}",
    "data.trends.win[].{version,rate,rank}",
]


class MCPClient:
    def __init__(self):
        self.session_id = None
        self.next_id = 0
        self.init()

    def _post(self, body):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8")
        req = urllib.request.Request(ENDPOINT, data=data, headers=HEADERS, method="POST")
        with urllib.request.urlopen(req, timeout=45) as r:
            raw = r.read()
            return r.headers.get("mcp-session-id"), raw

    def init(self):
        self.next_id += 1
        body = {
            "jsonrpc": "2.0", "id": self.next_id, "method": "initialize",
            "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                       "clientInfo": {"name": "bp-lab", "version": "0.1.0"}},
        }
        sid, raw = self._post(body)
        self.session_id = sid
        self._parse(raw, allow_empty=True)

    def _parse(self, raw, allow_empty=False):
        payload = json.loads(raw.decode("utf-8", errors="replace"))
        if "error" in payload:
            raise RuntimeError(str(payload["error"]))
        content = payload["result"].get("content", [])
        if not content:
            if allow_empty:
                return ""
            raise RuntimeError("empty MCP content")
        return content[0].get("text", "")

    def call(self, name, arguments):
        self.next_id += 1
        body = {"jsonrpc": "2.0", "id": self.next_id, "method": "tools/call",
                "params": {"name": name, "arguments": arguments}}
        headers = dict(HEADERS)
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        req = urllib.request.Request(ENDPOINT, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
                                     headers=headers, method="POST")
        with urllib.request.urlopen(req, timeout=90) as r:
            raw = r.read()
            self.session_id = r.headers.get("mcp-session-id") or self.session_id
        return self._parse(raw)


_local = threading.local()


def client():
    if not hasattr(_local, "c"):
        _local.c = MCPClient()
    return _local.c


def parse_analysis(text):
    m = re.search(r"AverageStats\(([\d.]+),([\d.]+),([\d.]+),([\d.]+),([\d.]+),(\d+),(\d+)\)", text)
    if not m:
        return None
    play, win, pick, ban, kda, tier, rank = m.groups()
    summary = {
        "play": int(float(play)),
        "winRate": round(float(win) * 100, 2),
        "pickRate": round(float(pick) * 100, 2),
        "banRate": round(float(ban) * 100, 2),
        "kda": round(float(kda), 2),
        "tier": int(tier),
        "rank": int(rank),
    }
    dm = re.search(r'AverageStats\([^)]*\)\),\s*"([A-Z]+)"', text)
    damage = dm.group(1) if dm else "UNKNOWN"
    counters_raw = re.findall(r'StrongCounter\("([^"]+)",(\d+),([\d.]+),([\d.]+)\)', text)
    counters = []
    for name, games, my_wr, opp_wr in counters_raw:
        my = round(float(my_wr) * 100, 2)
        opp = round(float(opp_wr) * 100, 2)
        counters.append({
            "name": name,
            "play": int(games),
            "myWinRate": my,
            "counterWinRate": opp,
            "direction": "strong" if my >= 50 else "weak",
        })
    # Synergy rows: Top(...) entries inside Synergies(...)
    syn_block = re.search(r"Synergies\((.*?)\),Trends\(", text, re.S)
    synergies = []
    if syn_block:
        for row in re.findall(r"Top\(([^)]*)\)", syn_block.group(1)):
            vals = next(csv.reader([row]))
            if len(vals) < 8:
                continue
            try:
                synergies.append({
                    "championId": int(vals[0]),
                    "name": vals[1],
                    "position": vals[2].lower(),
                    "scoreRank": int(vals[3]),
                    "score": float(vals[4]),
                    "play": int(vals[5]),
                    "win": int(vals[6]),
                    "winRate": round(float(vals[7]) * 100, 2),
                })
            except ValueError:
                continue
    trends = []
    for version, rate, rank in re.findall(r'Win\("([^"]+)",([\d.]+),(\d+),', text):
        trends.append({"version": version, "winRate": round(float(rate) * 100, 2), "rank": int(rank)})
    return {"summary": summary, "damageType": damage, "counters": counters, "synergies": synergies, "trends": trends}


def main():
    champs = json.loads((DATA_DIR / "champions.json").read_text(encoding="utf-8"))["champions"]
    # MCP champion list for id -> key mapping
    c = client()
    champ_text = c.call("lol_list_champions", {"lang": LANG, "desired_output_fields": ["data[].{id,key,name}"]})
    id_to_key = {}
    for cid, key, name in re.findall(r'Champion\((\d+),"([^"]+)","([^"]+)"', champ_text):
        id_to_key[int(cid)] = key.lower()
    print("MCP champion list", len(id_to_key), flush=True)

    title_to_key = {}
    for champ in champs:
        title_to_key[champ["title"]] = champ["key"]
        title_to_key[champ["name"]] = champ["key"]

    tasks = [(champ["key"], champ["ddragonId"], role) for champ in champs for role in champ.get("positions", [])]
    print("Fetching", len(tasks), "champion-role analyses...", flush=True)
    results = {}
    failures = []
    done = 0

    def fetch_one(task):
        key, dd_id, role = task
        text = client().call("lol_get_champion_analysis", {
            "game_mode": "ranked",
            "champion": dd_id.upper(),
            "position": role,
            "lang": LANG,
            "tier": TIER,
            "desired_output_fields": ANALYSIS_FIELDS,
        })
        parsed = parse_analysis(text)
        if not parsed:
            raise RuntimeError("no AverageStats in response")
        return key, role, parsed

    with cf.ThreadPoolExecutor(max_workers=4) as pool:
        futs = {pool.submit(fetch_one, t): t for t in tasks}
        for fut in cf.as_completed(futs):
            task = futs[fut]
            done += 1
            try:
                key, role, parsed = fut.result()
                # map counter names and synergy partner ids/names to our keys
                for row in parsed["counters"]:
                    row["key"] = title_to_key.get(row["name"])
                for row in parsed["synergies"]:
                    row["key"] = id_to_key.get(row["championId"]) or title_to_key.get(row["name"])
                results.setdefault(key, {})[role] = parsed
            except Exception as exc:  # noqa: BLE001
                failures.append({"champion": task[0], "role": task[2], "error": str(exc)})
                print("FAIL", task, exc, flush=True)
            if done % 25 == 0:
                print(f"  {done}/{len(tasks)}", flush=True)

    payload = {
        "meta": {
            "source": "OP.GG MCP Server · lol_get_champion_analysis",
            "tier": "master_plus",
            "region": "not specified by MCP (likely global/default aggregate)",
            "lang": LANG,
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "tasks": len(tasks),
            "failures": failures,
        },
        "champions": results,
    }
    (DATA_DIR / "opgg_mcp.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA_DIR / "opgg_mcp.js").write_text("window.BP_MCP_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"Saved {len(results)} champions / {sum(len(v) for v in results.values())} role entries; failures={len(failures)}", flush=True)
    if failures:
        print(failures[:5], flush=True)


if __name__ == "__main__":
    main()
