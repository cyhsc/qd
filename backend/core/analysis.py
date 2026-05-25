# --------------------------------------------------------------------------------
# Copyright (C) [2025] [Bumblebee Networks Inc.]
# All rights reserved. Unauthorized use is prohibited.
# --------------------------------------------------------------------------------
import logging
from dataclasses import dataclass
from enum import Enum
from typing import Sequence

import numpy as np

from core.technicals import calc_macd as _calc_macd, calc_rwb as _calc_rwb, calc_squeeze as _calc_squeeze

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Slope(str, Enum):
    RISING  = "rising"
    FALLING = "falling"
    FLAT    = "flat"


class Sign(str, Enum):
    POSITIVE = "positive"
    NEGATIVE = "negative"
    ZERO     = "zero"


class SqueezeState(str, Enum):
    ON   = "on"
    OFF  = "off"
    NONE = "none"


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------

@dataclass
class LineAnalysis:
    """Sign + slope analysis for a single indicator series."""
    sign:       Sign
    slope:      Slope
    value:      float
    prev_value: float


@dataclass
class MACDAnalysis:
    """Full MACD analysis result."""
    macd:                      LineAnalysis
    signal:                    LineAnalysis
    histogram:                 LineAnalysis
    consecutive_positive_bars: int   # bars since histogram last turned positive (0 if currently non-positive)


@dataclass
class RWBAnalysis:
    """Full RWB (Red-White-Blue) analysis result."""
    fast_width:                  LineAnalysis
    slow_width:                  LineAnalysis
    rwb:                         LineAnalysis
    fast_width_above_slow_width: bool
    bars_since_fast_above_slow:  int   # consecutive bars fast_width has been above slow_width (0 if currently not above)


@dataclass
class SQZAnalysis:
    """Full SQZ (Squeeze Momentum) analysis result."""
    momentum:                  LineAnalysis
    squeeze_state:             SqueezeState
    consecutive_positive_bars: int   # bars since momentum last turned positive (0 if currently non-positive)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sign(value: float, zero_threshold: float = 1e-10) -> Sign:
    if abs(value) <= zero_threshold:
        return Sign.ZERO
    return Sign.POSITIVE if value > 0 else Sign.NEGATIVE


def _slope(current: float, previous: float, flat_threshold: float = 1e-10) -> Slope:
    delta = current - previous
    if abs(delta) <= flat_threshold:
        return Slope.FLAT
    return Slope.RISING if delta > 0 else Slope.FALLING


def _analyze_series(series: list, flat_threshold: float = 1e-10) -> LineAnalysis:
    """Build a LineAnalysis from the last two points of a [{time, value}] series."""
    if len(series) < 2:
        raise ValueError("Need at least 2 data points to determine slope.")
    current  = float(series[-1]["value"])
    previous = float(series[-2]["value"])
    return LineAnalysis(
        sign=_sign(current),
        slope=_slope(current, previous, flat_threshold),
        value=current,
        prev_value=previous,
    )


# Maps the squeeze dot color produced by calc_squeeze back to a SqueezeState.
# orange / red  → ON  (BB inside KC at the high / mid multiplier levels)
# dark gray     → NONE (BB inside only the wide KC; partial squeeze)
# green         → OFF  (BB outside all KC; squeeze fired)
_SQZ_COLOR_TO_STATE: dict[str, SqueezeState] = {
    '#ff9800': SqueezeState.ON,
    '#ef5350': SqueezeState.ON,
    '#434651': SqueezeState.NONE,
    '#26a69a': SqueezeState.OFF,
}


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def analyze_macd(
    prices: Sequence[float],
    fast_period:    int   = 12,
    slow_period:    int   = 26,
    signal_period:  int   = 9,
    flat_threshold: float = 1e-10,
) -> MACDAnalysis:
    """
    Analyse a MACD indicator.

    Returns sign + slope for the MACD line, signal line, and histogram.
    """
    arr   = np.asarray(prices, dtype=float)
    times = list(range(len(arr)))
    data  = _calc_macd(arr, fast_period, slow_period, signal_period, times)

    # Count consecutive positive histogram bars from the most recent bar backwards.
    hist_values = [pt["value"] for pt in data["histogram"]]
    consecutive_positive = 0
    if hist_values and float(hist_values[-1]) > 0:
        for v in reversed(hist_values):
            if float(v) > 0:
                consecutive_positive += 1
            else:
                break

    return MACDAnalysis(
        macd=_analyze_series(data["macd_line"],   flat_threshold),
        signal=_analyze_series(data["signal_line"], flat_threshold),
        histogram=_analyze_series(data["histogram"],  flat_threshold),
        consecutive_positive_bars=consecutive_positive,
    )


def analyze_rwb(
    prices: Sequence[float],
    flat_threshold: float = 1e-10,
) -> RWBAnalysis:
    """
    Analyse an RWB (Red-White-Blue) indicator.

    Returns sign + slope for fast_width, slow_width, and the rwb gap.
    Uses the standard RWB periods (fast 3-5-7-10-12-15, slow 30-35-40-45-50-60).
    """
    arr   = np.asarray(prices, dtype=float)
    times = list(range(len(arr)))
    data  = _calc_rwb(arr, times)

    fast_analysis = _analyze_series(data["fast_width"], flat_threshold)
    slow_analysis = _analyze_series(data["slow_width"], flat_threshold)

    # Count consecutive bars where fast_width > slow_width, walking backwards.
    fast_vals = [float(pt["value"]) for pt in data["fast_width"]]
    slow_vals = [float(pt["value"]) for pt in data["slow_width"]]
    bars_since_cross = 0
    if fast_vals and slow_vals and fast_vals[-1] > slow_vals[-1]:
        for f, s in zip(reversed(fast_vals), reversed(slow_vals)):
            if f > s:
                bars_since_cross += 1
            else:
                break

    return RWBAnalysis(
        fast_width=fast_analysis,
        slow_width=slow_analysis,
        rwb=_analyze_series(data["rwb"], flat_threshold),
        fast_width_above_slow_width=fast_analysis.value > slow_analysis.value,
        bars_since_fast_above_slow=bars_since_cross,
    )


def analyze_sqz(
    closes: Sequence[float],
    highs:  Sequence[float],
    lows:   Sequence[float],
    flat_threshold: float = 1e-10,
) -> SQZAnalysis:
    """
    Analyse a SQZ (Squeeze Momentum) indicator.

    Returns sign + slope for the momentum histogram and the current squeeze state.
    """
    c     = np.asarray(closes, dtype=float)
    h     = np.asarray(highs,  dtype=float)
    l     = np.asarray(lows,   dtype=float)
    times = list(range(len(c)))
    data  = _calc_squeeze(c, h, l, times)

    last_sqz_color = data["sqz"][-1]["color"] if data["sqz"] else '#26a69a'
    state = _SQZ_COLOR_TO_STATE.get(last_sqz_color, SqueezeState.NONE)

    # Count consecutive positive momentum bars from the most recent bar backwards.
    # Returns 0 if the current bar is not positive.
    mom_values = [pt["value"] for pt in data["mom"]]
    consecutive_positive = 0
    if mom_values and float(mom_values[-1]) > 0:
        for v in reversed(mom_values):
            if float(v) > 0:
                consecutive_positive += 1
            else:
                break

    return SQZAnalysis(
        momentum=_analyze_series(data["mom"], flat_threshold),
        squeeze_state=state,
        consecutive_positive_bars=consecutive_positive,
    )
