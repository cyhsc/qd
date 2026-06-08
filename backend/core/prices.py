"""
Synchronous price cache access for use inside thread-pool executors.

Reads from and writes to the same SQLite DB that the async endpoints use
(via aiosqlite/SQLAlchemy), so chart fetches and screener runs share the
same cached price rows.  Uses plain ``sqlite3`` to stay fully synchronous —
no event loop required.
"""
import logging
import math
import sqlite3
import time
from pathlib import Path

import pandas as pd
import yfinance as yf

logger = logging.getLogger(__name__)

# Same file the async engine points at
_DB_PATH = Path(__file__).parent.parent / "db" / "qd.db"

# Mirror of CACHE_TTL / INTERVAL_MAX_PERIOD in stocks.py (daily & weekly only;
# screener always uses daily)
_CACHE_TTL = {
    "1d":  4  * 60 * 60,   # 4 hours
    "1wk": 24 * 60 * 60,   # 24 hours
}
_MAX_PERIOD = {
    "1d":  "max",
    "1wk": "max",
}


# ── Internal helpers ──────────────────────────────────────────────────────────

def _sf(v):
    """Return v as a finite float, or None."""
    if v is None:
        return None
    try:
        f = float(v)
        return None if (math.isnan(f) or math.isinf(f)) else f
    except (TypeError, ValueError):
        return None


def _is_fresh(con: sqlite3.Connection, sym: str, interval: str, ttl: int) -> bool:
    row = con.execute(
        "SELECT fetched_at FROM cache_meta WHERE symbol=? AND interval=?",
        (sym, interval),
    ).fetchone()
    return row is not None and (time.time() - row[0]) < ttl


def _read_rows(con: sqlite3.Connection, sym: str, interval: str) -> pd.DataFrame:
    rows = con.execute(
        "SELECT ts, open, high, low, close, volume FROM prices "
        "WHERE symbol=? AND interval=? ORDER BY ts",
        (sym, interval),
    ).fetchall()
    if not rows:
        return pd.DataFrame()
    df = pd.DataFrame(rows, columns=["ts", "Open", "High", "Low", "Close", "Volume"])
    df = df.dropna(subset=["Open", "Close"])
    return df.set_index("ts")


def _write_rows(con: sqlite3.Connection, sym: str, interval: str, hist: pd.DataFrame) -> None:
    rows = []
    for ts, row in hist.iterrows():
        date_str = ts.strftime("%Y-%m-%d") if hasattr(ts, "strftime") else str(ts)[:10]
        o = _sf(row.get("Open"))
        c = _sf(row.get("Close"))
        if o is None or c is None:
            continue
        h = _sf(row.get("High"))
        l = _sf(row.get("Low"))
        v_raw = row.get("Volume")
        v = int(v_raw) if (v_raw == v_raw) else 0   # NaN guard
        rows.append((sym, interval, date_str, o, h, l, c, v))

    if rows:
        con.executemany(
            "INSERT INTO prices (symbol, interval, ts, open, high, low, close, volume) "
            "VALUES (?,?,?,?,?,?,?,?) "
            "ON CONFLICT(symbol, interval, ts) DO UPDATE SET "
            "  open=excluded.open, high=excluded.high, low=excluded.low, "
            "  close=excluded.close, volume=excluded.volume",
            rows,
        )

    con.execute(
        "INSERT INTO cache_meta (symbol, interval, fetched_at) VALUES (?,?,?) "
        "ON CONFLICT(symbol, interval) DO UPDATE SET fetched_at=excluded.fetched_at",
        (sym, interval, time.time()),
    )
    con.commit()


# ── Public API ────────────────────────────────────────────────────────────────

def get_daily_ohlc(symbol: str) -> pd.DataFrame:
    """
    Return a DataFrame of **daily** OHLCV bars for *symbol*, backed by the
    shared SQLite price cache.

    On a cache miss (or stale cache) this fetches ``period=max`` from
    Yahoo Finance and writes the result back to the cache so subsequent
    calls (async or sync) are fast.

    Columns: Open, High, Low, Close, Volume  (float / int)
    Index  : date strings "YYYY-MM-DD" (ascending)

    Raises
    ------
    ValueError
        If Yahoo Finance returns no price data for the symbol.
    """
    sym      = symbol.upper().strip()
    interval = "1d"
    ttl      = _CACHE_TTL[interval]
    period   = _MAX_PERIOD[interval]

    con = sqlite3.connect(_DB_PATH)
    try:
        if _is_fresh(con, sym, interval, ttl):
            df = _read_rows(con, sym, interval)
            if not df.empty:
                logger.info("prices cache HIT  %s | %s  (%d bars)", sym, interval, len(df))
                return df

        # Cache miss — fetch from yfinance and write back
        logger.info("prices cache MISS %s | %s — fetching period=%s", sym, interval, period)
        hist = yf.Ticker(sym).history(period=period, interval=interval, auto_adjust=False)
        if hist.empty:
            raise ValueError(f"No price data found for '{sym}'")

        _write_rows(con, sym, interval, hist)
        df = _read_rows(con, sym, interval)
        if df.empty:
            raise ValueError(f"No usable price data for '{sym}' after fetch")
        return df
    finally:
        con.close()
