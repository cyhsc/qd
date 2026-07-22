import { useState, useEffect, useCallback, useRef } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────

const FREQ_OPTIONS = [
  { value: 'once',     label: 'Run Once (one-time)' },
  { value: 'daily',    label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { value: 'weekly',   label: 'Weekly' },
  { value: 'monthly',  label: 'Monthly' },
]

const DOW_OPTIONS = [
  { value: 0, label: 'Monday' },
  { value: 1, label: 'Tuesday' },
  { value: 2, label: 'Wednesday' },
  { value: 3, label: 'Thursday' },
  { value: 4, label: 'Friday' },
  { value: 5, label: 'Saturday' },
  { value: 6, label: 'Sunday' },
]

const STATUS_COLOR = {
  success: 'var(--green)',
  error:   'var(--red)',
  running: '#f59e0b',
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDatetime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function scheduleLabel(schedule) {
  if (!schedule) return null
  if (schedule.frequency === 'once') {
    // schedule_time is a full "YYYY-MM-DDTHH:MM" string
    const d = new Date(schedule.schedule_time)
    const label = isNaN(d) ? schedule.schedule_time : d.toLocaleString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
    return `Once at ${label} PT`
  }
  const freq = FREQ_OPTIONS.find(f => f.value === schedule.frequency)?.label ?? schedule.frequency
  if (schedule.frequency === 'weekly') {
    const dow = DOW_OPTIONS.find(d => d.value === schedule.day_of_week)?.label ?? ''
    return `${freq} on ${dow} @ ${schedule.schedule_time} PT`
  }
  if (schedule.frequency === 'monthly') {
    return `${freq} on day ${schedule.day_of_month ?? 1} @ ${schedule.schedule_time} PT`
  }
  return `${freq} @ ${schedule.schedule_time} PT`
}

function emptyTaskForm() {
  return { name: '', description: '', task_type: 'screener', config: {} }
}

function emptyScheduleForm() {
  return { schedule_time: '09:30', frequency: 'weekdays', day_of_week: 0, day_of_month: 1, next_task_id: null }
}

// ── Shared input style ────────────────────────────────────────────────────────

const inputStyle = {
  width: '100%', height: '32px', padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: '5px', color: 'var(--text-primary)', fontSize: '12px',
  outline: 'none', boxSizing: 'border-box',
}

// ── Small UI helpers ──────────────────────────────────────────────────────────

function FormField({ label, children }) {
  return (
    <div>
      <div style={{
        fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
        marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.06em',
      }}>{label}</div>
      {children}
    </div>
  )
}

function SectionLabel({ children }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '10px',
    }}>{children}</div>
  )
}

function Badge({ children, color = 'var(--blue)', bg = 'rgba(41,98,255,0.1)' }) {
  return (
    <span style={{
      fontSize: '10px', fontWeight: 600, padding: '2px 7px', borderRadius: '3px',
      color, background: bg, border: `1px solid ${color}30`,
    }}>{children}</span>
  )
}

// ── AgentPanel ────────────────────────────────────────────────────────────────

