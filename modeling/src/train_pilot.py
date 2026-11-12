#!/usr/bin/env python3
"""Pilot-training on a current-season OP.GG MCP sample.

This is NOT a deployment model: the sample comes from a few champion leaderboards,
has a single patch snapshot, and uses a random match split because there is no
time-forward holdout available. It exists to test the real-data pipeline.
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "bp_lab_current_season.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "modeling" / "reports" / "current_season_pilot.json"))
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    matches = load_matches(args.db)
    if len(matches) < 100:
        raise SystemExit(f"Need at least 100 valid matches, got {len(matches)}")
    rng = np.random.default_rng(args.seed)
    idx = rng.permutation(len(matches))
    n_train = int(len(matches) * 0.6)
    n_valid = int(len(matches) * 0.2)
    train = [matches[i] for i in idx[:n_train]]
    valid = [matches[i] for i in idx[n_train:n_train + n_valid]]
    test = [matches[i] for i in idx[n_train + n_valid:]]

    X2tr, ytr, h2 = build_design(train, include_pairs=False)
    X2va, yva, _ = build_design(valid, include_pairs=False, hero_vocab=h2)
    X2te, yte, _ = build_design(test, include_pairs=False, hero_vocab=h2)
    X3tr, y3tr, n3 = build_design(train, include_pairs=True)
    hp = [n for n in n3 if n.startswith("hero:")]
    pp = [n for n in n3 if n.startswith("pair:")]
    X3va, y3va, _ = build_design(valid, include_pairs=True, hero_vocab=hp, pair_vocab=pp)
    X3te, y3te, _ = build_design(test, include_pairs=True, hero_vocab=hp, pair_vocab=pp)

    out = {
        "data": "CURRENT_SEASON_OPGG_MCP_PILOT",
        "note": "Top-player biased sample; single-patch random split; NOT a deployable model.",
        "split": {"train": len(train), "valid": len(valid), "test": len(test)},
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
