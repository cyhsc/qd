from sqlalchemy import Column, Float, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import relationship

from .engine import Base


class CacheMeta(Base):
    """Tracks when (symbol, interval) data was last fetched from yfinance."""
    __tablename__ = "cache_meta"

    symbol     = Column(String, primary_key=True)
    interval   = Column(String, primary_key=True)
    fetched_at = Column(Float,  nullable=False)   # Unix timestamp (time.time())


class Watchlist(Base):
    __tablename__ = "watchlists"

    id      = Column(Integer, primary_key=True, autoincrement=True)
    name    = Column(String, nullable=False)
    symbols = relationship(
        "WatchlistSymbol",
        back_populates="watchlist",
        cascade="all, delete-orphan",
        order_by="WatchlistSymbol.position",
    )


class WatchlistSymbol(Base):
    __tablename__ = "watchlist_symbols"

    id           = Column(Integer, primary_key=True, autoincrement=True)
    watchlist_id = Column(Integer, ForeignKey("watchlists.id", ondelete="CASCADE"), nullable=False)
    symbol       = Column(String, nullable=False)
    name         = Column(String, nullable=False)
    position     = Column(Integer, nullable=False, default=0)
    watchlist    = relationship("Watchlist", back_populates="symbols")

    __table_args__ = (UniqueConstraint("watchlist_id", "symbol"),)


class Price(Base):
    """Cached OHLCV bars — upserted on every successful yfinance fetch."""
    __tablename__ = "prices"

    id       = Column(Integer, primary_key=True, autoincrement=True)
    symbol   = Column(String,  nullable=False)
    interval = Column(String,  nullable=False)
    ts       = Column(String,  nullable=False)   # "YYYY-MM-DD" or unix-seconds string
    open     = Column(Float)
    high     = Column(Float)
    low      = Column(Float)
    close    = Column(Float)
    volume   = Column(Integer)

    __table_args__ = (
        UniqueConstraint("symbol", "interval", "ts", name="uq_price"),
        Index("ix_prices_lookup", "symbol", "interval", "ts"),
    )