export function AgentPanel({ watchlists, screenConfigs, onNewWatchlist, active }) {
  const [tasks,        setTasks]        = useState([])
  const [taskTypes,    setTaskTypes]    = useState([])      // [{key, label, description}]
  const [selectedId,   setSelectedId]   = useState(null)
  const [panel,        setPanel]        = useState('detail') // 'detail' | 'create' | 'edit'
  const [editingTask,  setEditingTask]  = useState(null)
  const [triggering,   setTriggering]   = useState(null)
  const pollRef = useRef(null)
  const prevRunAtRef = useRef({})   // task.id -> last_run_at seen on the previous poll

  // ── Load task types (once) ──────────────────────────────────────────────────

  useEffect(() => {
    fetch('/api/agent-tasks/task-types')
      .then(r => r.json())
      .then(setTaskTypes)
      .catch(() => {})
  }, [])

  // ── Load / poll tasks ───────────────────────────────────────────────────────

  const loadTasks = useCallback(async () => {
    try {
      const res  = await fetch('/api/agent-tasks')
      const data = await res.json()
      setTasks(data)

      // When a task that saves a watchlist finishes a run, refresh the
      // watchlist sidebar so the new list shows up without a manual browser
      // reload. Both manual (/trigger) and scheduled runs surface here as
      // last_run_at advancing with a success status. Skip the first sighting
      // of each task (prev === undefined) so existing runs don't refire.
      let refreshWatchlists = false
      const seen = prevRunAtRef.current
      for (const t of data) {
        const prev = seen[t.id]
        seen[t.id] = t.last_run_at
        const producesWatchlist = t.task_type === 'finviz_screen' && t.config?.save_watchlist
        if (producesWatchlist && t.last_run_status === 'success'
            && t.last_run_at && prev !== undefined && t.last_run_at !== prev) {
          refreshWatchlists = true
        }
      }
      if (refreshWatchlists && onNewWatchlist) onNewWatchlist()

      return data
    } catch { return null }
  }, [onNewWatchlist])

  useEffect(() => {
    if (!active) return
    loadTasks()
    pollRef.current = setInterval(loadTasks, 10_000)
    return () => clearInterval(pollRef.current)
  }, [active, loadTasks])

  // ── Actions ─────────────────────────────────────────────────────────────────

  const handleDelete = async (task) => {
    if (!confirm(`Delete task "${task.name}"?`)) return
    await fetch(`/api/agent-tasks/${task.id}`, { method: 'DELETE' })
    setTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedId === task.id) { setSelectedId(null); setPanel('detail') }
  }

  const handleTrigger = async (task) => {
    const beforeRunAt = task.last_run_at
    setTriggering(task.id)
    try {
      await fetch(`/api/agent-tasks/${task.id}/trigger`, { method: 'POST' })
    } finally {
      setTriggering(null)
      // The run executes in the background and can take up to ~60s (finviz
      // screens). Poll until it finishes so the run history — and any saved
      // watchlist, refreshed inside loadTasks() — update on their own rather
      // than only after a manual browser reload.
      let elapsed = 0
      let sawRunning = false
      const poll = setInterval(async () => {
        elapsed += 2500
        const data = await loadTasks()
        const t = data?.find(x => x.id === task.id)
        if (t?.last_run_status === 'running') sawRunning = true
        const finished = t && t.last_run_status !== 'running'
          && (sawRunning || t.last_run_at !== beforeRunAt)
        if (finished || elapsed >= 90000) clearInterval(poll)
      }, 2500)
    }
  }

  const handleTaskSaved = (saved, wasNew) => {
    setTasks(prev => wasNew ? [...prev, saved] : prev.map(t => t.id === saved.id ? saved : t))
    setSelectedId(saved.id)
    setPanel('detail')
    setEditingTask(null)
  }

  const handleScheduleChanged = (updated) => {
    setTasks(prev => prev.map(t => t.id === updated.id ? updated : t))
  }

  const openCreate = () => {
    setEditingTask(null)
    setPanel('create')
  }

  const openEdit = (task) => {
    setEditingTask(task)
    setPanel('edit')
  }

  const closeForm = () => {
    setPanel('detail')
    setEditingTask(null)
  }

  const selectedTask = tasks.find(t => t.id === selectedId) ?? null

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', height: '100%', overflow: 'hidden', background: 'var(--bg-app)' }}>

      {/* ── Sidebar ─────────────────────────────────────────────────────────── */}
      <div style={{
        width: '300px', flexShrink: 0, borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          padding: '14px 16px', borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
        }}>
          <span style={{ fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' }}>Tasks</span>
          <button
            onClick={openCreate}
            style={{
              height: '28px', padding: '0 12px', fontSize: '12px', fontWeight: 600,
              background: 'var(--blue)', border: 'none', borderRadius: '5px',
              color: '#fff', cursor: 'pointer',
            }}
          >+ New Task</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {tasks.length === 0 && (
            <div style={{
              padding: '24px 16px', color: 'var(--text-muted)',
              fontSize: '12px', textAlign: 'center',
            }}>
              No tasks yet. Click "+ New Task" to add one.
            </div>
          )}
          {tasks.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              selected={selectedId === task.id}
              triggering={triggering === task.id}
              taskTypes={taskTypes}
              onSelect={() => { setSelectedId(task.id); setPanel('detail') }}
              onRun={() => handleTrigger(task)}
              onEdit={() => { setSelectedId(task.id); openEdit(task) }}
              onDelete={() => handleDelete(task)}
            />
          ))}
        </div>
      </div>

      {/* ── Right panel ─────────────────────────────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {(panel === 'create' || panel === 'edit') ? (
          <TaskForm
            key={editingTask?.id ?? 'new'}
            editingTask={editingTask}
            taskTypes={taskTypes}
            watchlists={watchlists}
            screenConfigs={screenConfigs}
            onSaved={handleTaskSaved}
            onCancel={closeForm}
          />
        ) : selectedTask ? (
          <TaskDetail
            task={selectedTask}
            allTasks={tasks}
            taskTypes={taskTypes}
            onEdit={() => openEdit(selectedTask)}
            onDelete={() => handleDelete(selectedTask)}
            onRun={() => handleTrigger(selectedTask)}
            onScheduleChanged={handleScheduleChanged}
            triggering={triggering === selectedTask.id}
          />
        ) : (
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            height: '100%', color: 'var(--text-muted)', fontSize: '13px',
          }}>
            Select a task to see details, or create a new one.
          </div>
        )}
      </div>
    </div>
  )
}

// ── TaskCard ──────────────────────────────────────────────────────────────────

function TaskCard({ task, selected, triggering, taskTypes, onSelect, onRun, onEdit, onDelete }) {
  const typeLabel = taskTypes.find(t => t.key === task.task_type)?.label ?? task.task_type

  return (
    <div
      onClick={onSelect}
      style={{
        padding: '11px 14px', cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
        background: selected ? 'var(--bg-raised)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Name + action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' }}>
        <span style={{ fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {task.name}
        </span>
        <div style={{ display: 'flex', gap: '5px', flexShrink: 0 }} onClick={e => e.stopPropagation()}>
          <SmallBtn
            onClick={onRun}
            disabled={triggering}
            color="var(--blue)"
            title="Run now"
          >▶</SmallBtn>
          <SmallBtn onClick={onEdit} color="var(--text-muted)" title="Edit task">✎</SmallBtn>
          <SmallBtn onClick={onDelete} color="var(--red)" title="Delete task">✕</SmallBtn>
        </div>
      </div>

      {/* Type badge + schedule badge */}
      <div style={{ display: 'flex', gap: '5px', flexWrap: 'wrap', marginBottom: '4px' }}>
        <Badge color="var(--text-muted)" bg="rgba(120,123,134,0.1)">{typeLabel}</Badge>
        {task.is_scheduled ? (
          <Badge color="var(--green)" bg="rgba(38,166,154,0.1)">
            🕐 {scheduleLabel(task.schedule)}
          </Badge>
        ) : (
          <Badge color="var(--text-muted)" bg="transparent">unscheduled</Badge>
        )}
      </div>

      {/* Chain */}
      {task.next_task_name && (
        <div style={{ fontSize: '11px', color: 'var(--blue)', marginBottom: '3px' }}>
          → {task.next_task_name}
        </div>
      )}

      {/* Last run */}
      {task.last_run_status && (
        <div style={{ fontSize: '11px', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '4px' }}>
          <span style={{
            width: '6px', height: '6px', borderRadius: '50%', display: 'inline-block',
            background: STATUS_COLOR[task.last_run_status] ?? 'var(--text-muted)', flexShrink: 0,
          }} />
          {task.last_run_status} · {fmtDatetime(task.last_run_at)}
        </div>
      )}
    </div>
  )
}

