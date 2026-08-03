"""
Example-based (similarity) screening endpoints.

Thin async wrappers over ml.samples (which owns the feature-vector math and the
feature_samples table).  Heavy / blocking work (yfinance-backed feature
extraction, the screen) runs in a thread so the event loop stays free.
"""
import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ml import samples as S

router = APIRouter()


class AddSampleBody(BaseModel):
    symbol: str
    date: str
    normalize: str = "atr"


@router.get("/collections")
async def collections():
    return await asyncio.to_thread(S.list_collections)


@router.get("/{collection}/screen")
async def screen(collection: str, universe: str = "S&P 500",
                 threshold: float | None = None, top: int = 50):
    try:
        recs, k = await asyncio.to_thread(S.screen, collection, universe, threshold, top)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"collection": collection, "universe": universe, "exemplars": k,
            "threshold": threshold, "results": recs[:top]}


@router.get("/{collection}")
async def get_samples(collection: str):
    return {"collection": collection,
            "samples": await asyncio.to_thread(S.list_samples, collection)}


@router.post("/{collection}")
async def add(collection: str, body: AddSampleBody):
    try:
        used_date, vec = await asyncio.to_thread(
            S.add_sample, collection, body.symbol, body.date, body.normalize)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"collection": collection, "symbol": body.symbol.upper(),
            "date": used_date, "vector": vec}


@router.delete("/{collection}/{symbol}/{date}")
async def remove(collection: str, symbol: str, date: str):
    n = await asyncio.to_thread(S.remove_sample, collection, symbol, date)
    if n == 0:
        raise HTTPException(status_code=404, detail="Sample not found.")
    return {"removed": n}
