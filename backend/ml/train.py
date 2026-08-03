"""
Train the screening model on the labeled panel.

Leakage controls:
  * split by TIME (train -> validation -> test), never shuffled;
  * PURGE the tail of each earlier block so no training label window (t..t+H)
    overlaps the next block;
  * EMBARGO a few days at the start of the later block.

Model: sklearn HistGradientBoostingClassifier (histogram GBDT, no libomp).
Outputs P(win); we evaluate ranking quality, not raw accuracy.

Run:
    python -m ml.train                       # 18-month test, 12-month val
    python -m ml.train --test-months 18 --val-months 12
"""
import argparse
import json
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss

from core.chart_shape import SHAPE_FIELDS

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_DIR       = Path(__file__).parent
_PANEL     = _DIR / "data" / "panel.parquet"
_MODEL_OUT = _DIR / "models" / "screener.joblib"
GAP_DAYS   = 7   # calendar-day purge/embargo (covers H=5 trading days + weekend)


def time_split(df, test_months, val_months):
    """Return (train, val, test) with purge + embargo around the boundaries."""
    t = pd.to_datetime(df["time"])
    tmax = t.max()
    test_start = tmax - pd.DateOffset(months=test_months)
    val_start  = test_start - pd.DateOffset(months=val_months)
    gap = pd.Timedelta(days=GAP_DAYS)

    train = df[t <  (val_start  - gap)]                      # purge tail of train
    val   = df[(t >= (val_start + gap)) & (t < (test_start - gap))]  # embargo + purge
    test  = df[t >= (test_start + gap)]                      # embargo
    return train, val, test, val_start, test_start


def _lift_table(y, p, bins=10):
    """Decile lift: win-rate within each predicted-probability decile."""
    q = pd.qcut(p, bins, labels=False, duplicates="drop")
    d = pd.DataFrame({"y": y, "q": q})
    g = d.groupby("q")["y"].agg(["mean", "count"])
    return g


def _report(name, y, p, base):
    auc  = roc_auc_score(y, p)
    ap   = average_precision_score(y, p)
    brier = brier_score_loss(y, p)
    # precision in the top-decile of scores
    k = max(1, int(0.10 * len(p)))
    top = np.argsort(p)[-k:]
    prec_top = y[top].mean()
    logger.info("[%s] n=%d base=%.3f  AUC=%.4f  AP=%.4f  Brier=%.4f  P@top10%%=%.3f (lift %.2fx)",
                name, len(y), base, auc, ap, brier, prec_top, prec_top / base if base else 0)
    return {"n": int(len(y)), "base": float(base), "auc": float(auc),
            "ap": float(ap), "brier": float(brier),
            "prec_top_decile": float(prec_top),
            "lift_top_decile": float(prec_top / base) if base else 0.0}


def main(test_months=18, val_months=12, panel=_PANEL, out=_MODEL_OUT,
         min_slow_width=None):
    df = pd.read_parquet(panel)
    if min_slow_width is not None:
        n0 = len(df)
        df = df[df["slow_width"] > min_slow_width].reset_index(drop=True)
        logger.info("Filter slow_width > %g: kept %d / %d rows (%.1f%%)",
                    min_slow_width, len(df), n0, 100 * len(df) / n0)
    feats = [c for c in SHAPE_FIELDS if c in df.columns]
    logger.info("Panel: %d rows, %d features, %s..%s",
                len(df), len(feats), df["time"].min(), df["time"].max())

    train, val, test, vs, ts = time_split(df, test_months, val_months)
    logger.info("Split  train=%d (<%s)  val=%d  test=%d (>=%s)",
                len(train), vs.date(), len(val), len(test), ts.date())
    if len(val) == 0 or len(test) == 0:
        raise SystemExit("Empty val/test — widen the window or shrink the holdout.")

    Xtr, ytr = train[feats].to_numpy(), train["label"].to_numpy()
    Xva, yva = val[feats].to_numpy(),   val["label"].to_numpy()
    Xte, yte = test[feats].to_numpy(),  test["label"].to_numpy()

    clf = HistGradientBoostingClassifier(
        loss="log_loss",
        learning_rate=0.05,
        max_iter=400,
        max_leaf_nodes=31,
        min_samples_leaf=200,
        l2_regularization=1.0,
        early_stopping=True,          # random split WITHIN train, for iteration count only
        validation_fraction=0.15,
        n_iter_no_change=30,
        class_weight="balanced",
        random_state=42,
    )
    clf.fit(Xtr, ytr)
    logger.info("Fitted; n_iter=%d", clf.n_iter_)

    base_tr = ytr.mean()
    metrics = {
        "train": _report("train", ytr, clf.predict_proba(Xtr)[:, 1], base_tr),
        "val":   _report("val",   yva, clf.predict_proba(Xva)[:, 1], yva.mean()),
        "test":  _report("test",  yte, clf.predict_proba(Xte)[:, 1], yte.mean()),
    }

    logger.info("Test decile lift (win-rate by predicted-prob decile):\n%s",
                _lift_table(yte, clf.predict_proba(Xte)[:, 1]).to_string())

    out.parent.mkdir(parents=True, exist_ok=True)
    joblib.dump({"model": clf, "features": feats,
                 "val_start": str(vs.date()), "test_start": str(ts.date())}, out)
    (out.parent / "metrics.json").write_text(json.dumps(metrics, indent=2))
    logger.info("Saved model -> %s", out)
    return clf, metrics


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-months", type=int, default=18)
    ap.add_argument("--val-months", type=int, default=12)
    ap.add_argument("--min-slow-width", type=float, default=None,
                    help="keep only entries with slow_width > this (e.g. 0)")
    ap.add_argument("--panel", default=str(_PANEL))
    ap.add_argument("--out", default=str(_MODEL_OUT))
    a = ap.parse_args()
    main(a.test_months, a.val_months, panel=Path(a.panel), out=Path(a.out),
         min_slow_width=a.min_slow_width)
