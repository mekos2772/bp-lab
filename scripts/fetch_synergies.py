#!/usr/bin/env python3
"""Fetch champion pair synergy data from OP.GG synergy pages (KR Master+)."""
import concurrent.futures as cf
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
REGION = "kr"
TIER = "master_plus"
BASE = "https://op.gg/zh-cn/lol/champions"


def fetch(url, tries=3, timeout=30):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                content = r.read()
                if r.status == 200 and len(content) > 20000:
                    return content.decode("utf-8", errors="replace")
                last = f"HTTP {r.status} ({len(content)} bytes)"
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"fetch failed {url}: {last}")


def parse_synergy(html, champ_key, page_role):
    text = html.replace('\\"', '"')
    pattern = re.compile(r'"position":"([a-z]+)","synergyPosition":"([a-z]+)","data":(\[.*?\])')
    out = []
    for own_pos, partner_pos, arr in pattern.findall(text):
        # own_pos should equal page_role; keep both for safety
        try:
            rows = json.loads(arr)
        except json.JSONDecodeError:
            continue
        for row in rows:
            partner = str(row.get("synergy_champion_key", "")).lower()
            if not partner:
                continue
            out.append({
                "champion": champ_key,
                "role": page_role,
                "partner": partner,
                "partnerRole": partner_pos.lower(),
                "winRate": round(float(row.get("win_rate", 0)) * 100, 2),
                "play": int(row.get("play", 0)),
                "pickRate": round(float(row.get("pick_rate", 0)) * 100, 2),
                "tierRank": int(row.get("tier_rank", 0)),
            })
    return out


def main():
    champs = json.loads((DATA_DIR / "champions.json").read_text(encoding="utf-8"))["champions"]
    tasks = [(c["key"], role) for c in champs for role in c.get("positions", [])]
    print(f"Fetching {len(tasks)} synergy pages...", flush=True)
    all_rows = []
    failures = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(fetch, f"{BASE}/{key}/synergies/{role}?region={REGION}&tier={TIER}"): (key, role)
                for key, role in tasks}
        for fut in cf.as_completed(futs):
            key, role = futs[fut]
            done += 1
            try:
                html = fut.result()
                rows = parse_synergy(html, key, role)
                all_rows.extend(rows)
            except Exception as exc:  # noqa: BLE001
                failures.append({"champion": key, "role": role, "error": str(exc)})
                print(f"FAIL {key}/{role}: {exc}", flush=True)
            if done % 25 == 0:
                print(f"  {done}/{len(tasks)} pages", flush=True)

    # Build role-specific pair index, keeping the row with the largest sample.
    by_pair = {}
    for row in all_rows:
        if row["play"] <= 0:
            continue
        k1 = f"{row['champion']}:{row['role']}|{row['partner']}:{row['partnerRole']}"
        k2 = f"{row['partner']}:{row['partnerRole']}|{row['champion']}:{row['role']}"
        cur = by_pair.get(k1)
        if cur is None or row["play"] > cur["play"]:
            by_pair[k1] = row
        cur2 = by_pair.get(k2)
        if cur2 is None or row["play"] > cur2["play"]:
            by_pair[k2] = row
        # role-agnostic best
        ak = "|".join(sorted([row["champion"], row["partner"]]))
        cur3 = by_pair.get("ANY:" + ak)
        if cur3 is None or row["play"] > cur3["play"]:
            by_pair["ANY:" + ak] = row

    payload = {
        "meta": {
            "source": "OP.GG 英雄协同（韩服大师+）",
            "region": "KR",
            "tier": "大师+",
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "pages": len(tasks),
            "rows": len(all_rows),
            "failures": failures,
        },
        "pairs": by_pair,
    }
    (DATA_DIR / "synergies.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    (DATA_DIR / "synergies.js").write_text("window.BP_SYNERGY = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n", encoding="utf-8")
    print(f"Saved {len(by_pair)} pair indexes from {len(all_rows)} rows; failures={len(failures)}", flush=True)


if __name__ == "__main__":
    main()
