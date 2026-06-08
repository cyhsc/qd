from sqlalchemy import Boolean, Column, Float, ForeignKey, Index, Integer, JSON, String, UniqueConstraint
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


class Preferences(Base):
    """Single-row table storing global chart preferences (id always 1)."""
    __tablename__ = "preferences"

    id   = Column(Integer, primary_key=True, default=1)
    data = Column(JSON, nullable=False, default=dict)


class ChartConfig(Base):
    """Named chart configuration — stores indicator settings (MA, MACD, Guppy, RWB, Squeeze)."""
    __tablename__ = "chart_configs"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String,  nullable=False, unique=True)
    indicators = Column(JSON,    nullable=False, default=dict)
    # indicators shape:
    #   {
    #     "maConfigs":      [...],
    #     "macdConfigs":    [...],
    #     "guppyConfigs":   [...],
    #     "rwbConfigs":     [...],
    #     "squeezeConfigs": [...],
    #   }


class ScreenConfig(Base):
    """Named screening configuration — stores per-condition verdict roles and params."""
    __tablename__ = "screen_configs"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    name       = Column(String,  nullable=False, unique=True)
    conditions = Column(JSON,    nullable=False, default=dict)
    # conditions shape:
    #   {
    #     "<condition_name>": {
    #       "verdict_role": true | false | null,  # overrides backend default; omit = use default
    #       "threshold":    <int>,                # parametric conditions only
    #       "op":           "gt" | "eq" | "lt",   # parametric conditions only
    #     },
    #     ...
    #   }


class AgentTask(Base):
    """A user-defined periodic task (e.g. run a screener on a schedule)."""
    __tablename__ = "agent_tasks"

    id              = Column(Integer, primary_key=True, autoincrement=True)
    name            = Column(String,  nullable=False)
    description     = Column(String,  nullable=False, default="")
    task_type       = Column(String,  nullable=False, default="screener")
    # task_type-specific params, e.g.:
    #   screener: { "screen_config_id": int, "watchlist_id": int }
    config          = Column(JSON,    nullable=False, default=dict)
    schedule_time   = Column(String,  nullable=False, default="09:30")  # "HH:MM" ET
    # daily | weekdays | weekly | monthly
    frequency       = Column(String,  nullable=False, default="weekdays")
    day_of_week     = Column(Integer, nullable=True)   # 0=Mon..6=Sun (weekly only)
    day_of_month    = Column(Integer, nullable=True)   # 1-28 (monthly only)
    enabled         = Column(Boolean, nullable=False, default=True)
    created_at      = Column(String,  nullable=False, default="")
    last_run_at     = Column(String,  nullable=True)
    last_run_status = Column(String,  nullable=True)   # success | error | running

    # Chaining: after this task succeeds, run next_task_id immediately
    next_task_id = Column(
        Integer,
        ForeignKey("agent_tasks.id", ondelete="SET NULL"),
        nullable=True,
    )
    next_task = relationship(
        "AgentTask",
        foreign_keys=[next_task_id],
        remote_side="AgentTask.id",
        uselist=False,
    )

    runs = relationship(
        "AgentTaskRun",
        back_populates="task",
        cascade="all, delete-orphan",
    )


class AgentTaskRun(Base):
    """One execution record for an AgentTask."""
    __tablename__ = "agent_task_runs"

    id         = Column(Integer, primary_key=True, autoincrement=True)
    task_id    = Column(Integer, ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False)
    started_at = Column(String,  nullable=False)
    ended_at   = Column(String,  nullable=True)
    status     = Column(String,  nullable=False)   # running | success | error
    output     = Column(JSON,    nullable=True)    # task-specific result payload
    error      = Column(String,  nullable=True)

    task = relationship("AgentTask", back_populates="runs")


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
