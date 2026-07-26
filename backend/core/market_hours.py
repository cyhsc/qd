"""
Market-calendar-aware cache freshness for daily/weekly/monthly bars.

Daily (and weekly/monthly) bars only change while the US market is open,
so a cache fetched after the most recent market close stays fresh until
the next session opens — no matter how old it is in wall-clock terms.
During market hours the current bar is still forming, so the plain TTL
applies.

Pure stdlib (zoneinfo), fully synchronous: usable from both the async
endpoints and the thread-pool screener path.
"""
import time
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

_ET     = ZoneInfo("America/New_York")
_OPEN   = dtime(9, 30)
_CLOSE  = dtime(16, 0)

# Intervals whose bars only change during market hours
DAILY_INTERVALS = {"1d", "1wk", "1mo"}

# NYSE full-day holidays (observed dates). Missing a holiday only costs one
# unnecessary fetch that day — never stale data — so a static list is fine.
_HOLIDAYS = {
    # 2025
    "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26",
    "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    # 2026
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    # 2027
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
}


def _is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d.isoformat() not in _HOLIDAYS


def market_is_open(now: float | None = None) -> bool:
    """True if the US market is in its regular session (9:30–16:00 ET)."""
    dt = datetime.fromtimestamp(now if now is not None else time.time(), _ET)
    return _is_trading_day(dt.date()) and _OPEN <= dt.time() < _CLOSE


def last_market_close(now: float | None = None) -> float:
    """Unix timestamp of the most recent 16:00 ET close on a trading day."""
    dt = datetime.fromtimestamp(now if now is not None else time.time(), _ET)
    d = dt.date()
    if not (_is_trading_day(d) and dt.time() >= _CLOSE):
        d -= timedelta(days=1)
        while not _is_trading_day(d):
            d -= timedelta(days=1)
    return datetime.combine(d, _CLOSE, tzinfo=_ET).timestamp()


def last_trading_day(now: float | None = None) -> date:
    """Date of the most recent *completed* regular session (ET).

    Same day as ``last_market_close`` — the newest daily bar we can expect to
    exist. Never returns today while the session is still forming.
    """
    return datetime.fromtimestamp(last_market_close(now), _ET).date()


def daily_cache_is_fresh(fetched_at: float, ttl: int, now: float | None = None) -> bool:
    """
    Freshness rule for DAILY_INTERVALS:
      - market open   → TTL applies (the current bar is still forming)
      - market closed → fresh iff fetched after the last session's close
    """
    t = now if now is not None else time.time()
    if market_is_open(t):
        return t - fetched_at < ttl
    return fetched_at >= last_market_close(t)
