"""
Finviz screener integration.

Uses the ``finvizfinance`` open-source library to screen symbols on
finviz.com.  Exposes three endpoints:

  GET  /finviz/filters              — all valid filter keys, option values,
                                      signals, and sort fields
  POST /finviz/screen               — run a screen, return matching symbols
  POST /finviz/screen-to-watchlist  — run a screen and save results as a
                                      new watchlist
"""
import asyncio
import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from db import Watchlist, WatchlistSymbol, get_db

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Pydantic schemas ──────────────────────────────────────────────────────────

class ScreenBody(BaseModel):
    filters:   dict[str, str] = Field(default={}, description=(
        "Finviz filter key→value pairs, e.g. "
        '{"Sector": "Technology", "Market Cap.": "Large ($10bln to $200bln)"}. '
        "Valid keys and values come from GET /finviz/filters."
    ))
    signal:    str  = Field(default="", description=(
        'Optional Finviz signal, e.g. "Top Gainers", "New High". '
        "Valid values come from GET /finviz/filters."
    ))
    order:     str  = Field(default="Ticker",  description="Sort column (from order_by list).")
    ascending: bool = Field(default=True,      description="Sort direction.")
    limit:     int  = Field(default=500, ge=1, le=5000, description="Max symbols to return.")


class ScreenToWatchlistBody(ScreenBody):
    watchlist_name: str = Field(..., description="Name for the new watchlist.")


# ── Filter metadata ───────────────────────────────────────────────────────────

@router.get("/filters")
def get_filters():
    """
    Return all valid filter names → option values, available signals, and
    available sort fields for use with the /screen endpoint.
    """
    from finvizfinance.constants import filter_dict, signal_dict, order_dict
    return {
        "filters":  {name: list(data["option"].keys()) for name, data in filter_dict.items()},
        "signals":  list(signal_dict.keys()),
        "order_by": list(order_dict.keys()),
    }


# ── Sync screener helper (runs in thread pool) ────────────────────────────────

def _run_screen(body: ScreenBody) -> list[dict]:
    """
    Execute a Finviz screen and return a list of result dicts.
    Raises ValueError on bad filter/signal/order values (finvizfinance
    propagates those as ValueError already).
    """
    from finvizfinance.screener.overview import Overview

    s = Overview()
    s.set_filter(signal=body.signal, filters_dict=body.filters)
    df = s.screener_view(
        order=body.order,
        limit=body.limit,
        ascend=body.ascending,
        verbose=0,
    )
    if df is None or df.empty:
        return []

    results = []
    for _, row in df.iterrows():
        ticker = str(row.get("Ticker") or "").strip()
        if not ticker:
            continue
        results.append({
            "ticker":     ticker,
            "company":    str(row.get("Company")  or ticker),
            "sector":     str(row.get("Sector")   or ""),
            "industry":   str(row.get("Industry") or ""),
            "country":    str(row.get("Country")  or ""),
            "market_cap": row.get("Market Cap"),
            "pe":         row.get("P/E"),
            "price":      row.get("Price"),
            "change":     row.get("Change"),
            "volume":     row.get("Volume"),
        })
    return results


async def _screen_async(body: ScreenBody) -> list[dict]:
    """Wrap _run_screen in an executor with a 60-second timeout."""
    loop = asyncio.get_event_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(None, lambda: _run_screen(body)),
            timeout=60.0,
        )
    except asyncio.TimeoutError:
        raise HTTPException(408, "Finviz screen timed out (>60 s)")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except Exception as exc:
        logger.exception("Finviz screen failed")
        raise HTTPException(502, f"Finviz screen failed: {exc}")


# ── Routes ────────────────────────────────────────────────────────────────────

@router.post("/screen")
async def screen(body: ScreenBody):
    """
    Run a Finviz screen and return matching symbols with basic metadata.

    Example request body::

        {
          "filters": {
            "Sector": "Technology",
            "Market Cap.": "Large ($10bln to $200bln)",
            "Country": "USA"
          },
          "signal": "New High",
          "order": "Market Cap.",
          "ascending": false,
          "limit": 100
        }
    """
    results = await _screen_async(body)
    return {
        "count":   len(results),
        "symbols": results,
    }


@router.post("/screen-to-watchlist", status_code=201)
async def screen_to_watchlist(
    body: ScreenToWatchlistBody,
    db:   AsyncSession = Depends(get_db),
):
    """
    Run a Finviz screen and save the resulting symbols as a new watchlist.

    Returns the created watchlist (id, name, symbol count, symbol list).
    Raises 404 if the screen returns no results.
    """
    results = await _screen_async(body)
    if not results:
        raise HTTPException(404, "No symbols matched the given filters/signal")

    # Create the watchlist
    wl = Watchlist(name=body.watchlist_name.strip())
    db.add(wl)
    await db.commit()
    await db.refresh(wl)

    # Bulk-insert symbols preserving screener order
    for pos, item in enumerate(results):
        db.add(WatchlistSymbol(
            watchlist_id=wl.id,
            symbol=item["ticker"],
            name=item["company"] or item["ticker"],
            position=pos,
        ))
    await db.commit()

    return {
        "id":      str(wl.id),
        "name":    wl.name,
        "count":   len(results),
        "symbols": [
            {"symbol": r["ticker"], "name": r["company"] or r["ticker"]}
            for r in results
        ],
    }
