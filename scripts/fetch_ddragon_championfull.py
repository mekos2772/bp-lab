#!/usr/bin/env python3
"""抓取 Data Dragon championFull（含技能/被动/属性文本），用于给英雄打战术标签。"""
import json, sys, urllib.request
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
VERSION = "16.22.1"
OUT = ROOT / "data" / "raw" / f"ddragon_championfull_{VERSION}.json"
URL = f"https://ddragon.leagueoflegends.com/cdn/{VERSION}/data/zh_CN/championFull.json"
def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(URL, timeout=60) as r:
        raw = r.read()
    data = json.loads(raw)
    assert len(data["data"]) >= 170, f"unexpected champion count {len(data['data'])}"
    OUT.write_bytes(raw)
    print(f"saved {OUT} champions={len(data['data'])} version={data['version']}")
if __name__ == "__main__":
    main()