function SmallBtn({ children, onClick, disabled, color, title }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        width: '22px', height: '22px', padding: 0, fontSize: '12px',
        background: 'var(--bg-app)', border: '1px solid var(--border)',
        borderRadius: '4px', color, cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
      }}
    >{children}</button>
  )
}

// ── TaskDetail ────────────────────────────────────────────────────────────────

function TaskDetail({ task, allTasks, taskTypes, onEdit, onDelete, onRun, onScheduleChanged, triggering }) {
  const [runs,         setRuns]         = useState([])
  const [runsLoading,  setRunsLoading]  = useState(false)
  const typeLabel = taskTypes.find(t => t.key === task.task_type)?.label ?? task.task_type

  // Load run history whenever the task changes or re-renders
  useEffect(() => {
    setRunsLoading(true)
    fetch(`/api/agent-tasks/${task.id}/runs`)
      .then(r => r.json())
      .then(setRuns)
      .catch(() => setRuns([]))
      .finally(() => setRunsLoading(false))
  }, [task.id, task.last_run_at])  // re-fetch when last_run_at changes

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '15px', fontWeight: 700 }}>{task.name}</span>
            <Badge color="var(--text-muted)" bg="rgba(120,123,134,0.1)">{typeLabel}</Badge>
            {task.next_task_name && (
              <span style={{ fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ color: 'var(--text-muted)' }}>→</span>
                <Badge>{task.next_task_name}</Badge>
              </span>
            )}
          </div>
          {task.description && (
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{task.description}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
          <ActionBtn onClick={onRun} disabled={triggering} blue>
            {triggering ? '…' : '▶ Run'}
          </ActionBtn>
          <ActionBtn onClick={onEdit}>Edit</ActionBtn>
          <ActionBtn onClick={onDelete} danger>Delete</ActionBtn>
        </div>
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '20px' }}>

        {/* Schedule section */}
        <ScheduleSection task={task} allTasks={allTasks} onChanged={onScheduleChanged} />

        {/* Run history */}
        <div>
          <SectionLabel>Run History</SectionLabel>
          {runsLoading && <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>}
          {!runsLoading && runs.length === 0 && (
            <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No runs yet.</div>
          )}
          {runs.map(run => <RunCard key={run.id} run={run} />)}
        </div>
      </div>
    </div>
  )
}

