import asyncio
import logging
import time

import numpy as np
from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
import yfinance as yf

from core.technicals import calc_ema, calc_sma, calc_macd, calc_guppy, calc_rwb, calc_squeeze
from core.screen import screen_individual
from db import CacheMeta, Price, ScreenConfig, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

# ── Constants ─────────────────────────────────────────────────────────────────

# Default interval when the caller only specifies a range
RANGE_DEFAULT_INTERVAL: dict[str, str] = {
    "1D":  "1m",
    "5D":  "5m",
    "1M":  "1h",
    "3M":  "1d",
    "6M":  "1d",
    "1Y":  "1d",
    "2Y":  "1wk",
    "3Y":  "1wk",
    "5Y":  "1wk",
    "10Y": "1wk",
    "MAX": "1mo",
}

INTERVAL_MAP: dict[str, str] = {
    "1m": "1m", "2m": "2m", "5m": "5m",
    "15m": "15m", "30m": "30m", "1h": "1h", "90m": "90m",
    "D": "1d", "W": "1wk", "M": "1mo",
}

# Maximum data yfinance can return per interval
INTERVAL_MAX_PERIOD: dict[str, str] = {
    "1m":  "7d",
    "2m":  "60d",
    "5m":  "60d",
    "15m": "60d",
    "30m": "60d",
    "90m": "60d",
    "1h":  "2y",
    "1d":  "max",
    "1wk": "max",
    "1mo": "max",
}

# How long cached data is considered fresh (seconds)
CACHE_TTL: dict[str, int] = {
    "1m":  2  * 60,
    "2m":  5  * 60,
    "5m":  5  * 60,
    "15m": 15 * 60,
    "30m": 15 * 60,
    "90m": 15 * 60,
    "1h":  30 * 60,
    "1d":  4  * 60 * 60,
    "1wk": 24 * 60 * 60,
    "1mo": 24 * 60 * 60,
}

INTRADAY = {"1m", "2m", "5m", "15m", "30m", "60m", "90m", "1h"}

# ── Helpers ───────────────────────────────────────────────────────────────────

def format_time(ts, interval: str) -> str:
    if interval in INTRADAY:
        return str(int(ts.timestamp()))
    return ts.strftime("%Y-%m-%d")


def to_chart_time(ts: str):
    return int(ts) if ts.isdigit() else ts


def prices_to_response(rows: list[Price], symbol: str, range_key: str, interval: str) -> dict:
    candles, volume = [], []
    for r in rows:
        ct = to_chart_time(r.ts)
        candles.append({"time": ct, "open": r.open, "high": r.high, "low": r.low, "close": r.close})
        volume.append({"time": ct, "value": r.volume,
                       "color": "#26a69a" if r.close >= r.open else "#ef5350"})
    return {"symbol": symbol, "range": range_key, "interval": interval,
            "candles": candles, "volume": volume}


async def read_cached_prices(db: AsyncSession, symbol: str, interval: str) -> list[Price] | None:
    """Return cached rows if the cache is fresh, else None."""
    meta = await db.get(CacheMeta, (symbol, interval))
    if meta is None:
        return None
    ttl = CACHE_TTL.get(interval, 3600)
    if time.time() - meta.fetched_at > ttl:
        return None
    rows = (await db.execute(
        select(Price)
        .where(Price.symbol == symbol, Price.interval == interval)
        .order_by(Price.ts)
    )).scalars().all()
    return rows if rows else None


