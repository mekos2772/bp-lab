"""Regularized logistic regression implemented with numpy (no sklearn dependency)."""
import numpy as np
from metrics import sigmoid


class LogisticModel:
    def __init__(self, l2=1.0, max_iter=80, tol=1e-7):
        self.l2 = float(l2)
        self.max_iter = int(max_iter)
        self.tol = float(tol)
        self.coef_ = None
        self.intercept_ = None

    def fit(self, X, y):
        X = np.asarray(X, dtype=float)
        y = np.asarray(y, dtype=float)
        n, d = X.shape
        Xb = np.column_stack([np.ones(n), X])
        w = np.zeros(d + 1)
        pen = self.l2 * np.diag(np.r_[0.0, np.ones(d)])
        for _ in range(self.max_iter):
            z = Xb @ w
            p = sigmoid(z)
            W = np.clip(p * (1 - p), 1e-9, None)
            grad = Xb.T @ (p - y) / n + self.l2 * np.r_[0.0, w[1:]]
            H = (Xb.T * W) @ Xb / n + pen
            try:
                delta = np.linalg.solve(H, grad)
            except np.linalg.LinAlgError:
                delta = np.linalg.pinv(H) @ grad
            w -= delta
            if np.linalg.norm(delta) < self.tol:
                break
        self.intercept_ = float(w[0])
        self.coef_ = w[1:]
        return self

    def predict_proba(self, X):
        X = np.asarray(X, dtype=float)
        return sigmoid(X @ self.coef_ + self.intercept_)
