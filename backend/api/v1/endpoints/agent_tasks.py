"""
Agent task CRUD + scheduling endpoints.

Tasks and their schedules are now separate concerns:

  POST   /agent-tasks                  create a task (no schedule required)
  GET    /agent-tasks                  list all tasks
  GET    /agent-tasks/task-types       available task types + metadata
  GET    /agent-tasks/{id}             get task + run history
  PUT    /agent-tasks/{id}             update task definition (name/type/config/chain)
  DELETE /agent-tasks/{id}             delete task

  PUT    /agent-tasks/{id}/schedule    set or update the schedule
  DELETE /agent-tasks/{id}/schedule    remove the schedule (task keeps existing)

  POST   /agent-tasks/{id}/trigger     run immediately (async)
  GET    /agent-tasks/{id}/runs        last 50 run records

A task is scheduled iff task.enabled == True.  The /schedule endpoints are
the only way to toggle that flag; the task CRUD endpoints never touch it.
"""
import asyncio
import logging
from datetime import datetime, timezone

import pytz
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from core.task_types import all_task_types
from db import AgentTask, AgentTaskRun, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

_ET = pytz.timezone("America/New_York")


# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class TaskBody(BaseModel):
    """Create or update a task definition — no schedule or chain fields."""
    name:        str
    description: str  = ""
    task_type:   str  = "screener"
    config:      dict = {}


class ScheduleBody(BaseModel):
    """Set or update the schedule for a task (includes optional chaining)."""
    schedule_time: str        # "HH:MM" ET
    frequency:     str = "weekdays"   # daily | weekdays | weekly | monthly
    day_of_week:   int | None = None  # 0=Mon..6=Sun (weekly only)
    day_of_month:  int | None = None  # 1-28       (monthly only)
    next_task_id:  int | None = None  # chain: run this task after success


# ---------------------------------------------------------------------------
# Serialisation helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: AgentTask, include_runs: bool = False) -> dict:
    is_scheduled = bool(row.enabled)
    d = {
        "id":              row.id,
        "name":            row.name,
        "description":     row.description,
        "task_type":       row.task_type,
        "config":          row.config or {},
        "next_task_id":    row.next_task_id,
        "next_task_name":  row.next_task.name if row.next_task else None,
        "is_scheduled":    is_scheduled,
        # schedule block — null when not scheduled
        "schedule": {
            "schedule_time": row.schedule_time,
            "frequency":     row.frequency,
            "day_of_week":   row.day_of_week,
            "day_of_month":  row.day_of_month,
        } if is_scheduled else None,
        "created_at":      row.created_at,
        "last_run_at":     row.last_run_at,
        "last_run_status": row.last_run_status,
    }
    if include_runs:
        d["runs"] = [_run_to_dict(r) for r in (row.runs or [])]
    return d


def _run_to_dict(run: AgentTaskRun) -> dict:
    return {
        "id":         run.id,
        "task_id":    run.task_id,
        "started_at": run.started_at,
        "ended_at":   run.ended_at,
        "status":     run.status,
        "output":     run.output,
        "error":      run.error,
    }


# ---------------------------------------------------------------------------
# Scheduler integration (injected by main.py at startup)
# ---------------------------------------------------------------------------

_scheduler = None


def set_scheduler(sched):
    global _scheduler
    _scheduler = sched


def _cron_kwargs(task: AgentTask) -> dict:
    h, m = task.schedule_time.split(":")
    base = {"hour": int(h), "minute": int(m), "timezone": _ET}
    freq = task.frequency
    if freq == "daily":
        return base
    if freq == "weekdays":
        return {**base, "day_of_week": "mon-fri"}
    if freq == "weekly":
        names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        return {**base, "day_of_week": names[task.day_of_week or 0]}
    if freq == "monthly":
        return {**base, "day": task.day_of_month or 1}
    return base


def _job_id(task_id: int) -> str:
    return f"agent_task_{task_id}"


def schedule_task(task: AgentTask):
    """Sync APScheduler with this task's current state."""
    if _scheduler is None:
        return
    jid = _job_id(task.id)
    if _scheduler.get_job(jid):
        _scheduler.remove_job(jid)
    if not task.enabled:
        return

    if task.frequency == "once":
        # schedule_time holds a full "YYYY-MM-DDTHH:MM" string for one-shot runs
        from datetime import datetime as _dt
        run_date = _ET.localize(_dt.fromisoformat(task.schedule_time))
        _scheduler.add_job(
            _execute_task, "date",
            id=jid, args=[task.id],
            run_date=run_date,
        )
        logger.info("Scheduled %s  once at %s ET", jid, task.schedule_time)
    else:
        _scheduler.add_job(
            _execute_task, "cron",
            id=jid, args=[task.id], replace_existing=True,
            **_cron_kwargs(task),
        )
        logger.info("Scheduled %s  freq=%s  time=%s", jid, task.frequency, task.schedule_time)


