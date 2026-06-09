from fastapi import APIRouter

from .endpoints import agent_tasks, chart_configs, finviz_screen, market, preferences, screen_configs, stocks, watchlists

router = APIRouter()
router.include_router(watchlists.router,     prefix="/watchlists",     tags=["watchlists"])
router.include_router(stocks.router,         prefix="/stocks",         tags=["stocks"])
router.include_router(market.router,         prefix="/market",         tags=["market"])
router.include_router(preferences.router,    prefix="/preferences",    tags=["preferences"])
router.include_router(screen_configs.router, prefix="/screen-configs", tags=["screen-configs"])
router.include_router(chart_configs.router,  prefix="/chart-configs",  tags=["chart-configs"])
router.include_router(agent_tasks.router,    prefix="/agent-tasks",    tags=["agent-tasks"])
router.include_router(finviz_screen.router,  prefix="/finviz",         tags=["finviz"])
