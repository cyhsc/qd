# --------------------------------------------------------------------------------
# Copyright (C) [2025] [Bumblebee Networks Inc.]
# All rights reserved. Unauthorized use is prohibited.
# --------------------------------------------------------------------------------
"""
Individual stock screener.

Fetches 3 years of daily OHLC data from Yahoo Finance and evaluates a set of
trend/momentum conditions using MACD, RWB, and SQZ analysis.
"""
import logging
from dataclasses import dataclass, field
from typing import Callable

import numpy as np
import yfinance as yf

from core.analysis import (
    MACDAnalysis, RWBAnalysis, SQZAnalysis,
    Sign, Slope, SqueezeState,
    analyze_macd, analyze_rwb, analyze_sqz,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Screening conditions
#
# Dict keyed by a short machine-readable name.
# Each value is a dict with:
#   "description" – human-readable explanation
#   "fn"          – predicate(macd, rwb, sqz) -> bool
# ---------------------------------------------------------------------------

_CONDITIONS: dict[str, dict] = {
    # ── RWB ──────────────────────────────────────────────────────────────────
    "rwb_gap_positive": {
        "description": "RWB gap positive — fast EMA cluster is above slow cluster (bullish alignment)",
        "fn": lambda m, r, s: r.rwb.sign == Sign.POSITIVE,
    },
    "rwb_gap_rising": {
        "description": "RWB gap rising — bullish separation is widening (momentum building)",
        "fn": lambda m, r, s: r.rwb.slope == Slope.RISING,
    },
    "rwb_slow_width_rising": {
        "description": "RWB slow_width rising — long-term EMA cluster is fanning out (trend strengthening)",
        "fn": lambda m, r, s: r.slow_width.slope == Slope.RISING,
    },
    "rwb_fast_above_slow": {
        "description": "RWB fast_width > slow_width — short-term cluster more dynamic than long-term",
        "fn": lambda m, r, s: r.fast_width_above_slow_width,
    },
    "rwb_bars_since_fast_above_slow": {
        "description": "RWB bars since fast width crossed above slow width — consecutive bars fast_width has been above slow_width",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
    # ── MACD ─────────────────────────────────────────────────────────────────
    "macd_line_positive": {
        "description": "MACD line positive — fast EMA is above slow EMA",
        "fn": lambda m, r, s: m.macd.sign == Sign.POSITIVE,
    },
    "macd_line_rising": {
        "description": "MACD line rising — bullish divergence growing",
        "fn": lambda m, r, s: m.macd.slope == Slope.RISING,
    },
    "macd_histogram_positive": {
        "description": "MACD histogram positive — net momentum is bullish",
        "fn": lambda m, r, s: m.histogram.sign == Sign.POSITIVE,
    },
    "macd_histogram_rising": {
        "description": "MACD histogram rising — momentum is accelerating upward",
        "fn": lambda m, r, s: m.histogram.slope == Slope.RISING,
    },
    "macd_signal_positive": {
        "description": "MACD signal line positive — smoothed trend is bullish",
        "fn": lambda m, r, s: m.signal.sign == Sign.POSITIVE,
    },
    # ── SQZ ──────────────────────────────────────────────────────────────────
    "sqz_momentum_positive": {
        "description": "SQZ momentum positive — squeeze momentum is in bullish territory",
        "fn": lambda m, r, s: s.momentum.sign == Sign.POSITIVE,
    },
    "sqz_momentum_rising": {
        "description": "SQZ momentum rising — squeeze momentum is accelerating",
        "fn": lambda m, r, s: s.momentum.slope == Slope.RISING,
    },
    "sqz_not_on": {
        "description": "SQZ not ON — squeeze has fired or is not active (energy releasing or neutral)",
        "fn": lambda m, r, s: s.squeeze_state != SqueezeState.ON,
    },
    "sqz_consecutive_positive_bars": {
        "description": "SQZ consecutive positive bars — number of bars since momentum last turned positive",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
    "macd_histogram_consecutive_positive_bars": {
        "description": "MACD histogram consecutive positive bars — number of bars since histogram last turned positive",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
}

# ---------------------------------------------------------------------------
# Verdict rules
#
# Maps condition name -> required bool value.
# Verdict is True only when every listed condition matches its required value.
# Conditions not listed here are informational only (shown in report but
# do not affect the verdict).
# ---------------------------------------------------------------------------

_VERDICT_RULES: dict[str, bool] = {
    "rwb_gap_positive":       True,
    "rwb_gap_rising":         True,
    "macd_line_positive":     True,
    "macd_histogram_positive": True,
    "sqz_momentum_positive":  True,
    "sqz_not_on":             True,
}


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class ConditionResult:
    name:        str
    description: str
    passed:      bool
    verdict_role: bool | None  # True = must pass, False = must fail, None = informational


@dataclass
class ScreenResult:
    symbol:     str
    verdict:    bool
    score:      int           # conditions that passed
    total:      int           # total conditions
    conditions: list[ConditionResult]
    macd:       MACDAnalysis
    rwb:        RWBAnalysis
    sqz:        SQZAnalysis
    report:     str = field(default="", repr=False)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fmt_line(la) -> str:
    return f"{la.sign.value.upper():8s} | {la.slope.value.upper():7s} | value={la.value:+.4f}  prev={la.prev_value:+.4f}"


def _build_report(result: ScreenResult) -> str:
    verdict_str = "PASS ✓" if result.verdict else "FAIL ✗"
    failing = [c for c in result.conditions if c.verdict_role is not None and c.passed != c.verdict_role]
    lines = [
        f"{'=' * 55}",
        f"  SCREEN REPORT  —  {result.symbol}",
        f"{'=' * 55}",
        f"  Verdict : {verdict_str}",
        f"  Score   : {result.score} / {result.total} conditions passed",
        f"  Rules   : {len(_VERDICT_RULES)} required conditions",
    ]
    if failing:
        lines.append(f"  Failing : {', '.join(c.name for c in failing)}")
    lines += [
        "",
        f"── MACD (12,26,9) {'─' * 38}",
        f"  Line      :  {_fmt_line(result.macd.macd)}",
        f"  Signal    :  {_fmt_line(result.macd.signal)}",
        f"  Histogram :  {_fmt_line(result.macd.histogram)}",
        "",
        f"── RWB (fast 3-15 / slow 30-60) {'─' * 24}",
        f"  RWB gap    :  {_fmt_line(result.rwb.rwb)}",
        f"  Fast width :  {_fmt_line(result.rwb.fast_width)}",
        f"  Slow width :  {_fmt_line(result.rwb.slow_width)}",
        f"  Fast > Slow:  {result.rwb.fast_width_above_slow_width}",
        "",
        f"── SQZ (Squeeze Momentum) {'─' * 30}",
        f"  Momentum   :  {_fmt_line(result.sqz.momentum)}",
        f"  Sqz state  :  {result.sqz.squeeze_state.value.upper()}",
        "",
        f"── Conditions {'─' * 42}",
    ]
    for c in result.conditions:
        mark   = "✓" if c.passed else "✗"
        role   = " [required]" if c.verdict_role is True else " [must-fail]" if c.verdict_role is False else ""
        lines.append(f"  {mark}  {c.name}{role}")
        lines.append(f"       {c.description}")
    lines.append(f"{'─' * 55}")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def screen_individual(
    symbol: str,
    sqz_pos_bars_threshold: int = 3,
    sqz_pos_bars_op: str = "gt",         # "gt" | "eq" | "lt"
    macd_hist_pos_bars_threshold: int = 3,
    macd_hist_pos_bars_op: str = "gt",   # "gt" | "eq" | "lt"
    rwb_fast_above_slow_bars_threshold: int = 3,
    rwb_fast_above_slow_bars_op: str = "gt",  # "gt" | "eq" | "lt"
) -> ScreenResult:
    """
    Screen a single stock symbol against momentum/trend conditions.

    Verdict is True only when every condition listed in ``_VERDICT_RULES``
    matches its required value (True = must pass, False = must fail).

    Parameters
    ----------
    symbol:
        Ticker symbol (e.g. ``"AAPL"``).  Case-insensitive.

    Returns
    -------
    ScreenResult
        Per-condition breakdown, overall verdict, analysis objects, and a
        human-readable ``.report`` string.

    Raises
    ------
    ValueError
        If Yahoo Finance returns no price data for the symbol.
    """
    sym = symbol.upper().strip()
    logger.info("Screening %s …", sym)

    # ── Fetch 3 years of daily OHLC from Yahoo Finance ────────────────────
    hist = yf.Ticker(sym).history(period="3y", interval="1d", auto_adjust=False)
    if hist.empty:
        raise ValueError(f"No price data found for '{sym}'")

    closes = np.asarray(hist["Close"].values, dtype=float)
    highs  = np.asarray(hist["High"].values,  dtype=float)
    lows   = np.asarray(hist["Low"].values,   dtype=float)

    # ── Run indicator analysis ────────────────────────────────────────────
    macd_result = analyze_macd(closes)
    rwb_result  = analyze_rwb(closes)
    sqz_result  = analyze_sqz(closes, highs, lows)

    # ── Build dynamic condition descriptions ─────────────────────────────
    _op_symbol = {"gt": ">", "eq": "=", "lt": "<"}
    _op_label  = {"gt": "greater than", "eq": "equal to", "lt": "less than"}

    op_sym = _op_symbol.get(sqz_pos_bars_op, ">")
    op_lbl = _op_label.get(sqz_pos_bars_op, "greater than")
    _CONDITIONS["sqz_consecutive_positive_bars"]["description"] = (
        f"SQZ consecutive positive bars {op_sym} {sqz_pos_bars_threshold} — "
        f"bars since momentum last turned positive is {op_lbl} {sqz_pos_bars_threshold}"
    )

    def _sqz_pos_bars_fn(m, r, s):
        n = s.consecutive_positive_bars
        if sqz_pos_bars_op == "gt": return n > sqz_pos_bars_threshold
        if sqz_pos_bars_op == "eq": return n == sqz_pos_bars_threshold
        if sqz_pos_bars_op == "lt": return n < sqz_pos_bars_threshold
        return False
    _CONDITIONS["sqz_consecutive_positive_bars"]["fn"] = _sqz_pos_bars_fn

    mh_op_sym = _op_symbol.get(macd_hist_pos_bars_op, ">")
    mh_op_lbl = _op_label.get(macd_hist_pos_bars_op, "greater than")
    _CONDITIONS["macd_histogram_consecutive_positive_bars"]["description"] = (
        f"MACD histogram consecutive positive bars {mh_op_sym} {macd_hist_pos_bars_threshold} — "
        f"bars since histogram last turned positive is {mh_op_lbl} {macd_hist_pos_bars_threshold}"
    )

    def _macd_hist_pos_bars_fn(m, r, s):
        n = m.consecutive_positive_bars
        if macd_hist_pos_bars_op == "gt": return n > macd_hist_pos_bars_threshold
        if macd_hist_pos_bars_op == "eq": return n == macd_hist_pos_bars_threshold
        if macd_hist_pos_bars_op == "lt": return n < macd_hist_pos_bars_threshold
        return False
    _CONDITIONS["macd_histogram_consecutive_positive_bars"]["fn"] = _macd_hist_pos_bars_fn

    rwb_op_sym = _op_symbol.get(rwb_fast_above_slow_bars_op, ">")
    rwb_op_lbl = _op_label.get(rwb_fast_above_slow_bars_op, "greater than")
    _CONDITIONS["rwb_bars_since_fast_above_slow"]["description"] = (
        f"RWB bars since fast width crossed above slow width {rwb_op_sym} {rwb_fast_above_slow_bars_threshold} — "
        f"consecutive bars fast_width above slow_width is {rwb_op_lbl} {rwb_fast_above_slow_bars_threshold}"
    )

    def _rwb_fast_above_slow_bars_fn(m, r, s):
        n = r.bars_since_fast_above_slow
        if rwb_fast_above_slow_bars_op == "gt": return n > rwb_fast_above_slow_bars_threshold
        if rwb_fast_above_slow_bars_op == "eq": return n == rwb_fast_above_slow_bars_threshold
        if rwb_fast_above_slow_bars_op == "lt": return n < rwb_fast_above_slow_bars_threshold
        return False
    _CONDITIONS["rwb_bars_since_fast_above_slow"]["fn"] = _rwb_fast_above_slow_bars_fn

    # ── Evaluate every condition ──────────────────────────────────────────
    conditions: list[ConditionResult] = []
    for name, spec in _CONDITIONS.items():
        passed = bool(spec["fn"](macd_result, rwb_result, sqz_result))
        conditions.append(ConditionResult(
            name=name,
            description=spec["description"],
            passed=passed,
            verdict_role=_VERDICT_RULES.get(name),   # None if not in rules
        ))

    score = sum(c.passed for c in conditions)

    # Verdict: every rule condition must match its required value
    verdict = all(
        c.passed == c.verdict_role
        for c in conditions
        if c.verdict_role is not None
    )

    result = ScreenResult(
        symbol=sym,
        verdict=verdict,
        score=score,
        total=len(conditions),
        conditions=conditions,
        macd=macd_result,
        rwb=rwb_result,
        sqz=sqz_result,
    )
    result.report = _build_report(result)

    failing = [c.name for c in conditions if c.verdict_role is not None and c.passed != c.verdict_role]
    logger.info("%-6s  %s  score=%d/%d  failing=%s",
                sym, "PASS" if verdict else "FAIL", score, len(conditions), failing or "none")
    return result