def unschedule_task(task_id: int):
    if _scheduler is None:
        return
    jid = _job_id(task_id)
    if _scheduler.get_job(jid):
        _scheduler.remove_job(jid)


# ---------------------------------------------------------------------------
# Cycle detection (for chaining)
# ---------------------------------------------------------------------------

async def _has_cycle(db, start_id: int, next_id: int) -> bool:
    visited = set()
    cur = next_id
    while cur is not None:
        if cur == start_id:
            return True
        if cur in visited:
            break
        visited.add(cur)
        row = await db.get(AgentTask, cur)
        cur = row.next_task_id if row else None
    return False


# ---------------------------------------------------------------------------
# Task execution
# ---------------------------------------------------------------------------

async def _execute_task(task_id: int):
    """Run one task and record the result. Called by APScheduler or /trigger."""
    from db.engine import SessionLocal

    async with SessionLocal() as db:
        task = await db.get(AgentTask, task_id)
        if task is None:
            logger.warning("execute_task: task %d not found", task_id)
            return
        now = _now_iso()
        run = AgentTaskRun(task_id=task_id, started_at=now, status="running")
        db.add(run)
        task.last_run_at = now
        task.last_run_status = "running"
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    output, error, status = None, None, "success"
    try:
        if task.task_type == "screener":
            output = await _run_screener(task)
        elif task.task_type == "finviz_screen":
            output = await _run_finviz_screen(task)
        else:
            raise ValueError(f"Unknown task_type: {task.task_type!r}")
    except Exception as exc:
        logger.exception("Agent task %d failed", task_id)
        error, status = str(exc), "error"

    ended = _now_iso()
    next_id = None
    async with SessionLocal() as db:
        run = await db.get(AgentTaskRun, run_id)
        if run:
            run.ended_at, run.status, run.output, run.error = ended, status, output, error
        task = await db.get(AgentTask, task_id)
        if task:
            task.last_run_at = ended
            task.last_run_status = status
            if status == "success":
                next_id = task.next_task_id
            if task.frequency == "once":
                # one-shot job — APScheduler already dropped the job; mirror in DB
                task.enabled = False
        await db.commit()

    if next_id is not None:
        logger.info("Task %d succeeded — chaining to %d", task_id, next_id)
        asyncio.create_task(_execute_task(next_id))


async def _run_screener(task: AgentTask) -> dict:
    """Run an internal screener config against a watchlist."""
    from core.analysis import analyse
    from db.engine import SessionLocal
    from db.models import ScreenConfig, Watchlist

    cfg_id = task.config.get("screen_config_id")
    wl_id  = task.config.get("watchlist_id")

    async with SessionLocal() as db:
        screen_cfg = await db.get(ScreenConfig, cfg_id) if cfg_id else None
        wl         = await db.get(Watchlist,    wl_id)  if wl_id  else None

    conditions = screen_cfg.conditions if screen_cfg else {}
    symbols    = [s.symbol for s in (wl.symbols if wl else [])]

    if not symbols:
        return {"passed": [], "failed": [], "total": 0, "note": "Empty watchlist"}

    loop = asyncio.get_event_loop()
    passed, failed = [], []
    for sym in symbols:
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(None, lambda s=sym: analyse(s, conditions)),
                timeout=60,
            )
            verdict = all(
                c.get("passed") == c.get("verdict_role")
                for c in result.get("conditions", [])
                if c.get("verdict_role") is not None
            )
            (passed if verdict else failed).append(sym)
        except Exception as exc:
            logger.warning("Screener: %s failed — %s", sym, exc)
            failed.append(sym)

    return {
        "passed":      passed,
        "failed":      failed,
        "total":       len(symbols),
        "screen_name": screen_cfg.name if screen_cfg else None,
        "wl_name":     wl.name if wl else None,
    }


async def _run_finviz_screen(task: AgentTask) -> dict:
    """Run a Finviz screen; optionally create a watchlist from the results."""
    from api.v1.endpoints.finviz_screen import ScreenBody, _run_screen
    from db.engine import SessionLocal
    from db.models import Watchlist, WatchlistSymbol

    cfg = task.config
    body = ScreenBody(
        filters   = cfg.get("filters",   {}),
        signal    = cfg.get("signal",    ""),
        order     = cfg.get("order",     "Ticker"),
        ascending = cfg.get("ascending", True),
        limit     = cfg.get("limit",     500),
    )

    loop = asyncio.get_event_loop()
    results = await asyncio.wait_for(
        loop.run_in_executor(None, lambda: _run_screen(body)),
        timeout=60.0,
    )

    wl_name = None
    if cfg.get("save_watchlist") and cfg.get("watchlist_name"):
        wl_name = cfg["watchlist_name"].strip()
        async with SessionLocal() as db:
            wl = Watchlist(name=wl_name)
            db.add(wl)
            await db.commit()
            await db.refresh(wl)
            for pos, item in enumerate(results):
                db.add(WatchlistSymbol(
                    watchlist_id=wl.id,
                    symbol=item["ticker"],
                    name=item.get("company") or item["ticker"],
                    position=pos,
                ))
            await db.commit()

    tickers = [r["ticker"] for r in results]
    return {
        "tickers":        tickers,
        "count":          len(tickers),
        "watchlist_name": wl_name,
    }


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

