from fastapi import APIRouter

from .endpoints import preferences, stocks, watchlists

router = APIRouter()
router.include_router(watchlists.router,  prefix="/watchlists",  tags=["watchlists"])
router.include_router(stocks.router,      prefix="/stocks",      tags=["stocks"])
router.include_router(preferences.router, prefix="/preferences", tags=["preferences"])
