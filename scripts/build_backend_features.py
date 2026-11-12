#!/usr/bin/env python3
"""Merge champion curves + OP.GG MCP stats into a backend-ready feature file."""
import json
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"

champions = json.loads((DATA / "champions.json").read_text(encoding="utf-8"))
mcp = json.loads((DATA / "opgg_mcp.json").read_text(encoding="utf-8"))
traits = json.loads((DATA / "champion_traits.json").read_text(encoding="utf-8"))

trait_by_key = {c["key"]: c for c in traits.get("champions", [])}
champ_by_key = {c["key"]: c for c in champions["champions"]}

out_champs = {}
pair_index = {}
counter_index = {}

for key, champ in champ_by_key.items():
    mcp_champ = mcp.get("champions", {}).get(key, {})
    roles = {}
    for role in champ.get("positions", []):
        curve = champ.get("curves", {}).get(role)
        role_data = mcp_champ.get(role, {})
        roles[role] = {
            "curve": curve,
            "summary": role_data.get("summary"),
            "damageType": role_data.get("damageType"),
            "counters": role_data.get("counters", []),
            "synergies": role_data.get("synergies", []),
            "trends": role_data.get("trends", []),
        }
        for counter in role_data.get("counters", []):
            opp = counter.get("key")
            if not opp:
                continue
            counter_index.setdefault(key, {}).setdefault(role, {})[opp] = {
                "play": counter.get("play"),
                "myWinRate": counter.get("myWinRate"),
                "counterWinRate": counter.get("counterWinRate"),
                "direction": counter.get("direction"),
                "source": "opgg-mcp",
            }
        for syn in role_data.get("synergies", []):
            partner = syn.get("key")
            partner_role = syn.get("position")
            if not partner or not partner_role:
                continue
            record = {
                "champion": key,
                "role": role,
                "partner": partner,
                "partnerRole": partner_role,
                "winRate": syn.get("winRate"),
                "play": syn.get("play"),
                "win": syn.get("win"),
                "score": syn.get("score"),
                "scoreRank": syn.get("scoreRank"),
                "source": "opgg-mcp",
            }
            pair_index[f"{key}:{role}|{partner}:{partner_role}"] = record
            pair_index[f"{partner}:{partner_role}|{key}:{role}"] = record
    out_champs[key] = {
        "key": key,
        "ddragonId": champ.get("ddragonId"),
        "name": champ.get("name"),
        "title": champ.get("title"),
        "tags": champ.get("tags", []),
        "positions": champ.get("positions", []),
        "icon": champ.get("icon"),
        "traits": (trait_by_key.get(key) or {}).get("traits"),
        "info": (trait_by_key.get(key) or {}).get("info"),
        "roles": roles,
    }

payload = {
    "meta": {
        "source": "BP LAB backend feature export",
        "championCurves": champions.get("meta", {}),
        "mcp": mcp.get("meta", {}),
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "champions": len(out_champs),
        "roleEntries": sum(len(v.get("roles", {})) for v in out_champs.values()),
        "pairIndexEntries": len(pair_index),
        "counterChampionRoles": len(counter_index),
    },
    "champions": out_champs,
    "pairs": pair_index,
    "counters": counter_index,
}
(DATA / "bp_backend_features.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("saved", DATA / "bp_backend_features.json")
print("champions", len(out_champs), "pairs", len(pair_index), "counter roles", len(counter_index))
