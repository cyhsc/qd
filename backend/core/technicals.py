"""
Technical-indicator calculations powered by TA-Lib.

Each function accepts a numpy float64 array of close prices and a
parallel list of chart-compatible timestamps (int Unix or "YYYY-MM-DD"
strings), and returns the same time-series shape expected by the
/indicators API response.
"""

import numpy as np
import talib


def calc_ema(closes: np.ndarray, period: int, times: list) -> list[dict]:
    """Exponential Moving Average.

    Returns a list of ``{time, value}`` dicts with the NaN warm-up
    period stripped.
    """
    vals = talib.EMA(closes, timeperiod=period)
    return [
        {"time": times[i], "value": round(float(v), 4)}
        for i, v in enumerate(vals)
        if not np.isnan(v)
    ]


def calc_sma(closes: np.ndarray, period: int, times: list) -> list[dict]:
    """Simple Moving Average.

    Returns a list of ``{time, value}`` dicts with the NaN warm-up
    period stripped.
    """
    vals = talib.SMA(closes, timeperiod=period)
    return [
        {"time": times[i], "value": round(float(v), 4)}
        for i, v in enumerate(vals)
        if not np.isnan(v)
    ]


def calc_macd(
    closes: np.ndarray,
    fast: int,
    slow: int,
    signal: int,
    times: list,
) -> dict:
    """MACD (Moving Average Convergence/Divergence).

    Returns a dict with three keys:
    - ``macd_line``   – list of ``{time, value}``
    - ``signal_line`` – list of ``{time, value}``
    - ``histogram``   – list of ``{time, value}``

    Entries where the MACD line is still in the warm-up period (NaN) are
    omitted.  Signal / histogram entries are omitted until the signal
    EMA itself becomes valid.
    """
    macd_arr, signal_arr, hist_arr = talib.MACD(
        closes, fastperiod=fast, slowperiod=slow, signalperiod=signal
    )

    macd_line, signal_line, histogram = [], [], []
    for i in range(len(closes)):
        m, s, h = macd_arr[i], signal_arr[i], hist_arr[i]
        if np.isnan(m):
            continue
        macd_line.append({"time": times[i], "value": round(float(m), 6)})
        if not np.isnan(s):
            signal_line.append({"time": times[i], "value": round(float(s), 6)})
            histogram.append(  {"time": times[i], "value": round(float(h), 6)})

    return {
        "macd_line":   macd_line,
        "signal_line": signal_line,
        "histogram":   histogram,
    }


# ── Guppy Multiple Moving Average ─────────────────────────────────────────────

GUPPY_SHORT = [3, 5, 8, 10, 12, 15]
GUPPY_LONG  = [30, 35, 40, 45, 50, 60]


def calc_guppy(closes: np.ndarray, times: list) -> dict:
    """Guppy Multiple Moving Average (GMMA).

    Returns a dict with two keys:
    - ``short`` – EMAs for periods 3, 5, 8, 10, 12, 15
    - ``long``  – EMAs for periods 30, 35, 40, 45, 50, 60

    Each value is itself a dict keyed by period string, e.g.
    ``{"3": [{time, value}, ...], "5": [...], ...}``.
    """
    return {
        "short": {
            str(p): calc_ema(closes, p, times)
            for p in GUPPY_SHORT if len(closes) >= p
        },
        "long": {
            str(p): calc_ema(closes, p, times)
            for p in GUPPY_LONG if len(closes) >= p
        },
    }
