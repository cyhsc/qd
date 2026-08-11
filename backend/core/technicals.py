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


def calc_stochrsi(
    closes: np.ndarray,
    rsi_period:   int,
    stoch_period: int,
    k_smooth:     int,
    d_smooth:     int,
    times:        list,
) -> dict:
    """Stochastic RSI.

    Computes RSI over ``rsi_period``, stochastic-normalizes it over
    ``stoch_period`` (``(rsi − min) / (max − min) × 100``), then smooths
    the result by ``k_smooth`` (%K) and smooths %K again by ``d_smooth``
    (%D).  Both lines live on a 0–100 scale.

    Returns a dict with two keys:
    - ``k`` – %K line: list of ``{time, value}``
    - ``d`` – %D line: list of ``{time, value}``

    Warm-up entries (NaN) are omitted independently for each line.
    """
    rsi     = talib.RSI(closes, timeperiod=rsi_period)
    lowest  = talib.MIN(rsi, timeperiod=stoch_period)
    highest = talib.MAX(rsi, timeperiod=stoch_period)
    denom   = highest - lowest
    with np.errstate(invalid="ignore", divide="ignore"):
        stoch = np.where(denom == 0, 0.0, (rsi - lowest) / denom * 100.0)

    k = talib.SMA(stoch, timeperiod=k_smooth)
    d = talib.SMA(k,     timeperiod=d_smooth)

    k_out: list = []
    d_out: list = []
    for i in range(len(closes)):
        if not np.isnan(k[i]):
            k_out.append({"time": times[i], "value": round(float(k[i]), 4)})
        if not np.isnan(d[i]):
            d_out.append({"time": times[i], "value": round(float(d[i]), 4)})

    return {"k": k_out, "d": d_out}


# ── Guppy Multiple Moving Average ─────────────────────────────────────────────

GUPPY_SHORT = [3, 5, 8, 10, 12, 15]
GUPPY_LONG  = [30, 35, 40, 45, 50, 60]


# ── RWB (Red-White-Blue) ───────────────────────────────────────────────────────

RWB_FAST = [3, 5, 7, 10, 12, 15]
RWB_SLOW = [30, 35, 40, 45, 50, 60]


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


def calc_rwb(closes: np.ndarray, times: list) -> dict:
    """RWB (Red-White-Blue) indicator.

    Three series:
    - ``fast_width`` – signed spread of the fast EMA group (periods 3,5,7,10,12,15),
      positive when MA3 > MA15, negative otherwise.  Rendered as a line.
    - ``slow_width`` – signed spread of the slow EMA group (periods 30,35,40,45,50,60),
      positive when MA30 > MA60, negative otherwise.  Per-bar color: green when
      slow_width > previous slow_width, red otherwise.
    - ``rwb``        – gap between the two groups: positive when fast group is above
      slow group, negative when slow group is above fast group, 0 when overlapping.
      Rendered as a gray histogram.
    """
    fast_emas = {p: talib.EMA(closes, timeperiod=p) for p in RWB_FAST}
    slow_emas = {p: talib.EMA(closes, timeperiod=p) for p in RWB_SLOW}

    fast_width_out: list = []
    slow_width_out: list = []
    rwb_out:        list = []

    prev_slow_width = None

    for i in range(len(closes)):
        fast_vals = [fast_emas[p][i] for p in RWB_FAST]
        slow_vals = [slow_emas[p][i] for p in RWB_SLOW]

        if any(np.isnan(v) for v in fast_vals + slow_vals):
            prev_slow_width = None
            continue

        fast_max, fast_min = max(fast_vals), min(fast_vals)
        slow_max, slow_min = max(slow_vals), min(slow_vals)

        ma3,  ma15 = fast_emas[3][i],  fast_emas[15][i]
        ma30, ma60 = slow_emas[30][i], slow_emas[60][i]

        fast_width = (fast_max - fast_min) if ma3  >= ma15 else (fast_min - fast_max)
        slow_width = (slow_max - slow_min) if ma30 >= ma60 else (slow_min - slow_max)

        slope_up   = prev_slow_width is not None and slow_width > prev_slow_width

        # rwb: gap between groups (0 when overlapping)
        if   fast_min > slow_max:  rwb = fast_min - slow_max
        elif slow_min > fast_max:  rwb = fast_max - slow_min
        else:                      rwb = 0.0

        t = times[i]
        fast_width_out.append({"time": t, "value": round(float(fast_width), 4)})
        slow_width_out.append({
            "time":  t,
            "value": round(float(slow_width), 4),
            "color": "#26a69a" if slope_up else "#ef5350",
        })
        rwb_out.append({"time": t, "value": round(float(rwb), 4)})

        prev_slow_width = slow_width

    return {
        "fast_width": fast_width_out,
        "slow_width": slow_width_out,
        "rwb":        rwb_out,
    }


