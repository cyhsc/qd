from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from db import Preferences, get_db

router = APIRouter()

PREFS_ID = 1


class PrefsBody(BaseModel):
    data: dict


@router.get("")
async def get_preferences(db: AsyncSession = Depends(get_db)):
    row = await db.get(Preferences, PREFS_ID)
    return {"data": row.data if row else {}}


@router.put("")
async def save_preferences(body: PrefsBody, db: AsyncSession = Depends(get_db)):
    row = await db.get(Preferences, PREFS_ID)
    if row:
        row.data = body.data
    else:
        db.add(Preferences(id=PREFS_ID, data=body.data))
    await db.commit()
    return {"data": body.data}
