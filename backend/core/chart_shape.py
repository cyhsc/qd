"""
Chart-shape feature extractor.

Turns each bar into a small, *dimensionless* signature that describes the
**structure** of the chart (ordering, slope, curvature, spread, compression)
rather than its price level.  Because every field is a ratio, angle, rank, or
regime code, the signature means the same thing for a $5 stock and a $500 one —
no per-stock scaling needed, and no lookahead (every value uses only data up to
and including that bar).

The signature combines four of the app's indicators:

GMMA (Guppy Multiple Moving Average — the 12 EMAs)
  - ``stack``       ordering of the 12 EMAs: +1 perfect bullish fan (short over
                    long), -1 perfect bearish fan, ~0 tangled.  Kendall-style
                    concordance over all EMA pairs.
  - ``separation``  gap between the fast and slow EMA bundles, divided by price
                    (this is the RWB gap, made scale-free).  >0 fast above slow.
  - ``sep_trend``   change in ``separation`` over ``lookback`` bars — the bundle
                    expanding (>0) or contracting (<0).
  - ``slope``       normalized slope of the bundle center: fractional price
                    change per bar (≈ percent/100 per bar).
  - ``curvature``   normalized 2nd difference of the bundle center: accelerating
                    (>0) vs rolling over (<0).
  - ``fast_slow``   bundle-slope alignment: slope(fast bundle) − slope(slow
                    bundle).  >0 the fast EMAs are leading (momentum building).

MACD (12,26,9)
  - ``macd``        MACD line / price.
  - ``macd_hist``   MACD histogram / price (momentum acceleration).

SQZ (Beardy Squeeze Pro)
  - ``sqz``         compression regime in [0,1]: 0 no squeeze, 0.33 low,
                    0.67 mid, 1.0 tightest.
  - ``sqz_mom``     squeeze momentum / price (signed strength of the squeeze).

Every field is unitless, so the per-bar vectors are directly comparable across
symbols and can be fed to a model as-is.
"""

import numpy as np
import talib

from core.technicals import GUPPY_SHORT, GUPPY_LONG, calc_squeeze

# The 12 GMMA periods, shortest → longest.
_GUPPY_ALL = GUPPY_SHORT + GUPPY_LONG

# Squeeze dot color → compression ordinal (see calc_squeeze docstring).
_SQZ_LEVEL = {
    "#ff9800": 3,   # orange – tightest
    "#ef5350": 2,   # red    – mid
    "#434651": 1,   # gray   – low
    "#26a69a": 0,   # green  – no squeeze
}

# Field order of the emitted signature (handy for CSV / vectorizing).
SHAPE_FIELDS = [
    "stack", "separation", "sep_trend", "slope", "curvature", "fast_slow",
    "macd", "macd_hist", "sqz", "sqz_mom",
]


def _stack_score(vals: list[float]) -> float:
    """Kendall-style ordering of EMAs (shortest→longest period).

    +1 when every shorter EMA sits above every longer EMA (perfect bullish
    fan), -1 for the perfect bearish fan, 0 when fully tangled.
    """
    concordant = 0
    total = 0
    n = len(vals)
    for i in range(n):
        for j in range(i + 1, n):      # period_i < period_j
            total += 1
            if vals[i] > vals[j]:
                concordant += 1
            elif vals[i] < vals[j]:
                concordant -= 1
    return concordant / total if total else 0.0


