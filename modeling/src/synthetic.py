"""Synthetic match generator for pipeline smoke tests ONLY.

These are not League of Legends outcomes and must never be presented as real model results.
"""
import random
import numpy as np
import pandas as pd

ROLES = ["top", "jungle", "mid", "adc", "support"]


def generate_synthetic_matches(features_path, n_matches=20000, seed=42):
    random.seed(seed)
    np.random.seed(seed)
    data = pd.read_json(features_path, typ="series")
    champs = data["champions"]
    role_pool = {r: [k for k, c in champs.items() if r in c.get("positions", [])] for r in ROLES}
    role_pool = {r: v for r, v in role_pool.items() if v}

    # latent main effects for champion-role
    hero_effect = {}
    for r, pool in role_pool.items():
        for k in pool:
            hero_effect[(k, r)] = np.random.normal(0, 0.18)

    # a sparse pair-effect pool
    pair_effects = {}
    for _ in range(180):
        r1, r2 = random.sample(ROLES, 2)
        a = random.choice(role_pool[r1])
        b = random.choice(role_pool[r2])
        key = tuple(sorted([(r1, a), (r2, b)]))
        pair_effects[key] = np.random.normal(0, 0.28)

    patches = ["26.18", "26.19", "26.20", "26.21", "26.22"]
    matches = []
    for i in range(n_matches):
        patch = patches[min(int(i / (n_matches / len(patches))), len(patches) - 1)]
        blue = {r: random.choice(role_pool[r]) for r in ROLES}
        red = {r: random.choice(role_pool[r]) for r in ROLES}
        eta = 0.03  # side / environment baseline
        for side, sign in (("blue", 1), ("red", -1)):
            picks = blue if side == "blue" else red
            for r, k in picks.items():
                eta += sign * hero_effect[(k, r)]
            for r1, r2 in [(a, b) for a in ROLES for b in ROLES if a < b]:
                key = tuple(sorted([(r1, picks[r1]), (r2, picks[r2])]))
                eta += sign * pair_effects.get(key, 0.0)
        p = 1 / (1 + np.exp(-eta))
        matches.append({
            "match_id": f"SYN-{i:07d}",
            "patch": patch,
            "blue": blue,
            "red": red,
            "blue_win": int(np.random.random() < p),
        })
    return matches, hero_effect, pair_effects