function ActionBtn({ children, onClick, disabled, blue, danger }) {
  const bg = blue ? 'var(--blue)' : danger ? 'rgba(239,83,80,0.08)' : 'var(--bg-raised)'
  const border = blue ? 'none' : danger ? '1px solid rgba(239,83,80,0.3)' : '1px solid var(--border)'
  const color = blue ? '#fff' : danger ? 'var(--red)' : 'var(--text-primary)'
  return (
    <button onClick={onClick} disabled={disabled} style={{
      height: '28px', padding: '0 12px', fontSize: '12px', fontWeight: 600,
      background: bg, border, borderRadius: '5px', color, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.6 : 1,
    }}>{children}</button>
  )
}

// ── ScheduleSection ───────────────────────────────────────────────────────────

function ScheduleSection({ task, allTasks, onChanged }) {
  const [editing,  setEditing]  = useState(false)
  const [form,     setForm]     = useState(emptyScheduleForm())
  const [saving,   setSaving]   = useState(false)
  const [error,    setError]    = useState(null)

  const chainCandidates = (allTasks ?? []).filter(t => t.id !== task.id)

  // Pre-fill when editing existing schedule
  const startEdit = () => {
    if (task.schedule) {
      setForm({
        schedule_time: task.schedule.schedule_time,
        frequency:     task.schedule.frequency,
        day_of_week:   task.schedule.day_of_week ?? 0,
        day_of_month:  task.schedule.day_of_month ?? 1,
        next_task_id:  task.next_task_id ?? null,
      })
    } else {
      setForm(emptyScheduleForm())
    }
    setEditing(true)
    setError(null)
  }

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const handleSave = async (e) => {
    e.preventDefault()
    setSaving(true); setError(null)
    try {
      const res = await fetch(`/api/agent-tasks/${task.id}/schedule`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const updated = await res.json()
      onChanged(updated)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleRemove = async () => {
    if (!confirm('Remove the schedule? The task will still exist.')) return
    const res = await fetch(`/api/agent-tasks/${task.id}/schedule`, { method: 'DELETE' })
    if (res.ok) {
      const updated = await res.json()
      onChanged(updated)
      setEditing(false)
    }
  }

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: '7px',
      overflow: 'hidden', flexShrink: 0,
    }}>
      {/* Schedule header row */}
      <div style={{
        padding: '10px 14px', background: 'var(--bg-raised)',
        display: 'flex', alignItems: 'center', gap: '10px',
      }}>
        <span style={{ fontSize: '12px', fontWeight: 700, color: 'var(--text-primary)', flex: 1 }}>
          Schedule
        </span>
        {task.is_scheduled ? (
          <>
            <span style={{ fontSize: '12px', color: 'var(--green)' }}>
              🕐 {scheduleLabel(task.schedule)}
            </span>
            {!editing && (
              <>
                <ActionBtn onClick={startEdit}>Edit</ActionBtn>
                <ActionBtn onClick={handleRemove} danger>Remove</ActionBtn>
              </>
            )}
          </>
        ) : (
          <>
            <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Not scheduled</span>
            {!editing && <ActionBtn onClick={startEdit} blue>Set Schedule</ActionBtn>}
          </>
        )}
      </div>

      {/* Schedule form (expanded) */}
      {editing && (
        <form onSubmit={handleSave} style={{ padding: '14px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {error && (
            <div style={{
              padding: '8px 12px', borderRadius: '5px',
              background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
              color: 'var(--red)', fontSize: '12px',
            }}>{error}</div>
          )}
          <FormField label="Frequency">
            <select
              value={form.frequency}
              onChange={e => setF('frequency', e.target.value)}
              style={inputStyle}
            >
              {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </FormField>

          {form.frequency === 'once' ? (
            <FormField label="Run At (Pacific Time)">
              <input
                type="datetime-local"
                value={form.schedule_time}
                onChange={e => setF('schedule_time', e.target.value)}
                style={inputStyle}
              />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
                The task will run once at this time and then unschedule itself.
              </div>
            </FormField>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
              <FormField label="Run Time (PT)">
                <input
                  type="time"
                  value={form.schedule_time}
                  onChange={e => setF('schedule_time', e.target.value)}
                  style={inputStyle}
                />
              </FormField>
              {form.frequency === 'weekly' && (
                <FormField label="Day of Week">
                  <select value={form.day_of_week} onChange={e => setF('day_of_week', Number(e.target.value))} style={inputStyle}>
                    {DOW_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
                  </select>
                </FormField>
              )}
              {form.frequency === 'monthly' && (
                <FormField label="Day of Month">
                  <input
                    type="number" min={1} max={28}
                    value={form.day_of_month}
                    onChange={e => setF('day_of_month', Math.max(1, Math.min(28, Number(e.target.value))))}
                    style={inputStyle}
                  />
                </FormField>
              )}
            </div>
          )}
          {/* Chain */}
          <FormField label="Then run → (on success)">
            <select
              value={form.next_task_id ?? ''}
              onChange={e => setF('next_task_id', e.target.value ? Number(e.target.value) : null)}
              style={inputStyle}
            >
              <option value="">— None —</option>
              {chainCandidates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
              Runs immediately after this task succeeds. Cycles are rejected.
            </div>
          </FormField>

          <div style={{ display: 'flex', gap: '8px' }}>
            <ActionBtn blue>{saving ? 'Saving…' : 'Save Schedule'}</ActionBtn>
            <ActionBtn onClick={() => setEditing(false)}>Cancel</ActionBtn>
          </div>
        </form>
      )}
    </div>
  )
}

// ── TaskForm ──────────────────────────────────────────────────────────────────

function TaskForm({ editingTask, taskTypes, watchlists, screenConfigs, onSaved, onCancel }) {
  const isEditing = !!editingTask
  const [form,   setForm]   = useState(() =>
    isEditing
      ? { name: editingTask.name, description: editingTask.description, task_type: editingTask.task_type, config: editingTask.config ?? {} }
      : emptyTaskForm()
  )
  const [saving, setSaving] = useState(false)
  const [error,  setError]  = useState(null)

  const setF    = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const setConf = (k, v) => setForm(f => ({ ...f, config: { ...f.config, [k]: v } }))

  // When task_type changes, reset config
  const handleTypeChange = (newType) => {
    setForm(f => ({ ...f, task_type: newType, config: {} }))
  }

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true); setError(null)
    try {
      const url    = isEditing ? `/api/agent-tasks/${editingTask.id}` : '/api/agent-tasks'
      const method = isEditing ? 'PUT' : 'POST'
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const saved = await res.json()
      onSaved(saved, !isEditing)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        padding: '14px 20px', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0,
      }}>
        <span style={{ fontSize: '14px', fontWeight: 700 }}>
          {isEditing ? 'Edit Task' : 'New Task'}
        </span>
        <button onClick={onCancel} style={{
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--text-muted)', fontSize: '20px', lineHeight: 1,
        }}>×</button>
      </div>

      {/* Body */}
      <form onSubmit={handleSave} style={{
        flex: 1, overflowY: 'auto', padding: '20px',
        display: 'flex', flexDirection: 'column', gap: '16px',
      }}>
        {error && (
          <div style={{
            padding: '10px 14px', borderRadius: '6px',
            background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
            color: 'var(--red)', fontSize: '12px',
          }}>{error}</div>
        )}

        <FormField label="Task Name">
          <input
            autoFocus
            value={form.name}
            onChange={e => setF('name', e.target.value)}
            placeholder="e.g. Morning screener"
            style={inputStyle}
          />
        </FormField>

        <FormField label="Description (optional)">
          <textarea
            value={form.description}
            onChange={e => setF('description', e.target.value)}
            placeholder="What does this task do?"
            rows={2}
            style={{ ...inputStyle, height: 'auto', resize: 'vertical', padding: '6px 10px', lineHeight: '1.5' }}
          />
        </FormField>

        <FormField label="Task Type">
          <select value={form.task_type} onChange={e => handleTypeChange(e.target.value)} style={inputStyle}>
            {taskTypes.length === 0
              ? <option value="screener">Screener Run</option>
              : taskTypes.map(t => <option key={t.key} value={t.key}>{t.label}</option>)
            }
          </select>
          {taskTypes.length > 0 && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              {taskTypes.find(t => t.key === form.task_type)?.description}
            </div>
          )}
        </FormField>

        {/* Dynamic config per task type */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
          <SectionLabel>Task Configuration</SectionLabel>
          {form.task_type === 'screener' && (
            <ScreenerConfig
              config={form.config}
              onChange={setConf}
              watchlists={watchlists}
              screenConfigs={screenConfigs}
            />
          )}
          {form.task_type === 'finviz_screen' && (
            <FinvizConfig config={form.config} onChange={setConf} onReplace={cfg => setF('config', cfg)} />
          )}
        </div>

        <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
          <ActionBtn blue>{saving ? 'Saving…' : isEditing ? 'Update Task' : 'Create Task'}</ActionBtn>
          <ActionBtn onClick={onCancel}>Cancel</ActionBtn>
        </div>
      </form>
    </div>
  )
}