async def write_cache(db: AsyncSession, symbol: str, interval: str, rows: list[dict]) -> None:
    """Upsert price rows and refresh the cache timestamp.

    SQLite caps bind parameters per statement (~999 on older builds).
    With 8 columns per row we can safely fit 100 rows per chunk (800 params).
    """
    if not rows:
        return

    CHUNK = 100
    for i in range(0, len(rows), CHUNK):
        chunk = rows[i : i + CHUNK]
        stmt = sqlite_insert(Price).values(chunk)
        stmt = stmt.on_conflict_do_update(
            index_elements=["symbol", "interval", "ts"],
            set_={"open": stmt.excluded.open, "high": stmt.excluded.high,
                  "low":  stmt.excluded.low,  "close": stmt.excluded.close,
                  "volume": stmt.excluded.volume},
        )
        await db.execute(stmt)

    meta = await db.get(CacheMeta, (symbol, interval))
    if meta:
        meta.fetched_at = time.time()
    else:
        db.add(CacheMeta(symbol=symbol, interval=interval, fetched_at=time.time()))

    await db.commit()


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("/{symbol}/history")
async def get_history(
    symbol: str,
    range: str = "1Y",
    interval: str = None,
    db: AsyncSession = Depends(get_db),
):
    range_key = range.upper()
    if range_key not in RANGE_DEFAULT_INTERVAL:
        raise HTTPException(status_code=400,
                            detail=f"Invalid range. Choose from: {', '.join(RANGE_DEFAULT_INTERVAL)}")

    yf_interval = INTERVAL_MAP.get(interval) if interval else RANGE_DEFAULT_INTERVAL[range_key]
    if interval and yf_interval is None:
        raise HTTPException(status_code=400,
                            detail=f"Invalid interval. Choose from: {', '.join(INTERVAL_MAP)}")

    sym = symbol.upper()

    # ── Cache hit ──────────────────────────────────────────────────────────
    cached = await read_cached_prices(db, sym, yf_interval)
    if cached:
        logger.info("Cache HIT  %s | %s (%d bars)", sym, yf_interval, len(cached))
        return prices_to_response(cached, sym, range_key, yf_interval)

    # ── Cache miss: fetch from yfinance ───────────────────────────────────
    max_period = INTERVAL_MAX_PERIOD.get(yf_interval, "max")
    logger.info("Cache MISS %s | %s — fetching period=%s", sym, yf_interval, max_period)

    ticker = yf.Ticker(sym)
    hist = ticker.history(period=max_period, interval=yf_interval, auto_adjust=False)
    if hist.empty:
        raise HTTPException(status_code=404, detail=f"No data found for symbol '{symbol}'")

    candles, volume, db_rows = [], [], []
    for ts, row in hist.iterrows():
        t  = format_time(ts, yf_interval)
        o  = round(float(row["Open"]),  4)
        h  = round(float(row["High"]),  4)
        l  = round(float(row["Low"]),   4)
        c  = round(float(row["Close"]), 4)
        v  = int(row["Volume"])
        ct = to_chart_time(t)
        candles.append({"time": ct, "open": o, "high": h, "low": l, "close": c})
        volume.append({"time": ct, "value": v, "color": "#26a69a" if c >= o else "#ef5350"})
        db_rows.append({"symbol": sym, "interval": yf_interval,
                        "ts": t, "open": o, "high": h, "low": l, "close": c, "volume": v})

    try:
        await write_cache(db, sym, yf_interval, db_rows)
    except Exception as exc:
        logger.warning("Cache write failed: %s", exc)

    return {"symbol": sym, "range": range_key, "interval": yf_interval,
            "candles": candles, "volume": volume}


# ── Indicators endpoint ───────────────────────────────────────────────────────

@router.get("/{symbol}/indicators")
async def get_indicators(
    symbol: str,
    interval: str = None,
    ma:    list[int] = Query(default=[]),   # ?ma=20&ma=50
    ema:   list[int] = Query(default=[]),   # ?ema=3&ema=5
    macd:  list[str] = Query(default=[]),   # ?macd=12,26,9
    guppy: bool      = Query(default=False),# ?guppy=1
    rwb:     bool    = Query(default=False),# ?rwb=1
    squeeze: bool    = Query(default=False),# ?squeeze=1
    db: AsyncSession = Depends(get_db),
):
    sym         = symbol.upper()
    yf_interval = INTERVAL_MAP.get(interval) if interval else "1d"
    if interval and yf_interval is None:
        raise HTTPException(status_code=400, detail="Invalid interval.")

    rows = await read_cached_prices(db, sym, yf_interval)
    if not rows:
        return {"symbol": sym, "interval": yf_interval, "ma": {}, "macd": {}}

    closes = np.array([r.close for r in rows], dtype=np.float64)
    highs  = np.array([r.high  for r in rows], dtype=np.float64)
    lows   = np.array([r.low   for r in rows], dtype=np.float64)
    times  = [to_chart_time(r.ts) for r in rows]

    # ── Simple Moving Averages ────────────────────────────────────────────────
    ma_out: dict = {}
    for period in set(ma):
        if period < 1 or len(closes) < period:
            continue
        ma_out[str(period)] = calc_sma(closes, period, times)

    # ── Exponential Moving Averages ───────────────────────────────────────────
    ema_out: dict = {}
    for period in set(ema):
        if period < 1 or len(closes) < period:
            continue
        ema_out[str(period)] = calc_ema(closes, period, times)

    # ── MACD ──────────────────────────────────────────────────────────────────
    macd_out: dict = {}
    for param in set(macd):
        parts = param.split(",")
        if len(parts) != 3:
            continue
        try:
            fast, slow, sig = int(parts[0]), int(parts[1]), int(parts[2])
        except ValueError:
            continue
        macd_out[param] = calc_macd(closes, fast, slow, sig, times)

    guppy_out   = calc_guppy(closes, times)                  if guppy   else None
    rwb_out     = calc_rwb(closes, times)                    if rwb     else None
    squeeze_out = calc_squeeze(closes, highs, lows, times)   if squeeze else None

    return {"symbol": sym, "interval": yf_interval,
            "ma": ma_out, "ema": ema_out, "macd": macd_out,
            "guppy": guppy_out, "rwb": rwb_out, "squeeze": squeeze_out}


