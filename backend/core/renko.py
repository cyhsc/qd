# --------------------------------------------------------------------------------
# Copyright (C) [2025] [Bumblebee Networks Inc.]
# All rights reserved. Unauthorized use is prohibited.
# --------------------------------------------------------------------------------
"""
Renko brick computation using the stocktrends library.
"""
import logging

import numpy as np
import pandas as pd
from stocktrends import Renko

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _calc_atr(df: pd.DataFrame, period: int = 14) -> float:
    """Average True Range of the last *period* bars."""
    closes = df['close'].values
    highs  = df['high'].values
    lows   = df['low'].values
    trs = [
        max(highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i]  - closes[i - 1]))
        for i in range(1, len(closes))
    ]
    n = min(period, len(trs))
    return float(np.mean(trs[-n:])) if trs else float(closes[-1] * 0.01)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def compute_renko(df: pd.DataFrame, brick_size: float | None = None) -> dict:
    """
    Compute Renko bricks from an OHLCV DataFrame.

    Parameters
    ----------
    df:
        DataFrame with columns ``[date, open, high, low, close, volume]``.
        ``date`` must be timezone-naive ``pd.Timestamp`` values.
        The index must be a ``RangeIndex`` starting at 0 (call
        ``df.reset_index(drop=True)`` before passing).
    brick_size:
        Fixed brick size in price units.  ``None`` (default) computes
        ATR(14) from the data.

    Returns
    -------
    dict
        ``brick_size`` – the brick size used (float)
        ``bricks``     – list of dicts, each with:
                         ``date`` (str "YYYY-MM-DD"),
                         ``open``, ``high``, ``low``, ``close`` (float),
                         ``uptrend`` (bool)

    Raises
    ------
    ValueError
        If the DataFrame is empty or too short to compute any bricks.
    """
    if df.empty:
        raise ValueError("Cannot compute Renko bricks: input DataFrame is empty")

    if brick_size is None:
        brick_size = _calc_atr(df, 14)

    brick_size = max(float(brick_size), 1e-9)   # guard against zero / negative

    logger.debug("Building Renko bricks: %d rows, brick_size=%.6f", len(df), brick_size)

    r = Renko(df.copy())
    r.brick_size = brick_size
    bricks_df = r.get_ohlc_data()

    if bricks_df.empty:
        raise ValueError(
            f"No Renko bricks generated (brick_size={brick_size:.6f} may be larger than price range)"
        )

    bricks = []
    for _, row in bricks_df.iterrows():
        date = row['date']
        bricks.append({
            'date':    str(date.date()) if hasattr(date, 'date') else str(date)[:10],
            'open':    round(float(row['open']),  4),
            'high':    round(float(row['high']),  4),
            'low':     round(float(row['low']),   4),
            'close':   round(float(row['close']), 4),
            'uptrend': bool(row['uptrend']),
        })

    logger.info(
        "Renko: %d input bars → %d bricks (brick_size=%.4f)",
        len(df), len(bricks), brick_size,
    )
    return {'brick_size': round(brick_size, 6), 'bricks': bricks}