def extract_chart_shape(
    closes: np.ndarray,
    highs:  np.ndarray,
    lows:   np.ndarray,
    times:  list,
    lookback: int = 5,
    normalize: str = "price",
    atr_period: int = 14,
) -> list[dict]:
    """Compute the per-bar chart-shape signature.

    Returns a list of ``{time, <SHAPE_FIELDS>}`` dicts.  Warm-up bars (where any
    component is undefined) are omitted, so the result starts once the longest
    EMA plus the slope/curvature lookback are available.

    ``normalize`` controls the denominator for the price-relative fields
    (``separation``, ``sep_trend``, ``slope``, ``curvature``, ``fast_slow``,
    ``macd``, ``macd_hist``, ``sqz_mom``):

    - ``"price"`` (default) – divide by the bar's close.  Dimensionless, but a
      quiet stock still shows systematically smaller magnitudes than a volatile
      one.
    - ``"atr"`` – divide by the bar's ATR(``atr_period``).  Expresses everything
      in "typical daily moves", so magnitudes are comparable across both price
      level *and* volatility regime.

    ``stack`` and ``sqz`` are pure orderings/regimes and are unaffected.
    """
    if normalize not in ("price", "atr"):
        raise ValueError("normalize must be 'price' or 'atr'")

    closes = np.asarray(closes, dtype=np.float64)
    highs  = np.asarray(highs,  dtype=np.float64)
    lows   = np.asarray(lows,   dtype=np.float64)
    n = len(closes)
    if n == 0:
        return []

    # Per-bar denominator for the price-relative fields.
    if normalize == "atr":
        denom_arr = talib.ATR(highs, lows, closes, timeperiod=atr_period)
    else:
        denom_arr = closes

    # EMAs for the 12 guppy periods.
    emas = {p: talib.EMA(closes, timeperiod=p) for p in _GUPPY_ALL}
    fast_arr = np.vstack([emas[p] for p in GUPPY_SHORT])   # (6, n)
    slow_arr = np.vstack([emas[p] for p in GUPPY_LONG])    # (6, n)
    all_arr  = np.vstack([emas[p] for p in _GUPPY_ALL])    # (12, n)

    fast_center = fast_arr.mean(axis=0)
    slow_center = slow_arr.mean(axis=0)
    center      = all_arr.mean(axis=0)

    # MACD (default settings, matching the chart).
    macd_line, _sig, macd_hist = talib.MACD(
        closes, fastperiod=12, slowperiod=26, signalperiod=9
    )

    # Squeeze — reuse the exact chart logic, then index by time.
    sqz = calc_squeeze(closes, highs, lows, times)
    sqz_by_time: dict = {}
    for dot, mom in zip(sqz["sqz"], sqz["mom"]):
        sqz_by_time[dot["time"]] = (
            _SQZ_LEVEL.get(dot["color"], 0),
            mom["value"],
        )

    def _valid_denom(i: int) -> float | None:
        d = denom_arr[i]
        return None if (np.isnan(d) or d == 0) else float(d)

    def _nslope(arr: np.ndarray, i: int, denom: float) -> float | None:
        a0, a1 = arr[i - lookback], arr[i]
        if np.isnan(a0) or np.isnan(a1):
            return None
        return (a1 - a0) / denom / lookback

    out: list[dict] = []
    for i in range(n):
        col = all_arr[:, i]
        if np.isnan(col).any() or i < 2 * lookback:
            continue
        denom = _valid_denom(i)
        if denom is None:
            continue

        # GMMA structure
        stack = _stack_score(list(col))

        fmin, fmax = fast_arr[:, i].min(), fast_arr[:, i].max()
        smin, smax = slow_arr[:, i].min(), slow_arr[:, i].max()
        if   fmin > smax: gap = fmin - smax        # fast bundle above slow
        elif smin > fmax: gap = fmax - smin        # slow bundle above fast (neg)
        else:             gap = 0.0
        separation = gap / denom

        # separation `lookback` bars ago, for its trend
        prev_gap = None
        j = i - lookback
        denom_j = _valid_denom(j) if j >= 0 else None
        if denom_j is not None and not np.isnan(all_arr[:, j]).any():
            pf, ps = fast_arr[:, j], slow_arr[:, j]
            if   pf.min() > ps.max(): pg = pf.min() - ps.max()
            elif ps.min() > pf.max(): pg = pf.max() - ps.min()
            else:                     pg = 0.0
            prev_gap = pg / denom_j
        sep_trend = (separation - prev_gap) if prev_gap is not None else 0.0

        slope     = _nslope(center, i, denom)
        # curvature: normalized 2nd difference of the bundle center
        a0, a1, a2 = center[i - 2 * lookback], center[i - lookback], center[i]
        curvature  = None if (np.isnan(a0) or np.isnan(a1) or np.isnan(a2)) else (a2 - 2 * a1 + a0) / denom

        fs_fast = _nslope(fast_center, i, denom)
        fs_slow = _nslope(slow_center, i, denom)
        fast_slow = (fs_fast - fs_slow) if (fs_fast is not None and fs_slow is not None) else None

        if slope is None or curvature is None or fast_slow is None:
            continue

        # MACD structure
        m = macd_line[i]
        h = macd_hist[i]
        macd_norm = float(m) / denom if not np.isnan(m) else 0.0
        hist_norm = float(h) / denom if not np.isnan(h) else 0.0

        # SQZ structure
        level, mom = sqz_by_time.get(times[i], (0, 0.0))
        sqz_state = level / 3.0
        sqz_mom   = mom / denom

        out.append({
            "time":       times[i],
            "stack":      round(stack, 4),
            "separation": round(separation, 6),
            "sep_trend":  round(sep_trend, 6),
            "slope":      round(slope, 6),
            "curvature":  round(curvature, 6),
            "fast_slow":  round(fast_slow, 6),
            "macd":       round(macd_norm, 6),
            "macd_hist":  round(hist_norm, 6),
            "sqz":        round(sqz_state, 4),
            "sqz_mom":    round(sqz_mom, 6),
        })

    return out
