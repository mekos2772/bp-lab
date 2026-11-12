#!/usr/bin/env python3
"""校验 v3 标签：结构、配额、硬案例、DDragon 一致性；通过则把 DRAFT 提升为 SPOT_CHECKED。"""
import json, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIMS = ["engage","peel","frontline","poke","waveclear","dps","burst","splitpush","dive","scaling"]
LV = {"WEAK","MEDIUM","STRONG"}
HARD = {
    "jayce": {"poke": "STRONG"},
    "fiora": {"peel": "WEAK"},
    "yuumi": {"frontline": "WEAK"},
    "sion":  {"splitpush": "STRONG"},
}

def main():
    contract = json.loads((ROOT/"data/bp_contract.json").read_text(encoding="utf-8"))
    dd = json.loads((ROOT/"data/raw/ddragon_championfull_16.22.1.json").read_text(encoding="utf-8"))["data"]
    range_by_id = {v["id"]: v["stats"]["attackrange"] for v in dd.values()}
    tags_by_id = {v["id"]: v.get("tags") or [] for v in dd.values()}

    errors, warns = [], []
    merged = {}
    for p in sorted((ROOT/"data/labels").glob("chunk_*_v3.json")):
        doc = json.loads(p.read_text(encoding="utf-8"))
        for key, ch in doc["champions"].items():
            if key in merged:
                errors.append(f"duplicate champion {key} in {p.name}")
            merged[key] = ch

    print(f"合并 {len(merged)} 个英雄")
    for key, ch in merged.items():
        c = contract["champions"].get(key)
        if not c:
            errors.append(f"{key}: 不在合约中"); continue
        default = ch.get("default") or {}
        missing = [d for d in DIMS if d not in default]
        if missing:
            errors.append(f"{key}: 缺维度 {missing}")
            continue
        strong = sum(1 for d in DIMS if default[d].get("level") == "STRONG")
        if strong > 3:
            errors.append(f"{key}: STRONG {strong} > 3")
        for d in DIMS:
            item = default[d]
            if item.get("level") not in LV:
                errors.append(f"{key}.{d}: level={item.get('level')}")
            if not item.get("evidence"):
                errors.append(f"{key}.{d}: 无 evidence")
            if item.get("reviewStatus") not in {"DRAFT","SPOT_CHECKED","REVIEWED"}:
                errors.append(f"{key}.{d}: reviewStatus={item.get('reviewStatus')}")
            if item.get("source") not in {"manual","ddragon+llm","ddragon+rule"}:
                warns.append(f"{key}.{d}: source={item.get('source')}")
        did = c.get("ddragonId")
        rng = range_by_id.get(did)
        tags = tags_by_id.get(did) or []
        if rng and rng > 500 and "Tank" not in tags and default["frontline"].get("level") == "STRONG":
            errors.append(f"{key}: 远程非坦克 frontline=STRONG (range={rng})")
        for dim, want in HARD.get(key, {}).items():
            if default[dim].get("level") != want:
                errors.append(f"{key}.{dim}: 硬案例要求 {want}，实际 {default[dim].get('level')}")

    print(f"错误 {len(errors)} / 警告 {len(warns)}")
    for e in errors[:40]:
        print("  ERR", e)
    for w in warns[:10]:
        print("  WARN", w)
    if errors:
        sys.exit(1)

    # 通过：DRAFT -> SPOT_CHECKED
    for ch in merged.values():
        for d in DIMS:
            if ch["default"][d].get("reviewStatus") == "DRAFT":
                ch["default"][d]["reviewStatus"] = "SPOT_CHECKED"
    out = ROOT/"data/labels/merged_v3.json"
    out.write_text(json.dumps({"champions": merged}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"通过，已提升为 SPOT_CHECKED -> {out}")

if __name__ == "__main__":
    main()
