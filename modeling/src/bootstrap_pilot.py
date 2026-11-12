#!/usr/bin/env python3
"""Multi-seed pilot robustness for the current-season MCP sample (pipeline only)."""
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


def run_once(matches, seed):
    rng = np.random.default_rng(seed)
    idx = rng.permutation(len(matches))
    n_train = int(len(matches) * 0.6)
    n_valid = int(len(matches) * 0.2)
    train = [matches[i] for i in idx[:n_train]]
    test = [matches[i] for i in idx[n_train + n_valid:]]
    X2tr, ytr, h2 = build_design(train, include_pairs=False)
    X2te, yte, _ = build_design(test, include_pairs=False, hero_vocab=h2)
    X3tr, y3tr, n3 = build_design(train, include_pairs=True)
    hp = [n for n in n3 if n.startswith("hero:")]
    pp = [n for n in n3 if n.startswith("pair:")]
    X3te, y3te, _ = build_design(test, include_pairs=True, hero_vocab=hp, pair_vocab=pp)
    m2 = LogisticModel(l2=1.0).fit(X2tr, ytr)
    m3 = LogisticModel(l2=2.0).fit(X3tr, y3tr)
    return {
        "seed": seed, "n_test": int(len(yte)),
        "M2": metric_bundle(yte, m2.predict_proba(X2te)),
        "M3": metric_bundle(yte, m3.predict_proba(X3te)),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(ROOT / "data" / "bp_lab_current_season.sqlite"))
    ap.add_argument("--out", default=str(ROOT / "modeling" / "reports" / "current_season_bootstrap.json"))
    ap.add_argument("--seeds", type=int, default=10)
    args = ap.parse_args()
    matches = load_matches(args.db)
    rows = [run_once(matches, s) for s in range(1, args.seeds + 1)]
    summary = {}
    for key in ["M2", "M3"]:
        for metric in ["log_loss", "brier", "auc", "ece_10"]:
            vals = [r[key][metric] for r in rows if r[key][metric] is not None]
            summary[f"{key}_{metric}"] = {
                "mean": round(float(np.mean(vals)), 6) if vals else None,
                "std": round(float(np.std(vals)), 6) if vals else None,
                "min": round(float(min(vals)), 6) if vals else None,
                "max": round(float(max(vals)), 6) if vals else None,
            }
    out = {
        "data": "CURRENT_SEASON_OPGG_MCP_PILOT",
        "note": "Multi-seed random splits on a small biased sample; pipeline robustness only, NOT deployment performance.",
        "matches": len(matches),
        "seeds": args.seeds,
        "summary": summary,
        "runs": rows,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"matches": len(matches), "seeds": args.seeds, "summary": summary}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
