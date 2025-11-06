import sys
import json
import math
from typing import Any, Dict

import numpy as np
import xgboost as xgb


def mae(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.mean(np.abs(y_true - y_pred)))


def rmse(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    return float(np.sqrt(np.mean((y_true - y_pred) ** 2)))


def r2(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_true = y_true.astype(float)
    y_pred = y_pred.astype(float)
    mean = float(np.mean(y_true))
    ss_res = float(np.sum((y_true - y_pred) ** 2))
    ss_tot = float(np.sum((y_true - mean) ** 2))
    if ss_tot == 0:
        return 0.0
    return float(1.0 - (ss_res / ss_tot))


def main():
    raw = sys.stdin.read()
    payload: Dict[str, Any] = json.loads(raw)

    X_train = np.array(payload["Xtrain"], dtype=np.float32)
    y_train = np.array(payload["ytrain"], dtype=np.float32)
    X_val = np.array(payload["Xval"], dtype=np.float32)
    y_val = np.array(payload["yval"], dtype=np.float32)
    latest = payload.get("latest", {})  # { bikeId: [featsStd...] }
    target_cap = float(payload.get("targetCap", 500))

    dtrain = xgb.DMatrix(X_train, label=y_train)
    dval = xgb.DMatrix(X_val, label=y_val)

    params = {
        "objective": "reg:squarederror",
        "max_depth": 6,
        "eta": 0.1,
        "subsample": 0.8,
        "colsample_bytree": 0.8,
        "eval_metric": ["rmse", "mae"],
        # Use a deterministic seed for reproducibility
        "seed": 42,
    }

    evals = [(dtrain, "train"), (dval, "val")]
    booster = xgb.train(params, dtrain, num_boost_round=200, evals=evals, early_stopping_rounds=20)

    yhat_train = booster.predict(dtrain)
    yhat_val = booster.predict(dval)

    # Cap predictions to target range
    yhat_train = np.clip(yhat_train, 0, target_cap)
    yhat_val = np.clip(yhat_val, 0, target_cap)

    metrics_train = {
        "mae": mae(y_train, yhat_train),
        "rmse": rmse(y_train, yhat_train),
        "r2": r2(y_train, yhat_train),
    }
    metrics_val = {
        "mae": mae(y_val, yhat_val),
        "rmse": rmse(y_val, yhat_val),
        "r2": r2(y_val, yhat_val),
    }

    latest_preds: Dict[str, float] = {}
    for bike_id, feats in latest.items():
        xf = np.array([feats], dtype=np.float32)
        dm = xgb.DMatrix(xf)
        pred = float(booster.predict(dm)[0])
        latest_preds[bike_id] = float(max(0.0, min(target_cap, pred)))

    # Save model bytes for potential future use
    booster_bytes = booster.save_raw()
    booster_b64 = booster_bytes.decode("latin1")  # keep binary roundtrip via latin1; backend can re-encode if needed

    out = {
        "metrics": {"train": metrics_train, "val": metrics_val},
        "latest": latest_preds,
        "engine": "python-xgb",
        "boosterRaw": booster_b64,
    }
    sys.stdout.write(json.dumps(out))


if __name__ == "__main__":
    main()


