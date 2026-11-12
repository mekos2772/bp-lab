#!/usr/bin/env python3
"""Fetch LoL champion strength curves from OP.GG (KR Master+) and icons from Data Dragon."""
import concurrent.futures as cf
import json
import os
import re
import sys
import time
from pathlib import Path

import urllib.request

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ICON_DIR = ROOT / "assets" / "champions"
DATA_DIR.mkdir(parents=True, exist_ok=True)
ICON_DIR.mkdir(parents=True, exist_ok=True)

REGION = "kr"
TIER = "master_plus"
PATCH = "16.22"
VERSION = "16.22.1"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}
BASE = "https://op.gg/zh-cn/lol/champions"

BUCKETS = [
    {"key": "<25", "label": "<25 分钟", "min": 0, "max": 25},
    {"key": "25-30", "label": "25-30 分钟", "min": 25, "max": 30},
    {"key": "30-35", "label": "30-35 分钟", "min": 30, "max": 35},
    {"key": "35-40", "label": "35-40 分钟", "min": 35, "max": 40},
    {"key": "40+", "label": "40+ 分钟", "min": 40, "max": 999},
]


def fetch(url, tries=3, timeout=30, min_bytes=1000):
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                content = r.read()
                if r.status == 200 and len(content) >= min_bytes:
                    return content.decode("utf-8", errors="replace")
                last = f"HTTP {r.status} ({len(content)} bytes)"
        except Exception as exc:  # noqa: BLE001
            last = repr(exc)
        time.sleep(0.6 * (attempt + 1))
    raise RuntimeError(f"fetch failed {url}: {last}")


def parse_champion_list(html):
    pat = re.compile(
        r'\\"key\\":\\"([a-z0-9]+)\\",\\"id\\":(\d+),\\"name\\":\\"([^\\"]+)\\",'
        r'\\"image_url\\":\\"([^\\"]+)\\",\\"is_rotation\\":(true|false),'
        r'\\"is_rip\\":(true|false),\\"positions\\":\[([^\]]*)\]'
    )
    seen = {}
    for key, cid, title, image_url, _rot, _rip, positions in pat.findall(html):
        pos = [p.replace('\\"', '').strip().lower() for p in positions.split(",") if p.strip()]
        if key not in seen:
            seen[key] = {
                "key": key,
                "championId": int(cid),
                "title": title,
                "image": image_url,
                "positions": pos,
            }
    return list(seen.values())


def parse_curve(html):
    m = re.search(r'\\"data\\":\[(\{\\"game_length\\".*?\})\],\\"xAxisKey\\":\\"game_length\\"', html)
    if not m:
        return None
    raw = m.group(1).replace('\\"', '"')
    arr = json.loads("[" + raw + "]")
    by_t = {int(x["game_length"]): x for x in arr}
    curve = []
    for b in BUCKETS:
        point = by_t.get(b["min"])
        if point:
            curve.append({
                "key": b["key"],
                "label": b["label"],
                "rate": round(float(point["rate"]), 2),
                "average": round(float(point.get("average", 50)), 2),
                "rank": int(point.get("rank", 0)),
            })
    return curve if len(curve) == 5 else None


def load_ddragon():
    url = f"https://ddragon.leagueoflegends.com/cdn/{VERSION}/data/zh_CN/champion.json"
    data = json.loads(fetch(url, min_bytes=10000))["data"]
    out = {}
    for cid, c in data.items():
        out[cid] = {
            "ddragonId": cid,
            "name": c["title"],      # localized short name, e.g. 阿狸
            "title": c["name"],      # localized title, e.g. 九尾妖狐
            "tags": c.get("tags", []),
            "image": c["image"]["full"],
        }
    return out


def norm(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def fetch_role(champ, pos):
    url = f"{BASE}/{champ['key']}/trends/{pos}?region={REGION}&tier={TIER}"
    html = fetch(url)
    curve = parse_curve(html)
    if not curve:
        raise RuntimeError("curve not found")
    return champ["key"], pos, curve


def main():
    print("Fetching champion list...", flush=True)
    champ_html = fetch(f"{BASE}?region={REGION}&tier={TIER}")
    champs = parse_champion_list(champ_html)
    print(f"  {len(champs)} champions", flush=True)

    ddragon = load_ddragon()
    dd_by_norm = {norm(k): v for k, v in ddragon.items()}

    tasks = []
    for c in champs:
        for pos in c["positions"]:
            tasks.append((c, pos))
    print(f"Fetching {len(tasks)} role pages...", flush=True)

    curves = {}
    failures = []
    done = 0
    with cf.ThreadPoolExecutor(max_workers=6) as pool:
        futs = {pool.submit(fetch_role, c, pos): (c["key"], pos) for c, pos in tasks}
        for fut in cf.as_completed(futs):
            key, pos = futs[fut]
            done += 1
            try:
                _k, _p, curve = fut.result()
                curves.setdefault(_k, {})[_p] = curve
            except Exception as exc:  # noqa: BLE001
                failures.append({"key": key, "position": pos, "error": str(exc)})
                print(f"  FAIL {key}/{pos}: {exc}", flush=True)
            if done % 20 == 0:
                print(f"  {done}/{len(tasks)} role pages done", flush=True)

    champions = []
    icons_downloaded = 0
    for c in champs:
        dd = dd_by_norm.get(norm(c["key"]))
        if not dd:
            print(f"  WARN no ddragon mapping for {c['key']}", flush=True)
            continue
        champion = {
            "key": c["key"],
            "ddragonId": dd["ddragonId"],
            "name": dd["name"],
            "title": dd["title"],
            "tags": dd["tags"],
            "positions": c["positions"],
            "icon": f"assets/champions/{dd['ddragonId']}.png",
            "curves": curves.get(c["key"], {}),
        }
        champions.append(champion)

    champions.sort(key=lambda x: x["name"])

    payload = {
        "meta": {
            "patch": PATCH,
            "version": VERSION,
            "region": "KR",
            "tier": "大师+",
            "source": "OP.GG 英雄趋势（韩服大师+）",
            "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "buckets": BUCKETS,
            "failures": failures,
        },
        "champions": champions,
    }
    (DATA_DIR / "champions.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    (DATA_DIR / "champions.js").write_text(
        "window.BP_DATA = " + json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + ";\n",
        encoding="utf-8",
    )
    print(f"Saved {len(champions)} champions, {sum(len(c['curves']) for c in champions)} role curves", flush=True)

    # Icons
    for c in champions:
        path = ICON_DIR / f"{c['ddragonId']}.png"
        if path.exists() and path.stat().st_size > 500:
            continue
        url = f"https://ddragon.leagueoflegends.com/cdn/{VERSION}/img/champion/{c['ddragonId']}.png"
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=20) as r:
                content = r.read()
                if r.status == 200 and len(content) > 500:
                    path.write_bytes(content)
                    icons_downloaded += 1
        except Exception as exc:  # noqa: BLE001
            print(f"  ICON FAIL {c['ddragonId']}: {exc}", flush=True)
    print(f"Downloaded {icons_downloaded} icons", flush=True)

    if failures:
        print(f"{len(failures)} failures; see data/champions.json meta.failures", flush=True)


if __name__ == "__main__":
    main()
