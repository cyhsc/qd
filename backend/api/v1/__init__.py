from fastapi import APIRouter

from .endpoints import stocks, watchlists

router = APIRouter()
router.include_router(watchlists.router, prefix="/watchlists", tags=["watchlists"])
router.include_router(stocks.router,     prefix="/stocks",     tags=["stocks"])