@router.get("/{symbol}/info")
async def get_info(symbol: str):
    sym = symbol.upper()
    loop = asyncio.get_event_loop()

    def _fetch_info():
        import datetime as dt, math
        t    = yf.Ticker(sym)
        info = t.info or {}
        divs = t.dividends

        ttm_yield = None
        if divs is not None and not divs.empty:
            try:
                cutoff   = dt.datetime.now(tz=divs.index.tz) - dt.timedelta(days=365)
                ttm_divs = divs[divs.index >= cutoff]
                if not ttm_divs.empty:
                    ttm_total = float(ttm_divs.sum())
                    price = info.get("currentPrice") or info.get("regularMarketPrice")
                    if price and float(price) > 0:
                        ttm_yield = round(ttm_total / float(price) * 100, 4)
            except Exception:
                pass

        return info, ttm_yield

    try:
        info, ttm_yield = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch_info),
            timeout=15.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408,
                            detail=f"Timed out fetching info for '{sym}' (>15 s)")
    except Exception as exc:
        raise HTTPException(status_code=502,
                            detail=f"Failed to fetch info for '{sym}': {exc}")

    if not info or len(info) < 5:
        raise HTTPException(status_code=404, detail=f"Symbol '{sym}' not found")
    def _fmt_large(v):
        if v is None:
            return None
        if v >= 1_000_000_000_000:
            return f"{v / 1_000_000_000_000:.2f}T"
        if v >= 1_000_000_000:
            return f"{v / 1_000_000_000:.2f}B"
        if v >= 1_000_000:
            return f"{v / 1_000_000:.2f}M"
        return str(int(v))

    return {
        "symbol":        sym,
        "name":          info.get("longName") or info.get("shortName") or sym,
        "currency":      info.get("currency", "USD"),
        "exchange":      info.get("exchange", ""),
        "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
        "prev_close":    info.get("previousClose") or info.get("regularMarketPreviousClose"),
        "sector":        info.get("sector") or None,
        "industry":      info.get("industry") or None,
        # Overview extras
        "description":        info.get("longBusinessSummary") or None,
        "website":            info.get("website") or None,
        "country":            info.get("country") or None,
        "employees":          info.get("fullTimeEmployees") or None,
        "market_cap":         _fmt_large(info.get("marketCap")),
        "trailing_pe":        round(info["trailingPE"], 2) if info.get("trailingPE") else None,
        "forward_pe":         round(info["forwardPE"],  2) if info.get("forwardPE")  else None,
        "price_to_book":      round(info["priceToBook"], 2) if info.get("priceToBook") else None,
        "dividend_yield":     ttm_yield,
        "52w_high":           info.get("fiftyTwoWeekHigh"),
        "52w_low":            info.get("fiftyTwoWeekLow"),
        "avg_volume":         _fmt_large(info.get("averageVolume")),
        "revenue":            _fmt_large(info.get("totalRevenue")),
        "gross_profit":       _fmt_large(info.get("grossProfits")),
        "ebitda":             _fmt_large(info.get("ebitda")),
        "debt_to_equity":     round(info["debtToEquity"], 2) if info.get("debtToEquity") else None,
        "return_on_equity":   round(info["returnOnEquity"] * 100, 2) if info.get("returnOnEquity") else None,
        "return_on_assets":   round(info["returnOnAssets"] * 100, 2) if info.get("returnOnAssets") else None,
        "revenue_growth":     round(info["revenueGrowth"] * 100, 2) if info.get("revenueGrowth") else None,
        "earnings_growth":    round(info["earningsGrowth"] * 100, 2) if info.get("earningsGrowth") else None,
    }


