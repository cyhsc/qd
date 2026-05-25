# --------------------------------------------------------------------------------
# Copyright (C) [2025] [Bumblebee Networks Inc.]
# All rights reserved. Unauthorized use is prohibited.
# --------------------------------------------------------------------------------
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from db import ChartConfig, get_db

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class ChartConfigBody(BaseModel):
    name: str
    indicators: dict = {}   # { maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_dict(row: ChartConfig) -> dict:
    return {"id": row.id, "name": row.name, "indicators": row.indicators}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_configs(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ChartConfig))).scalars().all()
    return [_row_to_dict(r) for r in rows]


@router.post("", status_code=201)
async def create_config(body: ChartConfigBody, db: AsyncSession = Depends(get_db)):
    row = ChartConfig(name=body.name, indicators=body.indicators)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_to_dict(row)


@router.get("/{config_id}")
async def get_config(config_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ChartConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Chart config not found")
    return _row_to_dict(row)


@router.put("/{config_id}")
async def update_config(config_id: int, body: ChartConfigBody, db: AsyncSession = Depends(get_db)):
    row = await db.get(ChartConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Chart config not found")
    row.name       = body.name
    row.indicators = body.indicators
    flag_modified(row, "indicators")
    await db.commit()
    return _row_to_dict(row)


@router.delete("/{config_id}", status_code=204)
async def delete_config(config_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ChartConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Chart config not found")
    await db.delete(row)
    await db.commit()