# ── Beardy Squeeze Pro ────────────────────────────────────────────────────────

def calc_squeeze(
    closes: np.ndarray,
    highs:  np.ndarray,
    lows:   np.ndarray,
    times:  list,
    length:       int   = 20,
    bb_mult:      float = 2.0,
    kc_mult_high: float = 1.0,
    kc_mult_mid:  float = 1.5,
    kc_mult_low:  float = 2.0,
) -> dict:
    """Beardy Squeeze Pro.

    Returns a dict with two keys:
    - ``mom`` – momentum histogram: list of ``{time, value, color}``
    - ``sqz`` – squeeze-state line at y=0: list of ``{time, value, color}``

    Momentum colors (bars):
      aqua  (#00bcd4) – positive & rising
      blue  (#2962ff) – positive & falling
      red   (#ef5350) – negative & falling
      yellow(#ffeb3b) – negative & rising

    Squeeze dot colors:
      orange (#ff9800) – BB inside tight KC (KC×1.0)
      red    (#ef5350) – BB inside mid   KC (KC×1.5)
      gray   (#434651) – BB inside wide  KC (KC×2.0)
      green  (#26a69a) – BB outside all  KC (no squeeze)
    """
    # ── Bollinger Bands ────────────────────────────────────────────────────────
    bb_basis = talib.SMA(closes,  timeperiod=length)
    bb_std   = talib.STDDEV(closes, timeperiod=length, nbdev=1)
    bb_upper = bb_basis + bb_mult * bb_std
    bb_lower = bb_basis - bb_mult * bb_std

    # ── Keltner Channels (SMA of true range, three multipliers) ───────────────
    true_range = talib.TRANGE(highs, lows, closes)   # NaN at index 0
    dev_kc     = talib.SMA(true_range, timeperiod=length)
    kc_upper_high = bb_basis + dev_kc * kc_mult_high
    kc_lower_high = bb_basis - dev_kc * kc_mult_high
    kc_upper_mid  = bb_basis + dev_kc * kc_mult_mid
    kc_lower_mid  = bb_basis - dev_kc * kc_mult_mid
    kc_upper_low  = bb_basis + dev_kc * kc_mult_low
    kc_lower_low  = bb_basis - dev_kc * kc_mult_low

    # ── Momentum oscillator ───────────────────────────────────────────────────
    # midpoint = avg(avg(highest(high, n), lowest(low, n)), sma(close, n))
    highest_high = talib.MAX(highs, timeperiod=length)
    lowest_low   = talib.MIN(lows,  timeperiod=length)
    midpoint     = ((highest_high + lowest_low) / 2 + bb_basis) / 2
    mom_vals     = talib.LINEARREG(closes - midpoint, timeperiod=length)

    mom_out: list = []
    sqz_out: list = []
    prev_mom: float | None = None

    for i in range(len(closes)):
        if (np.isnan(bb_upper[i]) or np.isnan(bb_lower[i]) or
                np.isnan(kc_upper_low[i]) or np.isnan(mom_vals[i])):
            prev_mom = None
            continue

        m    = float(mom_vals[i])
        bbu  = float(bb_upper[i])
        bbl  = float(bb_lower[i])
        prev = 0.0 if prev_mom is None else prev_mom

        # Momentum color
        if m > 0:
            mom_color = '#00bcd4' if m > prev else '#2962ff'
        else:
            mom_color = '#ef5350' if m < prev else '#ffeb3b'

        # Squeeze state (priority: high > mid > low > none)
        if (bbl >= float(kc_lower_high[i])) or (bbu <= float(kc_upper_high[i])):
            sqz_color = '#ff9800'   # orange – highest compression
        elif (bbl >= float(kc_lower_mid[i])) or (bbu <= float(kc_upper_mid[i])):
            sqz_color = '#ef5350'   # red – mid compression
        elif (bbl >= float(kc_lower_low[i])) or (bbu <= float(kc_upper_low[i])):
            sqz_color = '#434651'   # dark gray – low compression
        else:
            sqz_color = '#26a69a'   # green – no squeeze

        t = times[i]
        mom_out.append({"time": t, "value": round(m, 6), "color": mom_color})
        sqz_out.append({"time": t, "value": 0.0,         "color": sqz_color})
        prev_mom = m

    return {"mom": mom_out, "sqz": sqz_out}
