"""Train M1/M2/M3 on synthetic data to verify the modeling pipeline.

Run:
  /path/to/python modeling/src/run_smoke.py
"""
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import build_design
from metrics import metric_bundle, log_loss, brier
from model import LogisticModel
from synthetic import generate_synthetic_matches


def split_by_patch(matches):
    patches = sorted({m["patch"] for m in matches})
    train = [m for m in matches if m["patch"] in patches[:3]]
    valid = [m for m in matches if m["patch"] == patches[3]]
    test = [m for m in matches if m["patch"] == patches[4]]
    return train, valid, test


def eval_model(name, model, X, y, default_p):
    p = model.predict_proba(X) if model else np.full(len(y), default_p)
    return {"model": name, **metric_bundle(y, p)}


def main():
    matches, _, _ = generate_synthetic_matches(ROOT / "data" / "bp_backend_features.json", n_matches=20000)
    train, valid, test = split_by_patch(matches)
    print("splits", len(train), len(valid), len(test))

    X2tr, ytr, names2 = build_design(train, include_pairs=False)
    X2va, yva, _ = build_design(valid, include_pairs=False, hero_vocab=names2)
    X2te, yte, _ = build_design(test, include_pairs=False, hero_vocab=names2)
    X3tr, y3tr, names3 = build_design(train, include_pairs=True)
    pair_vocab = [n for n in names3 if n.startswith("pair:")]
    hero_vocab = [n for n in names3 if n.startswith("hero:")]
    X3va, y3va, _ = build_design(valid, include_pairs=True, hero_vocab=hero_vocab, pair_vocab=pair_vocab)
    X3te, y3te, _ = build_design(test, include_pairs=True, hero_vocab=hero_vocab, pair_vocab=pair_vocab)

    m0 = eval_model("M0_50pct", None, X2te, yte, 0.5)
    m1 = eval_model("M1_side_constant", None, X2te, yte, float(ytr.mean()))
    m2 = LogisticModel(l2=1.0).fit(X2tr, ytr)
    m3 = LogisticModel(l2=2.0).fit(X3tr, y3tr)

    report = {
        "data": "SYNTHETIC_SMOKE_TEST_ONLY",
        "note": "These numbers are generated from random synthetic data and are NOT evidence about League of Legends.",
        "split": {"train": len(train), "valid": len(valid), "test": len(test)},
        "metrics": [
            m0,
            m1,
            eval_model("M2_hero_role", m2, X2te, yte, float(ytr.mean())),
            eval_model("M3_hero_pair", m3, X3te, y3te, float(ytr.mean())),
        ],
    }
    out = ROOT / "modeling" / "reports" / "synthetic_smoke.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
