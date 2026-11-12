"""Design matrix helpers for match-level draft data.

Each match record format:
{
  "match_id": str,
  "patch": str,
  "blue": {"top": "key", "jungle": "key", "mid": "key", "adc": "key", "support": "key"},
  "red":  {...},
  "blue_win": 0|1
}
"""
import itertools
import numpy as np

ROLES = ["top", "jungle", "mid", "adc", "support"]


def hero_role(key, role):
    return f"hero:{key}:{role}"


def pair_key(a, ra, b, rb):
    # stable ordering by (role, champion)
    x = (ra, a)
    y = (rb, b)
    if x > y:
        x, y = y, x
    return f"pair:{x[0]}:{x[1]}|{y[0]}:{y[1]}"


def team_pairs(picks):
    out = []
    for r1, r2 in itertools.combinations(ROLES, 2):
        a, b = picks.get(r1), picks.get(r2)
        if a and b:
            out.append(pair_key(a, r1, b, r2))
    return out


def build_design(matches, include_pairs=False, hero_vocab=None, pair_vocab=None):
    """Return X, y, feature_names.

    M2 = hero-role main effects with +1 blue / -1 red difference coding.
    M3 = M2 + same-team pair difference features.
    Pass hero_vocab/pair_vocab from the training split to keep feature alignment.
    """
    if hero_vocab is None:
        hero_vocab = sorted({hero_role(v, r) for m in matches for side in ("blue", "red")
                             for r, v in m[side].items() if v})
    else:
        hero_vocab = list(hero_vocab)
    if pair_vocab is None:
        pair_vocab = sorted({p for m in matches for side in ("blue", "red") for p in team_pairs(m[side])})
    else:
        pair_vocab = list(pair_vocab)
    names = list(hero_vocab)
    if include_pairs:
        names += pair_vocab
    hero_idx = {n: i for i, n in enumerate(hero_vocab)}
    pair_idx = {n: len(hero_vocab) + i for i, n in enumerate(pair_vocab)}
    X = np.zeros((len(matches), len(names)), dtype=np.float32)
    y = np.zeros(len(matches), dtype=np.float32)
    for row, m in enumerate(matches):
        y[row] = m["blue_win"]
        for side, sign in (("blue", 1.0), ("red", -1.0)):
            for role, champ in m[side].items():
                if not champ:
                    continue
                idx = hero_idx.get(hero_role(champ, role))
                if idx is not None:
                    X[row, idx] += sign
            if include_pairs:
                for p in team_pairs(m[side]):
                    if p in pair_idx:
                        X[row, pair_idx[p]] += sign
    return X, y, names