@router.get("/{symbol}/screen")
async def get_screen(
    symbol: str,
    config_id: int | None = Query(default=None),
    db: AsyncSession = Depends(get_db),
):
    sym = symbol.upper()

    # Load condition overrides from the named screen config (if provided)
    condition_overrides: dict = {}
    if config_id is not None:
        row = await db.get(ScreenConfig, config_id)
        if row:
            condition_overrides = row.conditions or {}

    loop = asyncio.get_event_loop()
    try:
        result = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: screen_individual(
                sym,
                condition_overrides=condition_overrides,
            )),
            timeout=60.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408,
                            detail=f"Screening timed out for '{sym}' (>60 s)")
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=502,
                            detail=f"Screening failed for '{sym}': {exc}")

    def fmt_line(la):
        return {"sign": la.sign.value, "slope": la.slope.value,
                "value": round(la.value, 6), "prev_value": round(la.prev_value, 6)}

    return {
        "symbol":  result.symbol,
        "verdict": result.verdict,
        "score":   result.score,
        "total":   result.total,
        "conditions": [
            {
                "name":         c.name,
                "description":  c.description,
                "passed":       c.passed,
                "verdict_role": c.verdict_role,  # True/False/None
            }
            for c in result.conditions
        ],
        "macd": {
            "macd":                      fmt_line(result.macd.macd),
            "signal":                    fmt_line(result.macd.signal),
            "histogram":                 fmt_line(result.macd.histogram),
            "consecutive_positive_bars": result.macd.consecutive_positive_bars,
        },
        "rwb": {
            "rwb":                        fmt_line(result.rwb.rwb),
            "fast_width":                 fmt_line(result.rwb.fast_width),
            "slow_width":                 fmt_line(result.rwb.slow_width),
            "fast_width_above_slow_width": result.rwb.fast_width_above_slow_width,
            "bars_since_fast_above_slow":  result.rwb.bars_since_fast_above_slow,
        },
        "sqz": {
            "momentum":                  fmt_line(result.sqz.momentum),
            "squeeze_state":             result.sqz.squeeze_state.value,
            "consecutive_positive_bars": result.sqz.consecutive_positive_bars,
        },
        "report": result.report,
    }


@router.get("/{symbol}/dividends")
async def get_dividends(symbol: str):
    sym  = symbol.upper()
    loop = asyncio.get_event_loop()

    def _fetch():
        import math
        t = yf.Ticker(sym)
        info = t.info or {}
        divs = t.dividends  # pandas Series: index=date, value=amount

        def _sf(v):
            try:
                f = float(v)
                return None if math.isnan(f) or math.isinf(f) else f
            except (TypeError, ValueError):
                return None

        # Build payment history newest-first
        history = []
        if divs is not None and not divs.empty:
            prev = None
            for date, amount in reversed(list(divs.items())):
                amt = _sf(amount)
                chg = None
                if amt is not None and prev is not None and prev != 0:
                    chg = round((amt - prev) / abs(prev) * 100, 2)
                history.append({
                    "date":   str(date.date()) if hasattr(date, "date") else str(date),
                    "amount": amt,
                    "change": chg,
                })
                prev = amt

        ex_div = info.get("exDividendDate")
        if ex_div:
            import datetime
            try:
                ex_div = str(datetime.datetime.fromtimestamp(ex_div).date())
            except Exception:
                ex_div = str(ex_div)

        # TTM dividend yield: sum payments in the trailing 12 months / current price
        import datetime as dt
        ttm_yield = None
        ttm_total = None
        if divs is not None and not divs.empty:
            cutoff = dt.datetime.now(tz=divs.index.tz) - dt.timedelta(days=365)
            ttm_divs = divs[divs.index >= cutoff]
            if not ttm_divs.empty:
                ttm_total = float(ttm_divs.sum())
                price = _sf(info.get("currentPrice") or info.get("regularMarketPrice"))
                if price and price > 0:
                    ttm_yield = round(ttm_total / price * 100, 4)

        raw_rate = info.get("dividendRate")
        if raw_rate is None:
            raw_rate = info.get("trailingAnnualDividendRate")

        return {
            "symbol":           sym,
            "dividend_yield":   ttm_yield,
            "annual_rate":      ttm_total if ttm_total is not None else _sf(raw_rate),
            "payout_ratio":     _sf(info.get("payoutRatio")),
            "ex_dividend_date": ex_div,
            "five_year_avg_yield": _sf(info.get("fiveYearAvgDividendYield")),
            "last_dividend":    _sf(info.get("lastDividendValue")),
            "frequency":        info.get("dividendFrequency") or _infer_frequency(divs),
            "history":          history,
        }

    def _infer_frequency(divs):
        if divs is None or len(divs) < 2:
            return None
        import pandas as pd
        dates = divs.index.sort_values()
        avg_days = (dates[-1] - dates[0]).days / max(len(dates) - 1, 1)
        if avg_days < 45:   return "Monthly"
        if avg_days < 100:  return "Quarterly"
        if avg_days < 200:  return "Semi-Annual"
        return "Annual"

    try:
        result = await asyncio.wait_for(loop.run_in_executor(None, _fetch), timeout=20.0)
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail=f"Timed out fetching dividends for '{sym}'")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch dividends for '{sym}': {exc}")

    return result


