"""
Agent task CRUD + trigger endpoint.

Tasks are stored in SQLite. A background APScheduler instance (managed by
the lifespan in main.py) actually runs them; this module just manages the
DB rows and re-schedules jobs whenever a task is created / updated / deleted.
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

from db import AgentTask, AgentTaskRun, get_db

logger = logging.getLogger(__name__)
router = APIRouter()

_ET = pytz.timezone("America/New_York")

# ---------------------------------------------------------------------------
# Pydantic schemas
# ---------------------------------------------------------------------------

class TaskBody(BaseModel):
    name:          str
    description:   str  = ""
    task_type:     str  = "screener"
    config:        dict = {}
    schedule_time: str  = "09:30"   # "HH:MM"
    frequency:     str  = "weekdays"  # daily | weekdays | weekly | monthly
    day_of_week:   int | None = None  # 0=Mon..6=Sun (weekly)
    day_of_month:  int | None = None  # 1-28 (monthly)
    enabled:       bool = True
    next_task_id:  int | None = None  # chain: run this task after self succeeds


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _row_to_dict(row: AgentTask, include_runs: bool = False) -> dict:
    d = {
        "id":              row.id,
        "name":            row.name,
        "description":     row.description,
        "task_type":       row.task_type,
        "config":          row.config or {},
        "schedule_time":   row.schedule_time,
        "frequency":       row.frequency,
        "day_of_week":     row.day_of_week,
        "day_of_month":    row.day_of_month,
        "enabled":         row.enabled,
        "created_at":      row.created_at,
        "last_run_at":     row.last_run_at,
        "last_run_status": row.last_run_status,
        "next_task_id":    row.next_task_id,
        "next_task_name":  row.next_task.name if row.next_task else None,
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
# Scheduler integration (set by main.py at startup)
# ---------------------------------------------------------------------------

_scheduler = None  # apscheduler.AsyncIOScheduler instance, injected by main.py


def set_scheduler(sched):
    global _scheduler
    _scheduler = sched


def _cron_kwargs(task: AgentTask) -> dict:
    """Return APScheduler cron kwargs for a task's schedule."""
    h, m = task.schedule_time.split(":")
    base = {"hour": int(h), "minute": int(m), "timezone": _ET}
    freq = task.frequency
    if freq == "daily":
        return base
    if freq == "weekdays":
        return {**base, "day_of_week": "mon-fri"}
    if freq == "weekly":
        dow = task.day_of_week or 0
        names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
        return {**base, "day_of_week": names[dow]}
    if freq == "monthly":
        dom = task.day_of_month or 1
        return {**base, "day": dom}
    return base


def _job_id(task_id: int) -> str:
    return f"agent_task_{task_id}"


def schedule_task(task: AgentTask):
    """Add or replace the APScheduler job for this task."""
    if _scheduler is None:
        return
    jid = _job_id(task.id)
    # Remove old job if present
    if _scheduler.get_job(jid):
        _scheduler.remove_job(jid)
    if not task.enabled:
        return
    cron_kw = _cron_kwargs(task)
    _scheduler.add_job(
        _execute_task,
        "cron",
        id=jid,
        args=[task.id],
        replace_existing=True,
        **cron_kw,
    )
    logger.info("Scheduled job %s  freq=%s  time=%s", jid, task.frequency, task.schedule_time)


def unschedule_task(task_id: int):
    if _scheduler is None:
        return
    jid = _job_id(task_id)
    if _scheduler.get_job(jid):
        _scheduler.remove_job(jid)


async def _has_cycle(db, start_id: int, next_id: int) -> bool:
    """Walk the next_task_id chain from next_id; return True if start_id appears."""
    visited = set()
    cur = next_id
    while cur is not None:
        if cur == start_id:
            return True
        if cur in visited:
            break  # existing cycle elsewhere — stop
        visited.add(cur)
        row = await db.get(AgentTask, cur)
        cur = row.next_task_id if row else None
    return False


# ---------------------------------------------------------------------------
# Task execution
# ---------------------------------------------------------------------------

