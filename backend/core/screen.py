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
from concurrent.futures import ThreadPoolExecutor, as_completed
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
    "rwb_slow_width_consecutive_positive_bars": {
        "description": "RWB slow_width consecutive positive bars — consecutive bars slow_width has been positive",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
    "rwb_fast_width_consecutive_positive_bars": {
        "description": "RWB fast_width consecutive positive bars — consecutive bars fast_width has been positive",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
    "rwb_slow_width_consecutive_rising_bars": {
        "description": "RWB slow_width consecutive rising bars — consecutive bars slow_width has been rising",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
    },
    "rwb_fast_width_consecutive_rising_bars": {
        "description": "RWB fast_width consecutive rising bars — consecutive bars fast_width has been rising",
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
    "macd_histogram_consecutive_positive_bars": {
        "description": "MACD histogram consecutive positive bars — number of bars since histogram last turned positive",
        # Default fn is a placeholder; screen_individual() replaces it based on user config.
        "fn": lambda m, r, s: True,
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
    condition_overrides: dict | None = None,
) -> ScreenResult:
    """
    Screen a single stock symbol against momentum/trend conditions.

    Parameters
    ----------
    symbol:
        Ticker symbol (e.g. ``"AAPL"``).  Case-insensitive.
    condition_overrides:
        Per-condition settings dict, keyed by condition name.  Each value is a
        dict that may contain any of:
          ``"verdict_role"``  – ``True`` (required) / ``False`` (must-fail) /
                                ``None`` (informational).  Overrides the
                                backend default in ``_VERDICT_RULES``.
          ``"threshold"``     – int threshold for parametric conditions.
          ``"op"``            – ``"gt"`` | ``"eq"`` | ``"lt"`` for parametric
                                conditions.
        Conditions absent from ``condition_overrides`` use backend defaults.

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
    sym       = symbol.upper().strip()
    overrides = condition_overrides or {}
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

    # ── Effective verdict rules: backend defaults overridden by config ────
    effective_verdict_rules: dict[str, bool] = {}
    for name, required in _VERDICT_RULES.items():
        ov = overrides.get(name, {})
        effective_verdict_rules[name] = ov.get("verdict_role", required)
    # Also pick up any conditions that are in overrides but NOT in _VERDICT_RULES
    for name, ov in overrides.items():
        if name not in effective_verdict_rules and "verdict_role" in ov and ov["verdict_role"] is not None:
            effective_verdict_rules[name] = ov["verdict_role"]

    # ── Build dynamic parametric condition descriptions and fns ──────────
    _op_symbol = {"gt": ">", "eq": "=", "lt": "<"}
    _op_label  = {"gt": "greater than", "eq": "equal to", "lt": "less than"}

    _PARAMETRIC = {
        "sqz_consecutive_positive_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "SQZ consecutive positive bars {sym} {thr} — bars since momentum last turned positive is {lbl} {thr}",
            "value_fn": lambda m, r, s: s.consecutive_positive_bars,
        },
        "macd_histogram_consecutive_positive_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "MACD histogram consecutive positive bars {sym} {thr} — bars since histogram last turned positive is {lbl} {thr}",
            "value_fn": lambda m, r, s: m.consecutive_positive_bars,
        },
        "rwb_bars_since_fast_above_slow": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "RWB bars since fast width crossed above slow width {sym} {thr} — consecutive bars fast_width above slow_width is {lbl} {thr}",
            "value_fn": lambda m, r, s: r.bars_since_fast_above_slow,
        },
        "rwb_slow_width_consecutive_positive_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "RWB slow_width consecutive positive bars {sym} {thr} — consecutive bars slow_width has been positive is {lbl} {thr}",
            "value_fn": lambda m, r, s: r.slow_width_consecutive_positive_bars,
        },
        "rwb_fast_width_consecutive_positive_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "RWB fast_width consecutive positive bars {sym} {thr} — consecutive bars fast_width has been positive is {lbl} {thr}",
            "value_fn": lambda m, r, s: r.fast_width_consecutive_positive_bars,
        },
        "rwb_slow_width_consecutive_rising_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "RWB slow_width consecutive rising bars {sym} {thr} — consecutive bars slow_width has been rising is {lbl} {thr}",
            "value_fn": lambda m, r, s: r.slow_width_consecutive_rising_bars,
        },
        "rwb_fast_width_consecutive_rising_bars": {
            "default_threshold": 3, "default_op": "gt",
            "description_tmpl": "RWB fast_width consecutive rising bars {sym} {thr} — consecutive bars fast_width has been rising is {lbl} {thr}",
            "value_fn": lambda m, r, s: r.fast_width_consecutive_rising_bars,
        },
    }

    for cname, meta in _PARAMETRIC.items():
        ov        = overrides.get(cname, {})
        threshold = int(ov.get("threshold", meta["default_threshold"]))
        op        = ov.get("op", meta["default_op"])
        op_sym    = _op_symbol.get(op, ">")
        op_lbl    = _op_label.get(op, "greater than")
        _CONDITIONS[cname]["description"] = meta["description_tmpl"].format(
            sym=op_sym, thr=threshold, lbl=op_lbl,
        )
        value_fn = meta["value_fn"]
        def _make_fn(vfn, t, o):
            def _fn(m, r, s):
                n = vfn(m, r, s)
                if o == "gt": return n > t
                if o == "eq": return n == t
                if o == "lt": return n < t
                return False
            return _fn
        _CONDITIONS[cname]["fn"] = _make_fn(value_fn, threshold, op)

    # ── Evaluate every condition ──────────────────────────────────────────
    conditions: list[ConditionResult] = []
    for name, spec in _CONDITIONS.items():
        passed = bool(spec["fn"](macd_result, rwb_result, sqz_result))
        conditions.append(ConditionResult(
            name=name,
            description=spec["description"],
            passed=passed,
            verdict_role=effective_verdict_rules.get(name),  # None if not required
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


# ---------------------------------------------------------------------------
# Batch screener
# ---------------------------------------------------------------------------

@dataclass
class ScreenBatchResult:
    """Summary of a multi-symbol screening run."""
    passed:  list[str]                     # symbols whose verdict is True, original order
    failed:  list[str]                     # symbols whose verdict is False, original order
    errored: dict[str, str]                # symbol → error message (no price data, etc.)
    results: dict[str, ScreenResult]       # symbol → full ScreenResult (only for screened symbols)


def screen_symbols(
    symbols: list[str],
    condition_overrides: dict | None = None,
    max_workers: int = 1,
) -> list[str]:
    """
    Screen a list of symbols and return those that pass the analysis.

    Each symbol is screened by :func:`screen_individual`.  All symbols are
    processed concurrently (``max_workers`` threads) because the yfinance
    fetch is I/O-bound.  Symbols that raise an error (no price data, network
    timeout, etc.) are skipped and logged as warnings — they are **not**
    included in the returned list.

    Parameters
    ----------
    symbols:
        Ticker symbols to screen.  Case-insensitive.
    condition_overrides:
        Passed unchanged to :func:`screen_individual` for every symbol.
        Use this to supply the conditions dict from a :class:`ScreenConfig`.
    max_workers:
        Maximum number of concurrent threads.  Tune downward if yfinance
        rate-limits you on very large lists.

    Returns
    -------
    list[str]
        Upper-cased symbols that passed all required verdict conditions,
        in the same relative order they appeared in ``symbols``.

    Example
    -------
    >>> passing = screen_symbols(["AAPL", "MSFT", "TSLA"], condition_overrides=cfg.conditions)
    >>> print(passing)
    ['AAPL', 'MSFT']
    """
    batch = screen_symbols_detailed(symbols, condition_overrides, max_workers)
    return batch.passed


def screen_symbols_detailed(
    symbols: list[str],
    condition_overrides: dict | None = None,
    max_workers: int = 1,
) -> ScreenBatchResult:
    """
    Screen a list of symbols and return a full :class:`ScreenBatchResult`.

    Identical to :func:`screen_symbols` but exposes the per-symbol
    :class:`ScreenResult` objects, the list of symbols that failed the
    verdict, and any symbols that could not be screened due to errors.

    Parameters
    ----------
    symbols:
        Ticker symbols to screen.  Case-insensitive.
    condition_overrides:
        Passed unchanged to :func:`screen_individual` for every symbol.
    max_workers:
        Maximum number of concurrent threads.

    Returns
    -------
    ScreenBatchResult
        ``.passed``  – symbols whose verdict is ``True`` (original order)
        ``.failed``  – symbols whose verdict is ``False`` (original order)
        ``.errored`` – symbol → error message for symbols that raised
        ``.results`` – symbol → :class:`ScreenResult` for all screened symbols
    """
    deduped  = list(dict.fromkeys(s.upper().strip() for s in symbols))
    total    = len(deduped)
    logger.info("Batch screening %d symbol(s) with %d workers …", total, max_workers)

    results_map: dict[str, ScreenResult] = {}
    errors_map:  dict[str, str]          = {}

    def _screen_one(sym: str):
        try:
            return sym, screen_individual(sym, condition_overrides), None
        except Exception as exc:       # noqa: BLE001
            return sym, None, str(exc)

    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = {pool.submit(_screen_one, sym): sym for sym in deduped}
        for future in as_completed(futures):
            sym, result, err = future.result()
            if err is not None:
                logger.warning("%-6s  ERROR  %s", sym, err)
                errors_map[sym] = err
            else:
                results_map[sym] = result

    # Reconstruct in original order
    passed  = [s for s in deduped if s in results_map and results_map[s].verdict]
    failed  = [s for s in deduped if s in results_map and not results_map[s].verdict]

    logger.info(
        "Batch complete — %d passed / %d failed / %d errored (total %d)",
        len(passed), len(failed), len(errors_map), total,
    )
    return ScreenBatchResult(
        passed=passed,
        failed=failed,
        errored=errors_map,
        results=results_map,
    )
