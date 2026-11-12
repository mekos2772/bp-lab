#!/usr/bin/env python3
"""合并 v2 人工标签 + 新批次标签，输出全覆盖的 champion_traits_v3.json。

优先级：v2（人工 REVIEWED）> merged_v3（DDragon+规则 SPOT_CHECKED）> UNREVIEWED。
"""
import json
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIMS = ["engage","peel","frontline","poke","waveclear","dps","burst","splitpush","dive","scaling"]
UNREVIEWED = {"level": "UNREVIEWED", "reviewStatus": "REVIEW_REQUIRED", "source": "none", "evidence": []}

def main():
    contract = json.loads((ROOT/"data/bp_contract.json").read_text(encoding="utf-8"))
    dd = json.loads((ROOT/"data/raw/ddragon_championfull_16.22.1.json").read_text(encoding="utf-8"))["data"]
    by_id = {v["id"]: v for v in dd.values()}
    v2 = json.loads((ROOT/"data/champion_traits_v2.json").read_text(encoding="utf-8"))["champions"]
    merged_path = ROOT/"data/labels/merged_v3.json"
    merged = json.loads(merged_path.read_text(encoding="utf-8"))["champions"] if merged_path.exists() else {}

    out, stats = {}, {"reviewed": 0, "spotChecked": 0, "unlabeled": 0}
    for key, champ in contract["champions"].items():
        did = champ.get("ddragonId")
        src = by_id.get(did) or {}
        entry = {"name": champ.get("name"), "title": champ.get("title"),
                 "tags": src.get("tags") or champ.get("tags") or [],
                 "attackrange": (src.get("stats") or {}).get("attackrange"),
                 "partype": src.get("partype"),
                 "default": {}, "roles": {}}
        base = v2.get(key) or {}
        v2_has = any((d or {}).get("level") not in (None, "UNREVIEWED") for d in (base.get("default") or {}).values())
        if v2_has:
            for d in DIMS:
                item = dict(base["default"].get(d) or UNREVIEWED)
                item.setdefault("source", "manual")
                entry["default"][d] = item
            entry["roles"] = base.get("roles") or {}
            stats["reviewed"] += 1
        elif key in merged:
            for d in DIMS:
                item = dict(merged[key]["default"].get(d) or UNREVIEWED)
                item.setdefault("source", "ddragon+llm")
                entry["default"][d] = item
            stats["spotChecked"] += 1
        else:
            for d in DIMS:
                entry["default"][d] = dict(UNREVIEWED)
            stats["unlabeled"] += 1
        out[key] = entry

    levels = {}
    for key, ch in out.items():
        for d in DIMS:
            lv = ch["default"][d]["level"]
            levels[lv] = levels.get(lv, 0) + 1

    doc = {
        "meta": {
            "schema": "champion_traits_v3",
            "contract": "v2.2",
            "patch": "16.22",
            "generatedAt": datetime.now().isoformat(timespec="seconds"),
            "reviewer": "lead + traits-reviewer + labelers (DDragon 技能文本 + 规则)",
            "methodology": "DRAFT 由 DDragon 技能摘要 + docs/traits_rubric.md 生成，经 scripts/qa_traits.py 机械校验后提升为 SPOT_CHECKED；不一定逐个英雄人工复核",
            "coverage": {"total": len(out), **stats, "levelCounts": levels},
            "note": "UNREVIEWED 不得当作中性值使用；DRAFT 不进入产品与校准",
        },
        "champions": out,
    }
    (ROOT/"data/champion_traits_v3.json").write_text(json.dumps(doc, ensure_ascii=False, indent=1), encoding="utf-8")
    print("v3 champions", len(out), "coverage", stats, "levels", levels)

if __name__ == "__main__":
    main()
