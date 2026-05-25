from fastapi import APIRouter

from .endpoints import preferences, screen_configs, stocks, watchlists

router = APIRouter()
router.include_router(watchlists.router,    prefix="/watchlists",     tags=["watchlists"])
router.include_router(stocks.router,        prefix="/stocks",         tags=["stocks"])
router.include_router(preferences.router,   prefix="/preferences",    tags=["preferences"])
router.include_router(screen_configs.router, prefix="/screen-configs", tags=["screen-configs"])