# ── task-types must be declared before /{task_id} to avoid routing ambiguity ──

@router.get("/task-types")
def get_task_types():
    """Return all available task types with labels and descriptions."""
    return all_task_types()


@router.get("")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    stmt = select(AgentTask).options(selectinload(AgentTask.next_task))
    rows = (await db.execute(stmt)).scalars().all()
    return [_row_to_dict(r) for r in rows]


@router.post("", status_code=201)
async def create_task(body: TaskBody, db: AsyncSession = Depends(get_db)):
    row = AgentTask(
        name=body.name,
        description=body.description,
        task_type=body.task_type,
        config=body.config,
        # chain + schedule set later via PUT /{id}/schedule
        next_task_id=None,
        enabled=False,
        created_at=_now_iso(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    await db.refresh(row, attribute_names=["next_task"])
    return _row_to_dict(row)


@router.get("/{task_id}")
async def get_task(task_id: int, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(AgentTask)
        .where(AgentTask.id == task_id)
        .options(selectinload(AgentTask.runs), selectinload(AgentTask.next_task))
    )
    row = (await db.execute(stmt)).scalar_one_or_none()
    if not row:
        raise HTTPException(404, "Task not found")
    return _row_to_dict(row, include_runs=True)


@router.put("/{task_id}")
async def update_task(task_id: int, body: TaskBody, db: AsyncSession = Depends(get_db)):
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")

    row.name        = body.name
    row.description = body.description
    row.task_type   = body.task_type
    row.config      = body.config
    # Note: enabled / schedule / chain fields are NOT touched here
    await db.commit()
    await db.refresh(row, attribute_names=["next_task"])
    return _row_to_dict(row)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")
    await db.delete(row)
    await db.commit()
    unschedule_task(task_id)


# ── Schedule sub-resource ─────────────────────────────────────────────────────

@router.put("/{task_id}/schedule")
async def set_schedule(task_id: int, body: ScheduleBody, db: AsyncSession = Depends(get_db)):
    """Set or replace the schedule (and optional chain) for a task."""
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")

    # Validate chain
    nid = body.next_task_id
    if nid is not None:
        if nid == task_id:
            raise HTTPException(400, "A task cannot chain to itself")
        if not await db.get(AgentTask, nid):
            raise HTTPException(400, "next_task_id does not exist")
        if await _has_cycle(db, task_id, nid):
            raise HTTPException(400, "Setting this chain would create a cycle")

    row.schedule_time = body.schedule_time
    row.frequency     = body.frequency
    row.day_of_week   = body.day_of_week  if body.frequency == "weekly"  else None
    row.day_of_month  = body.day_of_month if body.frequency == "monthly" else None
    row.next_task_id  = nid
    row.enabled       = True
    await db.commit()
    await db.refresh(row, attribute_names=["next_task"])
    schedule_task(row)
    return _row_to_dict(row)


@router.delete("/{task_id}/schedule", status_code=200)
async def remove_schedule(task_id: int, db: AsyncSession = Depends(get_db)):
    """Remove the schedule and chain from a task (task definition is kept)."""
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")

    row.enabled      = False
    row.next_task_id = None   # chain only makes sense when scheduled
    await db.commit()
    await db.refresh(row, attribute_names=["next_task"])
    unschedule_task(task_id)
    return _row_to_dict(row)


# ── Trigger + run history ─────────────────────────────────────────────────────

@router.post("/{task_id}/trigger", status_code=202)
async def trigger_task(task_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")
    asyncio.create_task(_execute_task(task_id))
    return {"status": "queued", "task_id": task_id}


@router.get("/{task_id}/runs")
async def list_runs(task_id: int, db: AsyncSession = Depends(get_db)):
    stmt = (
        select(AgentTaskRun)
        .where(AgentTaskRun.task_id == task_id)
        .order_by(AgentTaskRun.id.desc())
        .limit(50)
    )
    rows = (await db.execute(stmt)).scalars().all()
    return [_run_to_dict(r) for r in rows]
