"""
Score the latest bar of each symbol with the trained model and rank by P(win).

Uses the same ATR-normalized chart-shape features as training, computed on the
most recent bar (which is unlabeled — no forward window yet), so this is the
live screening step.

Run:
    python -m ml.screen                        # rank the S&P 500 watchlist
    python -m ml.screen --universe "Dow" -n 40
"""
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import joblib

from core.chart_shape import extract_chart_shape
from core.prices import get_daily_ohlc
from ml.dataset import watchlist_symbols

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")

_MODEL = Path(__file__).parent / "models" / "screener.joblib"


def _latest_features(sym, feats):
    try:
        df = get_daily_ohlc(sym)
    except Exception:
        return None
    if df.empty:
        return None
    rows = extract_chart_shape(
        df["Close"].to_numpy(np.float64), df["High"].to_numpy(np.float64),
        df["Low"].to_numpy(np.float64), list(df.index), normalize="atr",
    )
    if not rows:
        return None
    last = rows[-1]
    return {"symbol": sym, "time": last["time"], **{f: last[f] for f in feats}}


def main(universe="S&P 500", top=25, model=_MODEL, workers=8, min_slow_width=None):
    art = joblib.load(model)
    clf, feats = art["model"], art["features"]
    syms = watchlist_symbols(universe)

    recs = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_latest_features, s, feats): s for s in syms}
        for fut in as_completed(futs):
            r = fut.result()
            if r is not None:
                recs.append(r)
    if not recs:
        raise SystemExit("No features computed.")

    df = pd.DataFrame(recs)
    if min_slow_width is not None:
        n0 = len(df)
        df = df[df["slow_width"] > min_slow_width]
        print(f"(slow_width > {min_slow_width}: {len(df)}/{n0} symbols pass)")
    df["p_win"] = clf.predict_proba(df[feats].to_numpy())[:, 1]
    df = df.sort_values("p_win", ascending=False).reset_index(drop=True)

    print(f"\n{universe} — model P(win) ranking (latest bar)  [{len(df)} symbols]\n")
    show = df.head(top)[["symbol", "time", "p_win", "stack", "slope", "macd_hist", "sqz"]]
    print(show.to_string(index=False, formatters={"p_win": "{:.3f}".format}))
    return df


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="S&P 500")
    ap.add_argument("-n", "--top", type=int, default=25)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--min-slow-width", type=float, default=None)
    a = ap.parse_args()
    main(a.universe, a.top, workers=a.workers, min_slow_width=a.min_slow_width)
