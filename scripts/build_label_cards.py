#!/usr/bin/env python3
"""给未标注英雄生成「标签卡片」：把 DDragon 技能/属性压缩成可读材料，按分路分批。

输出：data/label_cards/chunk_1..N.json 与 README.md
每次卡片包含：key/name/title/tags/positions/attackrange/partype/passive/4 spells
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "label_cards"

def truncate(s, n=110):
    s = (s or "").replace("\n", " ").strip()
    return s[:n] + ("…" if len(s) > n else "")

def main():
    contract = json.loads((ROOT / "data/bp_contract.json").read_text(encoding="utf-8"))
    dd = json.loads((ROOT / "data/raw/ddragon_championfull_16.22.1.json").read_text(encoding="utf-8"))["data"]
    by_id = {v["id"]: v for v in dd.values()}

    unlabeled = []
    for key, champ in contract["champions"].items():
        dims = champ["traits"]["default"]
        reviewed = sum(1 for d in dims.values() if d["reviewStatus"] == "REVIEWED")
        if reviewed > 0:
            continue
        unlabeled.append(key)

    cards = []
    for key in sorted(unlabeled):
        champ = contract["champions"][key]
        ddragon_id = champ.get("ddragonId")
        src = by_id.get(ddragon_id)
        if not src:
            continue
        cards.append({
            "key": key,
            "name": champ.get("name"),
            "title": champ.get("title"),
            "tags": champ.get("tags") or src.get("tags"),
            "positions": champ.get("positions"),
            "attackrange": src["stats"]["attackrange"],
            "partype": src.get("partype"),
            "passive": {"name": src["passive"]["name"], "desc": truncate(src["passive"]["description"])},
            "spells": [
                {"name": s["name"], "desc": truncate(s["description"]),
                 "range": (s.get("range") or [None])[0], "cd": (s.get("cooldown") or [None])[0]}
                for s in src["spells"]
            ],
        })

    # 按主分路聚类后切块，保持同批英雄类型接近
    order = {"top": 0, "jungle": 1, "mid": 2, "adc": 3, "support": 4}
    cards.sort(key=lambda c: (order.get((c["positions"] or ["mid"])[0], 9), c["key"]))
    N = 4
    chunks = [cards[i::N] for i in range(N)]
    OUT.mkdir(parents=True, exist_ok=True)
    for i, chunk in enumerate(chunks, 1):
        (OUT / f"chunk_{i}.json").write_text(json.dumps({"champions": chunk}, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"chunk_{i}: {len(chunk)} champions")

    (OUT / "README.md").write_text("""# 标签卡片

`chunk_1..4.json`：未标注英雄的 DDragon 技能摘要，供打标签使用。
每张卡片字段：key / name / title / tags / positions / attackrange / partype / passive / spells[4]。

打标签请严格按 `docs/traits_rubric.md`，输出 v3 格式：
每英雄 `default` 10 维，每维 `{level, reviewStatus, source, evidence}`。
""", encoding="utf-8")
    print("total", len(cards), "->", OUT)

if __name__ == "__main__":
    main()
