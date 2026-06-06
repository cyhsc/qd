import asyncio
import logging

from fastapi import APIRouter, HTTPException, Query

from core.stockcharts_data import StockChartsData

logger = logging.getLogger(__name__)
router = APIRouter()


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
