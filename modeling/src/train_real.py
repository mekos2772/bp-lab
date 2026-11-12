#!/usr/bin/env python3
"""Train the BP LAB v2 baseline on real match-level data in SQLite.

Usage:
  python modeling/src/train_real.py --db path/to/bp_lab.sqlite --out modeling/reports/real_baseline.json
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import build_design
from load_db import load_matches
from metrics import metric_bundle
from model import LogisticModel


def patch_key(patch):
    import re
    nums = [int(x) for x in re.findall(r"\d+", str(patch))]
    return tuple(nums[:3]) if nums else (-1,)


def split_by_patch(matches, valid_patch, test_patch):
    vk, tk = patch_key(valid_patch), patch_key(test_patch)
    return (
        [m for m in matches if patch_key(m["patch"]) < vk],
        [m for m in matches if patch_key(m["patch"]) == vk],
        [m for m in matches if patch_key(m["patch"]) == tk],
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--out", default=str(ROOT / "modeling" / "reports" / "real_baseline.json"))
    ap.add_argument("--valid-patch", default=None)
    ap.add_argument("--test-patch", default=None)
    args = ap.parse_args()

    matches = load_matches(args.db)
    if len(matches) < 100:
        raise SystemExit(f"Need at least 100 valid matches, got {len(matches)}")
    patches = sorted({m["patch"] for m in matches}, key=patch_key)
    if len(patches) < 3:
        raise SystemExit("Need at least 3 patches for time-forward split")
    valid_patch = args.valid_patch or patches[-2]
    test_patch = args.test_patch or patches[-1]
    train, valid, test = split_by_patch(matches, valid_patch, test_patch)
    if not train or not valid or not test:
        raise SystemExit("Empty split")

    X2tr, ytr, h2 = build_design(train, include_pairs=False)
    X2te, yte, _ = build_design(test, include_pairs=False, hero_vocab=h2)
    X2va, yva, _ = build_design(valid, include_pairs=False, hero_vocab=h2)

    X3tr, y3tr, n3 = build_design(train, include_pairs=True)
    hp = [n for n in n3 if n.startswith("hero:")]
    pp = [n for n in n3 if n.startswith("pair:")]
    X3te, y3te, _ = build_design(test, include_pairs=True, hero_vocab=hp, pair_vocab=pp)
    X3va, y3va, _ = build_design(valid, include_pairs=True, hero_vocab=hp, pair_vocab=pp)

    out = {
        "data": {"matches": len(matches), "train": len(train), "valid": len(valid), "test": len(test),
                 "valid_patch": valid_patch, "test_patch": test_patch},
        "metrics": [],
    }
    out["metrics"].append({"model": "M0_50", **metric_bundle(yte, np.full(len(yte), 0.5))})
    out["metrics"].append({"model": "M1_constant", **metric_bundle(yte, np.full(len(yte), float(ytr.mean())))})
    m2 = LogisticModel(l2=1.0).fit(X2tr, ytr)
    out["metrics"].append({"model": "M2_hero_role", **metric_bundle(yte, m2.predict_proba(X2te))})
    m3 = LogisticModel(l2=2.0).fit(X3tr, y3tr)
    out["metrics"].append({"model": "M3_hero_pair", **metric_bundle(yte, m3.predict_proba(X3te))})
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