// ── ScreenerConfig ────────────────────────────────────────────────────────────

function ScreenerConfig({ config, onChange, watchlists, screenConfigs }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <FormField label="Screener Config">
        <select
          value={config.screen_config_id ?? ''}
          onChange={e => onChange('screen_config_id', e.target.value ? Number(e.target.value) : null)}
          style={inputStyle}
        >
          <option value="">— None (all conditions) —</option>
          {screenConfigs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </FormField>
      <FormField label="Watchlist">
        <select
          value={config.watchlist_id ?? ''}
          onChange={e => onChange('watchlist_id', e.target.value ? Number(e.target.value) : null)}
          style={inputStyle}
        >
          <option value="">— None —</option>
          {watchlists.map(wl => <option key={wl.id} value={wl.id}>{wl.name}</option>)}
        </select>
      </FormField>
    </div>
  )
}

// ── FinvizConfig ──────────────────────────────────────────────────────────────

function FinvizConfig({ config, onChange, onReplace }) {
  const [meta,     setMeta]     = useState(null)  // { filters, signals, order_by }
  const [loading,  setLoading]  = useState(true)
  const [filterErr,setFilterErr] = useState(null)

  // Local filter rows: [{key, value}]
  const [rows, setRows] = useState(() => {
    const cfg = config.filters ?? {}
    return Object.entries(cfg).map(([key, value]) => ({ key, value }))
  })

  // Fetch filter metadata once
  useEffect(() => {
    fetch('/api/finviz/filters')
      .then(r => {
        if (!r.ok) throw new Error(`Backend returned ${r.status} — is it running?`)
        return r.json()
      })
      .then(data => { setMeta(data); setLoading(false) })
      .catch(e => {
        const msg = e.message.includes('fetch') || e.message.includes('NetworkError')
          ? 'Could not connect to backend — make sure it is running on port 8888.'
          : e.message
        setFilterErr(msg); setLoading(false)
      })
  }, [])

  // Sync rows → config.filters whenever rows change
  useEffect(() => {
    const dict = {}
    for (const r of rows) {
      if (r.key) dict[r.key] = r.value
    }
    onChange('filters', dict)
  }, [rows])  // eslint-disable-line react-hooks/exhaustive-deps

  const addRow = () => setRows(rs => [...rs, { key: '', value: '' }])
  const removeRow = (i) => setRows(rs => rs.filter((_, idx) => idx !== i))
  const updateRow = (i, field, val) =>
    setRows(rs => rs.map((r, idx) => idx === i ? { ...r, [field]: val, ...(field === 'key' ? { value: '' } : {}) } : r))

  const filterKeys = meta ? Object.keys(meta.filters) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
      {/* Filters */}
      <FormField label="Filters">
        {loading && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Loading filter options…</div>}
        {filterErr && (
          <div style={{ fontSize: '12px', color: 'var(--red)', marginBottom: '6px' }}>{filterErr}</div>
        )}
        {!loading && !filterErr && (
          <>
            {rows.map((row, i) => {
              const valOptions = row.key && meta?.filters[row.key] ? meta.filters[row.key] : []
              return (
                <div key={i} style={{ display: 'flex', gap: '6px', marginBottom: '6px', alignItems: 'center' }}>
                  <select
                    value={row.key}
                    onChange={e => updateRow(i, 'key', e.target.value)}
                    style={{ ...inputStyle, flex: '2' }}
                  >
                    <option value="">— Filter key —</option>
                    {filterKeys.map(k => <option key={k} value={k}>{k}</option>)}
                  </select>
                  <select
                    value={row.value}
                    onChange={e => updateRow(i, 'value', e.target.value)}
                    style={{ ...inputStyle, flex: '2' }}
                    disabled={!row.key}
                  >
                    <option value="">— Any —</option>
                    {valOptions.map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                  <button
                    type="button"
                    onClick={() => removeRow(i)}
                    style={{
                      width: '28px', height: '32px', padding: 0, flexShrink: 0,
                      background: 'none', border: '1px solid var(--border)',
                      borderRadius: '5px', color: 'var(--red)', cursor: 'pointer', fontSize: '14px',
                    }}
                  >✕</button>
                </div>
              )
            })}
            <button
              type="button"
              onClick={addRow}
              style={{
                height: '28px', padding: '0 12px', fontSize: '11px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '5px', color: 'var(--text-secondary)', cursor: 'pointer',
              }}
            >+ Add Filter</button>
          </>
        )}
      </FormField>

      {/* Signal — always visible; options populate once meta loads */}
      <FormField label="Signal (optional)">
        <select
          value={config.signal ?? ''}
          onChange={e => onChange('signal', e.target.value)}
          style={inputStyle}
          disabled={loading || !meta}
        >
          <option value="">— None —</option>
          {(meta?.signals ?? []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        {!loading && !meta && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '3px' }}>
            Unavailable — start the backend to load options.
          </div>
        )}
      </FormField>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
        {/* Order by */}
        <FormField label="Sort By">
          <select
            value={config.order ?? 'Ticker'}
            onChange={e => onChange('order', e.target.value)}
            style={inputStyle}
            disabled={loading || !meta}
          >
            {(meta?.order_by ?? ['Ticker']).map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        </FormField>

        {/* Limit */}
        <FormField label="Max Results">
          <input
            type="number" min={1} max={5000}
            value={config.limit ?? 500}
            onChange={e => onChange('limit', Math.max(1, Math.min(5000, Number(e.target.value))))}
            style={inputStyle}
          />
        </FormField>
      </div>

      {/* Ascending toggle */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={config.ascending ?? true}
          onChange={e => onChange('ascending', e.target.checked)}
          style={{ width: '15px', height: '15px' }}
        />
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Sort ascending</span>
      </label>

      {/* Save as watchlist */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: '14px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '8px' }}>
          <input
            type="checkbox"
            checked={config.save_watchlist ?? false}
            onChange={e => onChange('save_watchlist', e.target.checked)}
            style={{ width: '15px', height: '15px' }}
          />
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
            Save results as a new watchlist after each run
          </span>
        </label>
        {config.save_watchlist && (
          <FormField label="Watchlist Name">
            <input
              value={config.watchlist_name ?? ''}
              onChange={e => onChange('watchlist_name', e.target.value)}
              placeholder="e.g. Finviz Daily Picks"
              style={inputStyle}
            />
          </FormField>
        )}
      </div>
    </div>
  )
}

// ── RunCard ───────────────────────────────────────────────────────────────────

function RunCard({ run }) {
  const [expanded, setExpanded] = useState(false)
  const dur = run.ended_at && run.started_at
    ? ((new Date(run.ended_at) - new Date(run.started_at)) / 1000).toFixed(1) + 's'
    : run.status === 'running' ? 'running…' : '—'

  const out = run.output
  // Screener output has passed/failed; finviz output has tickers/count
  const isScreener = out && Array.isArray(out.passed)
  const isFinviz   = out && Array.isArray(out.tickers)

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: '6px',
      marginBottom: '8px', overflow: 'hidden', background: 'var(--bg-raised)',
    }}>
      <div
        onClick={() => setExpanded(e => !e)}
        style={{
          display: 'flex', alignItems: 'center', gap: '10px',
          padding: '10px 12px', cursor: 'pointer',
        }}
      >
        <span style={{
          width: '8px', height: '8px', borderRadius: '50%', flexShrink: 0,
          background: STATUS_COLOR[run.status] ?? 'var(--text-muted)',
        }} />
        <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {run.status.toUpperCase()}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
          {fmtDatetime(run.started_at)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{dur}</span>
        {isScreener && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {out.passed.length}/{out.total} passed
          </span>
        )}
        {isFinviz && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {out.count} symbols
          </span>
        )}
        <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>{expanded ? '▲' : '▼'}</span>
      </div>

      {expanded && (
        <div style={{ padding: '0 12px 12px', borderTop: '1px solid var(--border)' }}>
          {run.error && (
            <pre style={{
              margin: '10px 0 0', padding: '8px', borderRadius: '4px',
              background: 'rgba(239,83,80,0.08)', border: '1px solid rgba(239,83,80,0.2)',
              color: 'var(--red)', fontSize: '11px', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}>{run.error}</pre>
          )}
          {isScreener && (
            <div style={{ marginTop: '10px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {out.passed.length > 0 && <SymbolList label="Passed" symbols={out.passed} color="var(--green)" />}
              {out.failed.length > 0 && <SymbolList label="Failed / Skipped" symbols={out.failed} color="var(--red)" />}
              {!out.passed.length && !out.failed.length && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{out.note ?? 'No output'}</span>
              )}
            </div>
          )}
          {isFinviz && (
            <div style={{ marginTop: '10px' }}>
              {out.watchlist_name && (
                <div style={{ fontSize: '11px', color: 'var(--green)', marginBottom: '6px' }}>
                  ✓ Saved to watchlist "{out.watchlist_name}"
                </div>
              )}
              <SymbolList label="Symbols" symbols={out.tickers} color="var(--blue)" />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SymbolList({ label, symbols, color }) {
  const isGreen = color === 'var(--green)'
  const isBlue  = color === 'var(--blue)'
  return (
    <div>
      <div style={{
        fontSize: '10px', fontWeight: 700, color, marginBottom: '4px', textTransform: 'uppercase',
      }}>{label} ({symbols.length})</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {symbols.map(sym => (
          <span key={sym} style={{
            fontSize: '10px', fontWeight: 600, padding: '2px 6px', borderRadius: '3px',
            background: isGreen ? 'rgba(38,166,154,0.1)' : isBlue ? 'rgba(41,98,255,0.1)' : 'rgba(239,83,80,0.1)',
            color,
          }}>{sym}</span>
        ))}
      </div>
    </div>
  )
}