@router.get("/{symbol}/financials")
async def get_financials(symbol: str):
    sym  = symbol.upper()
    loop = asyncio.get_event_loop()

    def _fetch():
        import pandas as pd

        def _get(t, *attrs):
            for a in attrs:
                try:
                    df = getattr(t, a, None)
                    if df is not None and isinstance(df, pd.DataFrame) and not df.empty:
                        return df
                except Exception:
                    pass
            return pd.DataFrame()

        t = yf.Ticker(sym)
        return {
            "income_annual":      _get(t, "income_stmt",            "financials"),
            "income_quarterly":   _get(t, "quarterly_income_stmt",  "quarterly_financials"),
            "balance_annual":     _get(t, "balance_sheet"),
            "balance_quarterly":  _get(t, "quarterly_balance_sheet"),
            "cashflow_annual":    _get(t, "cash_flow",              "cashflow"),
            "cashflow_quarterly": _get(t, "quarterly_cash_flow",    "quarterly_cashflow"),
        }

    try:
        data = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch),
            timeout=20.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail=f"Timed out fetching financials for '{sym}'")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Failed to fetch financials for '{sym}': {exc}")

    import math

    def _safe_float(v):
        try:
            f = float(v)
            return None if math.isnan(f) or math.isinf(f) else f
        except (TypeError, ValueError):
            return None

    def _col_label(c):
        return str(c.date()) if hasattr(c, "date") else str(c)

    def _df_to_rows(df):
        if df is None or df.empty:
            return {}
        return {str(label): [_safe_float(v) for v in series]
                for label, series in df.iterrows()}

    def _ttm(quarterly_df):
        """Sum last 4 quarters per row (for flow statements)."""
        if quarterly_df is None or quarterly_df.empty:
            return None, None
        n = min(4, quarterly_df.shape[1])
        result = {}
        for label, series in quarterly_df.iterrows():
            vals = [_safe_float(v) for v in series.iloc[:n]]
            non_null = [v for v in vals if v is not None]
            result[str(label)] = sum(non_null) if non_null else None
        # also return date of most recent quarter for TTM label
        ttm_label = f"TTM ({_col_label(quarterly_df.columns[0])})"
        return result, ttm_label

    def _build(annual_df, quarterly_df, include_ttm=True):
        ann_cols = [_col_label(c) for c in annual_df.columns] if annual_df is not None and not annual_df.empty else []
        ann_rows = _df_to_rows(annual_df)
        qtr_cols = [_col_label(c) for c in quarterly_df.columns] if quarterly_df is not None and not quarterly_df.empty else []
        qtr_rows = _df_to_rows(quarterly_df)

        if include_ttm:
            ttm_vals, ttm_label = _ttm(quarterly_df)
        else:
            ttm_vals, ttm_label = None, None

        # Merge all known row labels (preserve annual order, append any quarterly-only labels)
        all_labels = list(ann_rows.keys())
        for lbl in qtr_rows:
            if lbl not in ann_rows:
                all_labels.append(lbl)

        def _make_rows(row_dict, cols):
            return [{"label": lbl, "values": row_dict.get(lbl, [None] * len(cols))}
                    for lbl in all_labels]

        # Annual: prepend TTM column
        ann_final_cols = ([ttm_label] + ann_cols) if ttm_label else ann_cols
        ann_final_rows = []
        for lbl in all_labels:
            ttm_val = ttm_vals.get(lbl) if ttm_vals else None
            ann_vals = ann_rows.get(lbl, [None] * len(ann_cols))
            ann_final_rows.append({
                "label": lbl,
                "values": ([ttm_val] + ann_vals) if ttm_label else ann_vals,
            })

        return {
            "annual":    {"columns": ann_final_cols, "rows": ann_final_rows},
            "quarterly": {"columns": qtr_cols,       "rows": _make_rows(qtr_rows, qtr_cols)},
        }

    return {
        "symbol":   sym,
        "income":   _build(data["income_annual"],   data["income_quarterly"],   include_ttm=True),
        "balance":  _build(data["balance_annual"],  data["balance_quarterly"],  include_ttm=False),
        "cashflow": _build(data["cashflow_annual"],  data["cashflow_quarterly"], include_ttm=True),
    }
