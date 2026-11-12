"""Small dependency-light metrics for BP LAB modeling."""
import math
import numpy as np


def sigmoid(x):
    x = np.asarray(x, dtype=float)
    out = np.empty_like(x, dtype=float)
    pos = x >= 0
    out[pos] = 1.0 / (1.0 + np.exp(-x[pos]))
    ex = np.exp(x[~pos])
    out[~pos] = ex / (1.0 + ex)
    return out


def wilson_interval(wins, n, z=1.96):
    """Wilson score interval for binomial proportion. Returns (low, high) in [0,1]."""
    if n <= 0:
        return (None, None)
    p = wins / n
    denom = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denom
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / denom
    return (max(0.0, centre - margin), min(1.0, centre + margin))


def log_loss(y, p, eps=1e-12):
    y = np.asarray(y, dtype=float)
    p = np.clip(np.asarray(p, dtype=float), eps, 1 - eps)
    return float(-np.mean(y * np.log(p) + (1 - y) * np.log(1 - p)))


def brier(y, p):
    return float(np.mean((np.asarray(p, dtype=float) - np.asarray(y, dtype=float)) ** 2))


def auc(y, p):
    y = np.asarray(y, dtype=np.int8)
    p = np.asarray(p, dtype=float)
    pos = p[y == 1]
    neg = p[y == 0]
    if len(pos) == 0 or len(neg) == 0:
        return None
    # Mann-Whitney U
    order = np.argsort(np.concatenate([pos, neg]), kind="mergesort")
    ranks = np.empty(len(order), dtype=float)
    ranks[order] = np.arange(1, len(order) + 1)
    # average ranks for ties
    values = np.concatenate([pos, neg])
    sorted_vals = values[order]
    i = 0
    while i < len(sorted_vals):
        j = i + 1
        while j < len(sorted_vals) and sorted_vals[j] == sorted_vals[i]:
            j += 1
        if j - i > 1:
            avg = (i + 1 + j) / 2.0
            ranks[order[i:j]] = avg
        i = j
    rank_pos = ranks[:len(pos)].sum()
    return float((rank_pos - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg)))


def ece(y, p, bins=10):
    y = np.asarray(y, dtype=float)
    p = np.asarray(p, dtype=float)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (p >= lo) & (p < hi) if i < bins - 1 else (p >= lo) & (p <= hi)
        if mask.sum() == 0:
            continue
        total += mask.mean() * abs(p[mask].mean() - y[mask].mean())
    return float(total)


def metric_bundle(y, p):
    return {
        "n": int(len(y)),
        "log_loss": round(log_loss(y, p), 6),
        "brier": round(brier(y, p), 6),
        "auc": None if auc(y, p) is None else round(auc(y, p), 6),
        "ece_10": round(ece(y, p, 10), 6),
    }
