import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession
import yfinance as yf

from db import CacheMeta, Price, get_db

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
    hist = ticker.history(period=max_period, interval=yf_interval)
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


@router.get("/{symbol}/info")
async def get_info(symbol: str):
    ticker = yf.Ticker(symbol.upper())
    info = ticker.info
    if not info or len(info) < 5:
        raise HTTPException(status_code=404, detail=f"Symbol '{symbol}' not found")
    return {
        "symbol":        symbol.upper(),
        "name":          info.get("longName") or info.get("shortName") or symbol.upper(),
        "currency":      info.get("currency", "USD"),
        "exchange":      info.get("exchange", ""),
        "current_price": info.get("currentPrice") or info.get("regularMarketPrice"),
        "prev_close":    info.get("previousClose") or info.get("regularMarketPreviousClose"),
        "sector":        info.get("sector") or None,
        "industry":      info.get("industry") or None,
    }
