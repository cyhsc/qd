import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import func, select

from api.v1 import router as v1_router
from db import Base, ScreenConfig, SessionLocal, Watchlist, engine

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create all tables on startup
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    # Seed a default watchlist if none exist
    async with SessionLocal() as db:
        count = (await db.execute(select(func.count()).select_from(Watchlist))).scalar()
        if count == 0:
            db.add(Watchlist(name="My Watchlist"))
            await db.commit()

    # Seed the default "analysis" screen config if none exist
    async with SessionLocal() as db:
        count = (await db.execute(select(func.count()).select_from(ScreenConfig))).scalar()
        if count == 0:
            db.add(ScreenConfig(
                name="analysis",
                conditions={
                    "rwb_gap_positive":       {"verdict_role": True},
                    "rwb_gap_rising":         {"verdict_role": True},
                    "macd_line_positive":     {"verdict_role": True},
                    "macd_histogram_positive": {"verdict_role": True},
                    "sqz_momentum_positive":  {"verdict_role": True},
                    "sqz_not_on":             {"verdict_role": True},
                    "sqz_consecutive_positive_bars":             {"verdict_role": None, "threshold": 3, "op": "gt"},
                    "macd_histogram_consecutive_positive_bars":  {"verdict_role": None, "threshold": 3, "op": "gt"},
                    "rwb_bars_since_fast_above_slow":            {"verdict_role": None, "threshold": 3, "op": "gt"},
                },
            ))
            await db.commit()
    yield


app = FastAPI(title="QD Stock API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:3001", "http://localhost:3002"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(v1_router, prefix="/api")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=8888, reload=True)
