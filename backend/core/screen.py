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
from types import SimpleNamespace
from typing import Callable

import numpy as np

from core.analysis import (
    LineAnalysis, MACDAnalysis, RWBAnalysis, SQZAnalysis,
    Sign, Slope, SqueezeState,
    analyze_macd, analyze_rwb, analyze_sqz,
    _sign, _slope, _SQZ_COLOR_TO_STATE,
)
from core.prices import get_daily_ohlc
from core.technicals import (
    calc_macd as _calc_macd,
    calc_rwb as _calc_rwb,
    calc_squeeze as _calc_squeeze,
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
    "rwb_fast_width_rising": {
        "description": "RWB fast_width rising — short-term EMA cluster is fanning out (momentum building)",
        "fn": lambda m, r, s: r.fast_width.slope == Slope.RISING,
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
# Logic evaluation
# ---------------------------------------------------------------------------

def _group_quorum(values: list[bool], op: str, min_match: int | None) -> bool:
    """
    Whether a group of condition results passes.

      "AND" — every condition passes
      "OR"  — at least one passes
      "NOF" — at least ``min_match`` pass (partial / "N of M" matching);
              min_match is clamped to [1, len(values)]
    """
    if not values:
        return True
    if op == "OR":
        return any(values)
    if op == "NOF":
        need = min(max(int(min_match or 1), 1), len(values))
        return sum(1 for v in values if v) >= need
    return all(values)  # AND (default)


def _evaluate_logic(cond_results: list[ConditionResult], logic: dict | None) -> bool:
    """
    Evaluate verdict using optional AND/OR/N-of group logic.

    If logic is None or has no groups, falls back to: AND all conditions
    whose verdict_role is not None.

    logic shape:
      {
        "operator": "AND" | "OR",   // how to combine groups (default AND)
        "groups": [
          {
            "operator":  "AND" | "OR" | "NOF",   // NOF = at least min_match
            "min_match": 2,                       // only used when NOF
            "conditions": ["cond_name", ...],
          },
          ...
        ]
      }
    """
    if not logic or not logic.get("groups"):
        return all(
            c.passed == c.verdict_role
            for c in cond_results
            if c.verdict_role is not None
        )

    result_map = {c.name: c.passed for c in cond_results}
    groups     = logic.get("groups", [])
    top_op     = logic.get("operator", "AND").upper()

    group_verdicts = []
    for group in groups:
        names    = group.get("conditions", [])
        group_op = group.get("operator", "AND").upper()
        if not names:
            continue
        values = [result_map.get(n, False) for n in names]
        group_verdicts.append(_group_quorum(values, group_op, group.get("min_match")))

    if not group_verdicts:
        return True
    return all(group_verdicts) if top_op == "AND" else any(group_verdicts)


# ---------------------------------------------------------------------------
# Parametric condition setup (shared by screen_individual and screen_history)
# ---------------------------------------------------------------------------

_OP_SYMBOL = {"gt": ">", "eq": "=", "lt": "1≤n<"}
_OP_LABEL  = {"gt": "greater than", "eq": "equal to", "lt": "at least 1 but less than"}

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


def _apply_condition_overrides(overrides: dict) -> None:
    """Rebuild parametric condition descriptions and fns from user settings."""
    for cname, meta in _PARAMETRIC.items():
        ov        = overrides.get(cname, {})
        threshold = int(ov.get("threshold", meta["default_threshold"]))
        op        = ov.get("op", meta["default_op"])
        op_sym    = _OP_SYMBOL.get(op, ">")
        op_lbl    = _OP_LABEL.get(op, "greater than")
        _CONDITIONS[cname]["description"] = meta["description_tmpl"].format(
            sym=op_sym, thr=threshold, lbl=op_lbl,
        )
        value_fn = meta["value_fn"]
        def _make_fn(vfn, t, o):
            def _fn(m, r, s):
                n = vfn(m, r, s)
                if o == "gt": return n > t
                if o == "eq": return n == t
                # "lt" requires an active streak: a count of 0 means the
                # condition isn't currently true at all (e.g. fast_width is
                # negative), which should NOT pass "fewer than t bars".
                if o == "lt": return 0 < n < t
                return False
            return _fn
        _CONDITIONS[cname]["fn"] = _make_fn(value_fn, threshold, op)


def _effective_verdict_rules(overrides: dict) -> dict[str, bool]:
    """
    Verdict rules for a screen run.

    If the config explicitly sets verdict_role on any condition, those are the
    ONLY rules — matching the frontend, whose derived logic is the AND of the
    config's own required conditions.  Backend defaults (_VERDICT_RULES) apply
    only when the config specifies no verdict roles at all (e.g. ad-hoc
    screens run without a config).
    """
    explicit = {
        name: ov["verdict_role"]
        for name, ov in overrides.items()
        if not name.startswith("_") and isinstance(ov, dict) and "verdict_role" in ov
    }
    if explicit:
        return explicit
    return dict(_VERDICT_RULES)


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

    # ── Fetch daily OHLC via shared cache (falls back to yfinance on miss) ──
    hist   = get_daily_ohlc(sym)
    closes = np.asarray(hist["Close"].values, dtype=float)
    highs  = np.asarray(hist["High"].values,  dtype=float)
    lows   = np.asarray(hist["Low"].values,   dtype=float)

    # ── Run indicator analysis ────────────────────────────────────────────
    macd_result = analyze_macd(closes)
    rwb_result  = analyze_rwb(closes)
    sqz_result  = analyze_sqz(closes, highs, lows)

    # ── Effective verdict rules: backend defaults overridden by config ────
    effective_verdict_rules = _effective_verdict_rules(overrides)

    # ── Build dynamic parametric condition descriptions and fns ──────────
    _apply_condition_overrides(overrides)

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

    # Verdict: use _logic groups if provided, otherwise flat AND of all required conditions
    logic = overrides.get("_logic")
    verdict = _evaluate_logic(conditions, logic)

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
# Historical screen indicator
# ---------------------------------------------------------------------------

def screen_history(
    symbol: str,
    condition_overrides: dict | None = None,
    max_bars: int = 750,
) -> list[dict]:
    """
    Evaluate the screen verdict at every historical daily bar.

    Computes the MACD/RWB/SQZ series once over the full price history, then
    walks the bars maintaining streak counters incrementally, so the cost is
    O(n) rather than re-running the full analysis per bar.  Each bar is
    evaluated with the exact same condition fns and logic evaluator used by
    :func:`screen_individual`, so a bar's value matches what the screener
    would have said on that day.

    Returns a list of ``{"time": "YYYY-MM-DD", "value": 0 | 1}`` for the last
    ``max_bars`` evaluable bars, ascending by date.
    """
    sym       = symbol.upper().strip()
    overrides = condition_overrides or {}

    hist   = get_daily_ohlc(sym)
    closes = np.asarray(hist["Close"].values, dtype=float)
    highs  = np.asarray(hist["High"].values,  dtype=float)
    lows   = np.asarray(hist["Low"].values,   dtype=float)
    dates  = [str(d) for d in hist.index]

    # ── Compute all indicator series once over the full history ──────────
    macd_data = _calc_macd(closes, 12, 26, 9, dates)
    rwb_data  = _calc_rwb(closes, dates)
    sqz_data  = _calc_squeeze(closes, highs, lows, dates)

    def _by_time(points):
        out = {}
        for p in points:
            v = float(p["value"])
            if not np.isnan(v):
                out[p["time"]] = v
        return out

    series = {
        "macd":   _by_time(macd_data["macd_line"]),
        "signal": _by_time(macd_data["signal_line"]),
        "hist":   _by_time(macd_data["histogram"]),
        "fast":   _by_time(rwb_data["fast_width"]),
        "slow":   _by_time(rwb_data["slow_width"]),
        "rwb":    _by_time(rwb_data["rwb"]),
        "mom":    _by_time(sqz_data["mom"]),
    }
    sqz_color = {p["time"]: p.get("color") for p in sqz_data["sqz"]}

    # ── Which conditions matter for the verdict ──────────────────────────
    _apply_condition_overrides(overrides)
    rules = _effective_verdict_rules(overrides)
    logic = overrides.get("_logic")
    if logic and logic.get("groups"):
        relevant = {n for g in logic["groups"] for n in g.get("conditions", [])}
    else:
        relevant = {n for n, req in rules.items() if req is not None}
    specs = [(n, _CONDITIONS[n]["fn"], rules.get(n)) for n in sorted(relevant) if n in _CONDITIONS]

    # ── Walk bars, updating streaks incrementally ─────────────────────────
    # Each streak counter starts as soon as ITS series has values — series
    # have different warmup lengths (RWB slow width needs ~60 bars, MACD
    # ~35), and a streak may already be running before the last series
    # comes online.  Evaluation only happens once every series is present.
    keys      = ("macd", "signal", "hist", "fast", "slow", "rwb", "mom")
    eval_from = max(0, len(dates) - max_bars)
    prev: dict = {}   # per-series previous value (last available point)
    hist_pos = mom_pos = fast_pos = slow_pos = fast_rise = slow_rise = fast_above = 0
    out: list[dict] = []

    for i, t in enumerate(dates):
        vals = {k: series[k].get(t) for k in keys}

        if vals["hist"] is not None:
            hist_pos = hist_pos + 1 if vals["hist"] > 0 else 0
        if vals["mom"] is not None:
            mom_pos = mom_pos + 1 if vals["mom"] > 0 else 0
        if vals["fast"] is not None:
            fast_pos = fast_pos + 1 if vals["fast"] > 0 else 0
            if prev.get("fast") is not None:
                fast_rise = fast_rise + 1 if vals["fast"] > prev["fast"] else 0
        if vals["slow"] is not None:
            slow_pos = slow_pos + 1 if vals["slow"] > 0 else 0
            if prev.get("slow") is not None:
                slow_rise = slow_rise + 1 if vals["slow"] > prev["slow"] else 0
        if vals["fast"] is not None and vals["slow"] is not None:
            fast_above = fast_above + 1 if vals["fast"] > vals["slow"] else 0

        ready = all(vals[k] is not None and prev.get(k) is not None for k in keys)
        if ready and i >= eval_from:
            def la(k):
                return LineAnalysis(sign=_sign(vals[k]), slope=_slope(vals[k], prev[k]),
                                    value=vals[k], prev_value=prev[k])
            m = SimpleNamespace(
                macd=la("macd"), signal=la("signal"), histogram=la("hist"),
                consecutive_positive_bars=hist_pos,
            )
            r = SimpleNamespace(
                fast_width=la("fast"), slow_width=la("slow"), rwb=la("rwb"),
                fast_width_above_slow_width=vals["fast"] > vals["slow"],
                bars_since_fast_above_slow=fast_above,
                slow_width_consecutive_positive_bars=slow_pos,
                fast_width_consecutive_positive_bars=fast_pos,
                slow_width_consecutive_rising_bars=slow_rise,
                fast_width_consecutive_rising_bars=fast_rise,
            )
            s = SimpleNamespace(
                momentum=la("mom"),
                squeeze_state=_SQZ_COLOR_TO_STATE.get(sqz_color.get(t), SqueezeState.NONE),
                consecutive_positive_bars=mom_pos,
            )
            conds = [
                ConditionResult(name=n, description="", passed=bool(fn(m, r, s)), verdict_role=role)
                for n, fn, role in specs
            ]
            out.append({"time": t, "value": 1 if _evaluate_logic(conds, logic) else 0})

        for k in keys:
            if vals[k] is not None:
                prev[k] = vals[k]

    return out


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