async def _execute_task(task_id: int):
    """
    Run one agent task and record the result.
    Called by APScheduler (async mode) or the /trigger endpoint.
    """
    from db.engine import SessionLocal  # avoid circular at module load

    async with SessionLocal() as db:
        task = await db.get(AgentTask, task_id)
        if task is None:
            logger.warning("execute_task: task %d not found", task_id)
            return

        now = _now_iso()
        run = AgentTaskRun(
            task_id=task_id,
            started_at=now,
            status="running",
        )
        db.add(run)
        task.last_run_at = now
        task.last_run_status = "running"
        await db.commit()
        await db.refresh(run)
        run_id = run.id

    # ── Execute outside the DB session ──────────────────────────────────────
    output = None
    error  = None
    status = "success"

    try:
        if task.task_type == "screener":
            output = await _run_screener(task)
        else:
            raise ValueError(f"Unknown task_type: {task.task_type!r}")
    except Exception as exc:
        logger.exception("Agent task %d failed", task_id)
        error  = str(exc)
        status = "error"

    # ── Persist result ───────────────────────────────────────────────────────
    ended = _now_iso()
    next_id = None
    async with SessionLocal() as db:
        run = await db.get(AgentTaskRun, run_id)
        if run:
            run.ended_at = ended
            run.status   = status
            run.output   = output
            run.error    = error
        task = await db.get(AgentTask, task_id)
        if task:
            task.last_run_at     = ended
            task.last_run_status = status
            if status == "success":
                next_id = task.next_task_id
        await db.commit()

    # ── Fire chained task (outside DB session) ───────────────────────────────
    if next_id is not None:
        logger.info("Task %d succeeded — chaining to task %d", task_id, next_id)
        asyncio.create_task(_execute_task(next_id))


async def _run_screener(task: AgentTask) -> dict:
    """Run a screener config against a watchlist; return {passed, failed, total}."""
    from core.analysis import analyse   # lazy import
    from db.engine import SessionLocal
    from db.models import ScreenConfig, Watchlist

    cfg_id = task.config.get("screen_config_id")
    wl_id  = task.config.get("watchlist_id")

    async with SessionLocal() as db:
        screen_cfg = await db.get(ScreenConfig, cfg_id) if cfg_id else None
        wl         = await db.get(Watchlist, wl_id)     if wl_id  else None

    conditions = screen_cfg.conditions if screen_cfg else {}
    symbols    = [s.symbol for s in (wl.symbols if wl else [])]

    if not symbols:
        return {"passed": [], "failed": [], "total": 0, "note": "Empty watchlist"}

    loop    = asyncio.get_event_loop()
    passed  = []
    failed  = []

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


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("")
async def list_tasks(db: AsyncSession = Depends(get_db)):
    stmt = select(AgentTask).options(selectinload(AgentTask.next_task))
    rows = (await db.execute(stmt)).scalars().all()
    return [_row_to_dict(r) for r in rows]


@router.post("", status_code=201)
async def create_task(body: TaskBody, db: AsyncSession = Depends(get_db)):
    # Validate next_task_id exists (cycle detection skipped on create — no id yet)
    if body.next_task_id is not None:
        if not await db.get(AgentTask, body.next_task_id):
            raise HTTPException(400, "next_task_id does not exist")

    row = AgentTask(
        name=body.name,
        description=body.description,
        task_type=body.task_type,
        config=body.config,
        schedule_time=body.schedule_time,
        frequency=body.frequency,
        day_of_week=body.day_of_week,
        day_of_month=body.day_of_month,
        enabled=body.enabled,
        next_task_id=body.next_task_id,
        created_at=_now_iso(),
    )
    db.add(row)
    await db.commit()
    await db.refresh(row)
    # Eagerly load next_task for serialisation
    await db.refresh(row, attribute_names=["next_task"])
    schedule_task(row)
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

    # Validate next_task_id and guard against cycles / self-reference
    nid = body.next_task_id
    if nid is not None:
        if nid == task_id:
            raise HTTPException(400, "A task cannot chain to itself")
        if not await db.get(AgentTask, nid):
            raise HTTPException(400, "next_task_id does not exist")
        if await _has_cycle(db, task_id, nid):
            raise HTTPException(400, "Setting this chain would create a cycle")

    row.name          = body.name
    row.description   = body.description
    row.task_type     = body.task_type
    row.config        = body.config
    row.schedule_time = body.schedule_time
    row.frequency     = body.frequency
    row.day_of_week   = body.day_of_week
    row.day_of_month  = body.day_of_month
    row.enabled       = body.enabled
    row.next_task_id  = nid
    await db.commit()
    await db.refresh(row, attribute_names=["next_task"])
    schedule_task(row)
    return _row_to_dict(row)


@router.delete("/{task_id}", status_code=204)
async def delete_task(task_id: int, db: AsyncSession = Depends(get_db)):
    row = await db.get(AgentTask, task_id)
    if not row:
        raise HTTPException(404, "Task not found")
    await db.delete(row)
    await db.commit()
    unschedule_task(task_id)


@router.post("/{task_id}/trigger", status_code=202)
async def trigger_task(task_id: int, db: AsyncSession = Depends(get_db)):
    """Immediately queue the task for execution (async, returns 202)."""
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
