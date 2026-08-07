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
    date: str | None = None          # point
    start: str | None = None         # range (with end)
    end: str | None = None
    normalize: str = "atr"


@router.get("/collections")
async def collections():
    return await asyncio.to_thread(S.list_collections)


@router.get("/{collection}/screen")
async def screen(collection: str, universe: str = "S&P 500",
                 threshold: float | None = None, top: int = 50,
                 metric: str = "dtw", scope: str = "latest", stride: int = 5):
    if metric not in ("dtw", "euclidean"):
        raise HTTPException(status_code=400, detail="metric must be 'dtw' or 'euclidean'.")
    if scope not in ("latest", "history"):
        raise HTTPException(status_code=400, detail="scope must be 'latest' or 'history'.")
    try:
        recs, meta = await asyncio.to_thread(
            S.screen, collection, universe, threshold, top, "atr", metric, scope, stride)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    return {"collection": collection, "universe": universe, "meta": meta,
            "threshold": threshold, "results": recs[:top]}


@router.get("/{collection}")
async def get_samples(collection: str):
    return {"collection": collection,
            "samples": await asyncio.to_thread(S.list_samples, collection)}


@router.post("/{collection}")
async def add(collection: str, body: AddSampleBody):
    try:
        if body.start and body.end:
            s, e, L = await asyncio.to_thread(
                S.add_range_sample, collection, body.symbol, body.start, body.end, body.normalize)
            return {"collection": collection, "symbol": body.symbol.upper(),
                    "kind": "range", "start": s, "end": e, "length": L}
        if not body.date:
            raise ValueError("Provide either 'date' (point) or 'start' and 'end' (range).")
        used_date, vec = await asyncio.to_thread(
            S.add_sample, collection, body.symbol, body.date, body.normalize)
        return {"collection": collection, "symbol": body.symbol.upper(),
                "kind": "point", "date": used_date, "vector": vec}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.delete("/{collection}/{symbol}/{date}")
async def remove(collection: str, symbol: str, date: str):
    n = await asyncio.to_thread(S.remove_sample, collection, symbol, date)
    if n == 0:
        raise HTTPException(status_code=404, detail="Sample not found.")
    return {"removed": n}


@router.delete("/{collection}")
async def delete_collection(collection: str):
    n = await asyncio.to_thread(S.delete_collection, collection)
    if n == 0:
        raise HTTPException(status_code=404, detail="Collection not found or already empty.")
    return {"deleted": n}
