# --------------------------------------------------------------------------------
# Copyright (C) [2025] [Bumblebee Networks Inc.]
# All rights reserved. Unauthorized use is prohibited.
# --------------------------------------------------------------------------------
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

from db import ScreenConfig, get_db

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class ScreenConfigBody(BaseModel):
    name: str
    conditions: dict = {}


class ConditionPatch(BaseModel):
    condition_name: str
    settings: dict  # keys: verdict_role, threshold, op (any subset)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _row_to_dict(row: ScreenConfig) -> dict:
    return {"id": row.id, "name": row.name, "conditions": row.conditions}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_configs(db: AsyncSession = Depends(get_db)):
    rows = (await db.execute(select(ScreenConfig))).scalars().all()
    return [_row_to_dict(r) for r in rows]


@router.post("", status_code=201)
async def create_config(body: ScreenConfigBody, db: AsyncSession = Depends(get_db)):
    row = ScreenConfig(name=body.name, conditions=body.conditions)
    db.add(row)
    await db.commit()
    await db.refresh(row)
    return _row_to_dict(row)


@router.get("/{config_id}")
async def get_config(config_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScreenConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Screen config not found")
    return _row_to_dict(row)


@router.put("/{config_id}")
async def update_config(config_id: int, body: ScreenConfigBody, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScreenConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Screen config not found")
    row.name       = body.name
    row.conditions = body.conditions
    await db.commit()
    return _row_to_dict(row)


@router.patch("/{config_id}/conditions")
async def patch_condition(config_id: int, body: ConditionPatch, db: AsyncSession = Depends(get_db)):
    """Merge `settings` into a single condition entry, creating it if absent."""
    row = await db.get(ScreenConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Screen config not found")
    conditions = dict(row.conditions or {})
    conditions[body.condition_name] = {
        **(conditions.get(body.condition_name) or {}),
        **body.settings,
    }
    row.conditions = conditions
    flag_modified(row, "conditions")   # tell SQLAlchemy the JSON column changed
    await db.commit()
    return _row_to_dict(row)


@router.delete("/{config_id}", status_code=204)
async def delete_config(config_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(ScreenConfig, config_id)
    if not row:
        raise HTTPException(status_code=404, detail="Screen config not found")
    await db.delete(row)
    await db.commit()
