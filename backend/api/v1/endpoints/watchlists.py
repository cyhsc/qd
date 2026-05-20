from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from db import Watchlist, WatchlistSymbol, get_db

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────

class CreateListBody(BaseModel):
    name: str


class AddSymbolBody(BaseModel):
    symbol: str
    name: str


# ── Serialiser ────────────────────────────────────────────────────────────────

def wl_dict(wl: Watchlist) -> dict:
    return {
        "id":      str(wl.id),
        "name":    wl.name,
        "symbols": [{"symbol": s.symbol, "name": s.name} for s in wl.symbols],
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@router.get("")
async def get_watchlists(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(
        select(Watchlist).options(selectinload(Watchlist.symbols)).order_by(Watchlist.id)
    )).scalars().all()
    return {"lists": [wl_dict(wl) for wl in rows]}


@router.post("", status_code=201)
async def create_watchlist(body: CreateListBody, db: AsyncSession = Depends(get_db)):
    wl = Watchlist(name=body.name.strip())
    db.add(wl)
    await db.commit()
    await db.refresh(wl)
    # Return directly — don't access wl.symbols, which would trigger a
    # lazy-load and raise MissingGreenlet in an async session.
    return {"id": str(wl.id), "name": wl.name, "symbols": []}


@router.delete("/{list_id}", status_code=204)
async def delete_watchlist(list_id: int, db: AsyncSession = Depends(get_db)):
    wl = await db.get(Watchlist, list_id)
    if wl:
        await db.delete(wl)
        await db.commit()


@router.post("/{list_id}/symbols", status_code=201)
async def add_symbol(list_id: int, body: AddSymbolBody, db: AsyncSession = Depends(get_db)):
    wl = await db.get(Watchlist, list_id)
    if wl is None:
        raise HTTPException(status_code=404, detail="Watchlist not found")

    exists = (await db.execute(
        select(WatchlistSymbol).where(
            WatchlistSymbol.watchlist_id == list_id,
            WatchlistSymbol.symbol == body.symbol,
        )
    )).scalar_one_or_none()
    if exists:
        raise HTTPException(status_code=409, detail=f"{body.symbol} is already in this list")

    pos = (await db.execute(
        select(func.count()).select_from(WatchlistSymbol)
        .where(WatchlistSymbol.watchlist_id == list_id)
    )).scalar()

    db.add(WatchlistSymbol(
        watchlist_id=list_id, symbol=body.symbol, name=body.name, position=pos
    ))
    await db.commit()
    return {"symbol": body.symbol, "name": body.name}


@router.delete("/{list_id}/symbols/{symbol}", status_code=204)
async def delete_symbol(list_id: int, symbol: str, db: AsyncSession = Depends(get_db)):
    await db.execute(
        delete(WatchlistSymbol).where(
            WatchlistSymbol.watchlist_id == list_id,
            WatchlistSymbol.symbol == symbol,
        )
    )
    await db.commit()
