import asyncio
import logging
from datetime import datetime, time as dtime

import pytz
import yfinance as yf
from fastapi import APIRouter, HTTPException, Query

from core.stockcharts_data import StockChartsData

logger = logging.getLogger(__name__)
router = APIRouter()

_ET = pytz.timezone('America/New_York')
_MARKET_OPEN  = dtime(9, 30)
_MARKET_CLOSE = dtime(16, 0)

_INTRADAY_TICKERS = {'SPY', 'QQQ', 'DIA', 'IWM'}

def _is_market_open() -> bool:
    now = datetime.now(_ET)
    return now.weekday() < 5 and _MARKET_OPEN <= now.time() <= _MARKET_CLOSE


@router.get("/indicator")
async def get_indicator(
    symbol: str = Query(..., description="StockCharts symbol, e.g. $NYMO"),
    years:  int = Query(default=3, ge=1, le=10),
):
    """
    Fetch a StockCharts indicator time series.

    Returns ``{ symbol, data: [{date, value}] }`` sorted ascending by date.
    """
    loop = asyncio.get_event_loop()

    def _fetch():
        scd = StockChartsData()
        df  = scd.get(symbol, years=years)
        col = df.columns[0]
        return [
            {"date": str(idx), "value": round(float(row[col]), 4)}
            for idx, row in df.iterrows()
        ]

    try:
        data = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail=f"Timed out fetching '{symbol}'")
    except Exception as exc:
        logger.exception("market indicator fetch failed for %s", symbol)
        raise HTTPException(status_code=502, detail=f"Failed to fetch '{symbol}': {exc}")

    return {"symbol": symbol, "data": data}


@router.get("/intraday")
async def get_intraday(t: str = Query(..., description="Index ETF ticker: SPY, QQQ, DIA, IWM")):
    """
    Fetch 1-min OHLCV data for one trading day from Yahoo Finance.
    Returns bars in ET, plus prev_close and whether the market is currently open.
    """
    ticker = t.upper()
    if ticker not in _INTRADAY_TICKERS:
        raise HTTPException(status_code=400, detail=f"Ticker must be one of {sorted(_INTRADAY_TICKERS)}")

    def _fetch():
        tk   = yf.Ticker(ticker)
        # Use 5d so we always have the last full trading session available,
        # then slice to just the most recent date.
        df   = tk.history(period="5d", interval="1m")
        info = tk.fast_info

        prev_close = getattr(info, "previous_close", None)
        if prev_close is not None:
            prev_close = round(float(prev_close), 2)

        if df.empty:
            return [], prev_close

        # Convert to ET and keep only the last trading day
        df.index = df.index.tz_convert(_ET)
        last_date = df.index[-1].date()
        df = df[df.index.date == last_date]

        bars = []
        for ts, row in df.iterrows():
            c = row["Close"]
            if c != c:          # NaN guard
                continue
            bars.append({
                "time":   ts.strftime("%H:%M"),
                "open":   round(float(row["Open"]),  2),
                "high":   round(float(row["High"]),  2),
                "low":    round(float(row["Low"]),   2),
                "close":  round(float(c),            2),
                "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else 0,
            })

        return bars, prev_close

    loop = asyncio.get_event_loop()
    try:
        data, prev_close = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch),
            timeout=30.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail=f"Timed out fetching '{ticker}'")
    except Exception as exc:
        logger.exception("intraday fetch failed for %s", ticker)
        raise HTTPException(status_code=502, detail=f"Failed to fetch '{ticker}': {exc}")

    return {
        "symbol":           ticker,
        "data":             data,
        "prev_close":       prev_close,
        "is_market_open":   _is_market_open(),
    }
