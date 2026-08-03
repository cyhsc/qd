"""
Cost-aware evaluation of the screener on the out-of-sample test block.

Each labeled bar already carries ``tb_ret`` — the realized return of taking that
triple-barrier trade (exit at the barrier that resolved it).  So a selection
rule's expectancy is just the mean net ``tb_ret`` of the entries it picks.  We
compare the model's top picks against sensible baselines.

Run:
    python -m ml.backtest                      # top-decile vs baselines, 20bps cost
    python -m ml.backtest --cost 0.001 --top-frac 0.05
"""
import argparse
import logging
from pathlib import Path

import numpy as np
import pandas as pd
import joblib

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_DIR   = Path(__file__).parent
_PANEL = _DIR / "data" / "panel.parquet"
_MODEL = _DIR / "models" / "screener.joblib"


def _stats(name, ret, cost):
    net = ret - cost
    n = len(net)
    if n == 0:
        logger.info("[%s] no trades", name); return
    wr = (ret > 0).mean()
    exp = net.mean()
    # per-trade Sharpe-like ratio (not annualized; trades overlap)
    sharpe = exp / net.std() if net.std() else 0.0
    logger.info("[%-16s] trades=%6d  win%%=%.1f  exp/trade=%+.4f  total=%+.2f  ratio=%+.3f",
                name, n, 100 * wr, exp, net.sum(), sharpe)


def main(cost=0.002, top_frac=0.10, panel=_PANEL, model=_MODEL, min_slow_width=None):
    art = joblib.load(model)
    clf, feats, ts = art["model"], art["features"], art["test_start"]
    df = pd.read_parquet(panel)
    if min_slow_width is not None:
        df = df[df["slow_width"] > min_slow_width]
        logger.info("Filter slow_width > %g applied to test block.", min_slow_width)
    gap = pd.Timedelta(days=7)
    test = df[pd.to_datetime(df["time"]) >= (pd.to_datetime(ts) + gap)].copy()
    if test.empty:
        raise SystemExit("Empty test block.")

    test["p"] = clf.predict_proba(test[feats].to_numpy())[:, 1]
    logger.info("Test block: %d entries, %s..%s, cost=%.0fbps/round-trip",
                len(test), test["time"].min(), test["time"].max(), cost * 1e4)

    k = max(1, int(top_frac * len(test)))
    top = test.nlargest(k, "p")
    rng = np.random.default_rng(0)
    rand = test.iloc[rng.choice(len(test), k, replace=False)]

    logger.info("Baseline expectancy is negative by construction (1.5:1 payoff, ~29%% base win-rate).")
    _stats("ALL entries",      test["tb_ret"].to_numpy(), cost)
    _stats(f"RANDOM top {int(top_frac*100)}%", rand["tb_ret"].to_numpy(), cost)
    _stats(f"MODEL top {int(top_frac*100)}%",  top["tb_ret"].to_numpy(),  cost)

    # threshold sweep — expectancy as we get more selective
    logger.info("Expectancy vs selectivity (model P(win) percentile cutoff):")
    for pct in (50, 75, 90, 95, 99):
        thr = np.percentile(test["p"], pct)
        sel = test[test["p"] >= thr]
        net = sel["tb_ret"].to_numpy() - cost
        logger.info("  >=P%02d (thr=%.3f)  n=%6d  win%%=%.1f  exp/trade=%+.4f",
                    pct, thr, len(sel), 100 * (sel["tb_ret"] > 0).mean(), net.mean())


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cost", type=float, default=0.002, help="round-trip cost (fraction)")
    ap.add_argument("--top-frac", type=float, default=0.10)
    ap.add_argument("--min-slow-width", type=float, default=None)
    ap.add_argument("--panel", default=str(_PANEL))
    ap.add_argument("--model", default=str(_MODEL))
    a = ap.parse_args()
    main(a.cost, a.top_frac, panel=Path(a.panel), model=Path(a.model),
         min_slow_width=a.min_slow_width)
