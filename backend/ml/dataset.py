"""
Build a labeled feature panel for supervised screening.

Rows are (symbol, date) with the chart-shape signature (ATR-normalized, so the
features are comparable across stocks) as inputs and a triple-barrier binary
label as the target.  Point-in-time correct: features use data <= t, the label
uses bars t+1 .. t+H.

Run:
    python -m ml.dataset                      # S&P 500, 2012->present, Tu/Td/H defaults
    python -m ml.dataset --universe "Dow" --start 2015-01-01
"""
import argparse
import logging
import sqlite3
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd
import talib

from core.chart_shape import extract_chart_shape, SHAPE_FIELDS
from core.prices import get_daily_ohlc
from ml.labels import triple_barrier

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

_DB       = Path(__file__).parent.parent / "db" / "qd.db"
_DATA_DIR = Path(__file__).parent / "data"
META_COLS = ["outcome", "tb_days", "tb_ret"]   # kept for analysis, not model inputs


def watchlist_symbols(name: str) -> list[str]:
    con = sqlite3.connect(_DB)
    try:
        rows = con.execute(
            "SELECT ws.symbol FROM watchlist_symbols ws "
            "JOIN watchlists w ON w.id = ws.watchlist_id "
            "WHERE w.name = ? ORDER BY ws.position",
            (name,),
        ).fetchall()
    finally:
        con.close()
    return [r[0] for r in rows]


def build_symbol(sym: str, Tu: float, Td: float, H: int, start: str | None):
    """Feature + label rows for one symbol, or None if unusable."""
    try:
        df = get_daily_ohlc(sym)
    except Exception as exc:               # noqa: BLE001
        logger.warning("%-6s skipped: %s", sym, exc)
        return None
    if df.empty or len(df) < 80:
        return None

    close = df["Close"].to_numpy(np.float64)
    high  = df["High"].to_numpy(np.float64)
    low   = df["Low"].to_numpy(np.float64)
    times = list(df.index)

    feats = extract_chart_shape(close, high, low, times, normalize="atr")
    if not feats:
        return None
    fdf = pd.DataFrame(feats).set_index("time")

    atr = talib.ATR(high, low, close, timeperiod=14)
    label, outcome, days, ret = triple_barrier(close, high, low, atr, Tu, Td, H)
    ldf = pd.DataFrame(
        {"label": label, "outcome": outcome, "tb_days": days, "tb_ret": ret},
        index=pd.Index(times, name="time"),
    )

    j = fdf.join(ldf, how="inner")
    j = j[j["label"] >= 0]                  # drop undefined (warmup + trailing H bars)
    if start:
        j = j[j.index >= start]
    if j.empty:
        return None

    j.insert(0, "symbol", sym)
    return j.reset_index()                  # 'time' back to a column


def build_panel(universe="S&P 500", Tu=1.5, Td=1.0, H=5,
                start="2012-01-01", workers=8, out=None):
    syms = watchlist_symbols(universe)
    if not syms:
        raise SystemExit(f"No symbols in watchlist {universe!r}")
    logger.info("Building panel: %s (%d symbols), Tu=%s Td=%s H=%d start=%s",
                universe, len(syms), Tu, Td, H, start)

    parts, ok, empty = [], 0, 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(build_symbol, s, Tu, Td, H, start): s for s in syms}
        for fut in as_completed(futs):
            r = fut.result()
            if r is None or r.empty:
                empty += 1
            else:
                parts.append(r); ok += 1

    if not parts:
        raise SystemExit("No data produced.")
    panel = pd.concat(parts, ignore_index=True)
    panel = panel.sort_values(["time", "symbol"]).reset_index(drop=True)

    out = Path(out) if out else _DATA_DIR / "panel.parquet"
    out.parent.mkdir(parents=True, exist_ok=True)
    panel.to_parquet(out, index=False)

    # ── Summary ──────────────────────────────────────────────────────────────
    n = len(panel)
    wins = int(panel["label"].sum())
    oc = panel["outcome"].value_counts()
    logger.info("Symbols used: %d  (empty/failed: %d)", ok, empty)
    logger.info("Rows: %d   date span: %s .. %s", n, panel["time"].min(), panel["time"].max())
    logger.info("Label balance: win=%d (%.1f%%)  not-win=%d (%.1f%%)",
                wins, 100 * wins / n, n - wins, 100 * (n - wins) / n)
    logger.info("Outcome mix: %s",
                {k: f"{v} ({100*v/n:.1f}%)" for k, v in oc.items()})
    logger.info("Avg realized tb_ret by outcome:\n%s",
                panel.groupby("outcome")["tb_ret"].mean().round(4).to_string())
    logger.info("Wrote %s", out)
    return panel


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--universe", default="S&P 500")
    ap.add_argument("--tu", type=float, default=1.5)
    ap.add_argument("--td", type=float, default=1.0)
    ap.add_argument("--horizon", type=int, default=5)
    ap.add_argument("--start", default="2012-01-01")
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--out", default=None)
    a = ap.parse_args()
    build_panel(a.universe, a.tu, a.td, a.horizon, a.start, a.workers, a.out)
