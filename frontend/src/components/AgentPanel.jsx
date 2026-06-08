import { useState, useEffect, useCallback, useRef } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────

const FREQ_OPTIONS = [
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

const TASK_TYPES = [
  { value: 'screener', label: 'Screener Run' },
]

const STATUS_COLOR = {
  success: 'var(--green)',
  error:   'var(--red)',
  running: '#f59e0b',
}

function fmtDatetime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('en-US', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

function scheduleLabel(task) {
  const freq = FREQ_OPTIONS.find(f => f.value === task.frequency)?.label ?? task.frequency
  if (task.frequency === 'weekly') {
    const dow = DOW_OPTIONS.find(d => d.value === task.day_of_week)?.label ?? ''
    return `${freq} on ${dow} @ ${task.schedule_time} ET`
  }
  if (task.frequency === 'monthly') {
    return `${freq} on day ${task.day_of_month ?? 1} @ ${task.schedule_time} ET`
  }
  return `${freq} @ ${task.schedule_time} ET`
}

// ── Default empty form ────────────────────────────────────────────────────────

function emptyForm() {
  return {
    name:          '',
    description:   '',
    task_type:     'screener',
    config:        { screen_config_id: null, watchlist_id: null },
    schedule_time: '09:30',
    frequency:     'weekdays',
    day_of_week:   0,
    day_of_month:  1,
    enabled:       true,
    next_task_id:  null,
  }
}

// ── AgentPanel ────────────────────────────────────────────────────────────────

export function AgentPanel({ watchlists, screenConfigs }) {
  const [tasks,          setTasks]          = useState([])
  const [selectedId,     setSelectedId]     = useState(null)
  const [selectedRuns,   setSelectedRuns]   = useState([])
  const [runsLoading,    setRunsLoading]    = useState(false)
  const [showForm,       setShowForm]       = useState(false)
  const [editingTask,    setEditingTask]    = useState(null)  // null = create, obj = edit
  const [form,           setForm]           = useState(emptyForm())
  const [saving,         setSaving]         = useState(false)
  const [triggering,     setTriggering]     = useState(null)
  const [error,          setError]          = useState(null)
  const pollRef          = useRef(null)

  // ── Load tasks ──────────────────────────────────────────────────────────────

  const loadTasks = useCallback(async () => {
    try {
      const res  = await fetch('/api/agent-tasks')
      const data = await res.json()
      setTasks(data)
    } catch { /* silently */ }
  }, [])

  useEffect(() => {
    loadTasks()
    // Poll every 10 s to pick up status changes from the scheduler
    pollRef.current = setInterval(loadTasks, 10_000)
    return () => clearInterval(pollRef.current)
  }, [loadTasks])

  // ── Load runs for selected task ─────────────────────────────────────────────

  useEffect(() => {
    if (selectedId == null) { setSelectedRuns([]); return }
    setRunsLoading(true)
    fetch(`/api/agent-tasks/${selectedId}/runs`)
      .then(r => r.json())
      .then(setSelectedRuns)
      .catch(() => setSelectedRuns([]))
      .finally(() => setRunsLoading(false))

    // Refresh runs whenever the task list updates (picks up new run started_at)
  }, [selectedId, tasks])

  // ── Form helpers ────────────────────────────────────────────────────────────

  const openCreate = () => {
    setEditingTask(null)
    setForm(emptyForm())
    setShowForm(true)
    setError(null)
  }

  const openEdit = (task) => {
    setEditingTask(task)
    setForm({
      name:          task.name,
      description:   task.description,
      task_type:     task.task_type,
      config:        task.config ?? {},
      schedule_time: task.schedule_time,
      frequency:     task.frequency,
      day_of_week:   task.day_of_week ?? 0,
      day_of_month:  task.day_of_month ?? 1,
      enabled:       task.enabled,
      next_task_id:  task.next_task_id ?? null,
    })
    setShowForm(true)
    setError(null)
  }

  const closeForm = () => {
    setShowForm(false)
    setEditingTask(null)
    setError(null)
  }

  const setField = (key, value) => setForm(f => ({ ...f, [key]: value }))
  const setConfig = (key, value) =>
    setForm(f => ({ ...f, config: { ...f.config, [key]: value } }))

  const handleSave = async (e) => {
    e.preventDefault()
    if (!form.name.trim()) { setError('Name is required'); return }
    setSaving(true)
    setError(null)
    try {
      const body = {
        ...form,
        day_of_week:  form.frequency === 'weekly'  ? form.day_of_week  : null,
        day_of_month: form.frequency === 'monthly' ? form.day_of_month : null,
      }
      const url    = editingTask ? `/api/agent-tasks/${editingTask.id}` : '/api/agent-tasks'
      const method = editingTask ? 'PUT' : 'POST'
      const res    = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const saved = await res.json()
      setTasks(prev =>
        editingTask
          ? prev.map(t => t.id === saved.id ? saved : t)
          : [...prev, saved]
      )
      closeForm()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (task) => {
    if (!confirm(`Delete task "${task.name}"?`)) return
    await fetch(`/api/agent-tasks/${task.id}`, { method: 'DELETE' })
    setTasks(prev => prev.filter(t => t.id !== task.id))
    if (selectedId === task.id) setSelectedId(null)
  }

  const handleToggleEnabled = async (task) => {
    const updated = { ...task, enabled: !task.enabled }
    const res = await fetch(`/api/agent-tasks/${task.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    })
    if (res.ok) {
      const saved = await res.json()
      setTasks(prev => prev.map(t => t.id === saved.id ? saved : t))
    }
  }

  const handleTrigger = async (task) => {
    setTriggering(task.id)
    try {
      await fetch(`/api/agent-tasks/${task.id}/trigger`, { method: 'POST' })
      // Poll will pick up the new run
    } finally {
      setTriggering(null)
    }
  }

  // ── Selected task ───────────────────────────────────────────────────────────

  const selectedTask = tasks.find(t => t.id === selectedId) ?? null

  // ── Styles ──────────────────────────────────────────────────────────────────

  const s = {
    root: {
      display: 'flex', height: '100%', overflow: 'hidden',
      background: 'var(--bg-app)',
    },
    sidebar: {
      width: '340px', flexShrink: 0, borderRight: '1px solid var(--border)',
      display: 'flex', flexDirection: 'column', overflow: 'hidden',
    },
    sidebarHeader: {
      padding: '14px 16px', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      flexShrink: 0,
    },
    sidebarTitle: { fontSize: '13px', fontWeight: 700, color: 'var(--text-primary)' },
    addBtn: {
      height: '28px', padding: '0 12px', fontSize: '12px', fontWeight: 600,
      background: 'var(--blue)', border: 'none', borderRadius: '5px',
      color: '#fff', cursor: 'pointer',
    },
    taskList: { flex: 1, overflowY: 'auto' },
    taskRow: (selected, enabled) => ({
      padding: '12px 16px', cursor: 'pointer',
      borderBottom: '1px solid var(--border)',
      background: selected ? 'var(--bg-raised)' : 'transparent',
      opacity: enabled ? 1 : 0.6,
      transition: 'background 0.1s',
    }),
    taskName: { fontSize: '13px', fontWeight: 600, color: 'var(--text-primary)', marginBottom: '3px' },
    taskMeta: { fontSize: '11px', color: 'var(--text-muted)', marginBottom: '4px' },
    statusDot: (status) => ({
      display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%',
      background: STATUS_COLOR[status] ?? 'var(--text-muted)',
      marginRight: '5px', verticalAlign: 'middle',
    }),
    detail: {
      flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
    },
    detailHeader: {
      padding: '14px 20px', borderBottom: '1px solid var(--border)',
      display: 'flex', alignItems: 'center', gap: '10px', flexShrink: 0,
    },
    detailBody: { flex: 1, overflowY: 'auto', padding: '20px' },
    runRow: {
      display: 'flex', alignItems: 'flex-start', gap: '12px',
      padding: '10px 12px', borderRadius: '6px', marginBottom: '8px',
      border: '1px solid var(--border)', background: 'var(--bg-raised)',
      fontSize: '12px',
    },
    empty: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      height: '100%', color: 'var(--text-muted)', fontSize: '13px',
    },
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div style={s.root}>
      {/* ── Left sidebar: task list ─────────────────────────────────────────── */}
      <div style={s.sidebar}>
        <div style={s.sidebarHeader}>
          <span style={s.sidebarTitle}>Scheduled Tasks</span>
          <button style={s.addBtn} onClick={openCreate}>+ New Task</button>
        </div>

        <div style={s.taskList}>
          {tasks.length === 0 && (
            <div style={{ padding: '24px 16px', color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>
              No tasks yet. Click "+ New Task" to add one.
            </div>
          )}
          {tasks.map(task => (
            <div
              key={task.id}
              style={s.taskRow(selectedId === task.id, task.enabled)}
              onClick={() => setSelectedId(task.id)}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={s.taskName}>{task.name}</span>
                <div style={{ display: 'flex', gap: '6px', flexShrink: 0 }}>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleTrigger(task) }}
                    disabled={triggering === task.id}
                    title="Run now"
                    style={{
                      height: '20px', padding: '0 7px', fontSize: '10px', fontWeight: 600,
                      background: 'rgba(41,98,255,0.12)', border: '1px solid rgba(41,98,255,0.3)',
                      borderRadius: '3px', color: 'var(--blue)', cursor: 'pointer',
                    }}
                  >▶ Run</button>
                  <button
                    onClick={(e) => { e.stopPropagation(); handleToggleEnabled(task) }}
                    title={task.enabled ? 'Disable' : 'Enable'}
                    style={{
                      height: '20px', padding: '0 7px', fontSize: '10px',
                      background: task.enabled ? 'rgba(38,166,154,0.12)' : 'rgba(120,123,134,0.12)',
                      border: `1px solid ${task.enabled ? 'rgba(38,166,154,0.3)' : 'var(--border)'}`,
                      borderRadius: '3px',
                      color: task.enabled ? 'var(--green)' : 'var(--text-muted)',
                      cursor: 'pointer',
                    }}
                  >{task.enabled ? 'ON' : 'OFF'}</button>
                </div>
              </div>
              <div style={s.taskMeta}>{scheduleLabel(task)}</div>
              {task.next_task_name && (
                <div style={{ fontSize: '11px', color: 'var(--blue)', marginBottom: '3px' }}>
                  → {task.next_task_name}
                </div>
              )}
              {task.last_run_status && (
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  <span style={s.statusDot(task.last_run_status)} />
                  Last run: {task.last_run_status} · {fmtDatetime(task.last_run_at)}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Right panel: task detail or form ───────────────────────────────── */}
      <div style={s.detail}>
        {showForm ? (
          <TaskForm
            form={form}
            setField={setField}
            setConfig={setConfig}
            onSave={handleSave}
            onCancel={closeForm}
            saving={saving}
            error={error}
            isEditing={!!editingTask}
            editingTaskId={editingTask?.id ?? null}
            watchlists={watchlists}
            screenConfigs={screenConfigs}
            allTasks={tasks}
          />
        ) : selectedTask ? (
          <>
            {/* Header */}
            <div style={s.detailHeader}>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '3px', flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '15px', fontWeight: 700 }}>{selectedTask.name}</span>
                  {selectedTask.next_task_name && (
                    <span style={{
                      fontSize: '11px', color: 'var(--blue)',
                      display: 'flex', alignItems: 'center', gap: '4px',
                    }}>
                      <span style={{ color: 'var(--text-muted)' }}>→ then</span>
                      <span style={{
                        fontWeight: 600, padding: '1px 6px', borderRadius: '3px',
                        background: 'rgba(41,98,255,0.1)', border: '1px solid rgba(41,98,255,0.25)',
                      }}>{selectedTask.next_task_name}</span>
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {scheduleLabel(selectedTask)}
                  {selectedTask.description && ` · ${selectedTask.description}`}
                </div>
              </div>
              <button
                onClick={() => openEdit(selectedTask)}
                style={{
                  height: '28px', padding: '0 12px', fontSize: '12px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: '5px', color: 'var(--text-primary)', cursor: 'pointer',
                }}
              >Edit</button>
              <button
                onClick={() => handleDelete(selectedTask)}
                style={{
                  height: '28px', padding: '0 12px', fontSize: '12px',
                  background: 'rgba(239,83,80,0.08)', border: '1px solid rgba(239,83,80,0.3)',
                  borderRadius: '5px', color: 'var(--red)', cursor: 'pointer',
                }}
              >Delete</button>
            </div>

            {/* Run history */}
            <div style={s.detailBody}>
              <SectionLabel>Run History</SectionLabel>
              {runsLoading && (
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>Loading…</div>
              )}
              {!runsLoading && selectedRuns.length === 0 && (
                <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No runs yet.</div>
              )}
              {selectedRuns.map(run => (
                <RunCard key={run.id} run={run} />
              ))}
            </div>
          </>
        ) : (
          <div style={s.empty}>Select a task to see details, or create a new one.</div>
        )}
      </div>
    </div>
  )
}

// ── TaskForm ──────────────────────────────────────────────────────────────────

function TaskForm({ form, setField, setConfig, onSave, onCancel, saving, error, isEditing, editingTaskId, watchlists, screenConfigs, allTasks }) {
  // Tasks eligible as the "next" in a chain: all tasks except self
  const chainCandidates = allTasks.filter(t => t.id !== editingTaskId)
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
          color: 'var(--text-muted)', fontSize: '18px', lineHeight: 1,
        }}>×</button>
      </div>

      {/* Body */}
      <form onSubmit={onSave} style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>

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
            onChange={e => setField('name', e.target.value)}
            placeholder="e.g. Morning screener"
            style={inputStyle}
          />
        </FormField>

        <FormField label="Description (optional)">
          <textarea
            value={form.description}
            onChange={e => setField('description', e.target.value)}
            placeholder="What does this task do?"
            rows={2}
            style={{ ...inputStyle, resize: 'vertical', padding: '6px 10px', lineHeight: '1.5' }}
          />
        </FormField>

        <FormField label="Task Type">
          <select value={form.task_type} onChange={e => setField('task_type', e.target.value)} style={inputStyle}>
            {TASK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </FormField>

        {/* Screener-specific config */}
        {form.task_type === 'screener' && (
          <>
            <FormField label="Screener Config">
              <select
                value={form.config.screen_config_id ?? ''}
                onChange={e => setConfig('screen_config_id', e.target.value ? Number(e.target.value) : null)}
                style={inputStyle}
              >
                <option value="">— None (all conditions) —</option>
                {screenConfigs.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </FormField>

            <FormField label="Watchlist">
              <select
                value={form.config.watchlist_id ?? ''}
                onChange={e => setConfig('watchlist_id', e.target.value ? Number(e.target.value) : null)}
                style={inputStyle}
              >
                <option value="">— None —</option>
                {watchlists.map(wl => (
                  <option key={wl.id} value={wl.id}>{wl.name}</option>
                ))}
              </select>
            </FormField>
          </>
        )}

        {/* Schedule */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
          <SectionLabel>Schedule (Eastern Time)</SectionLabel>
        </div>

        <FormField label="Run Time (HH:MM)">
          <input
            type="time"
            value={form.schedule_time}
            onChange={e => setField('schedule_time', e.target.value)}
            style={inputStyle}
          />
        </FormField>

        <FormField label="Frequency">
          <select value={form.frequency} onChange={e => setField('frequency', e.target.value)} style={inputStyle}>
            {FREQ_OPTIONS.map(f => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </FormField>

        {form.frequency === 'weekly' && (
          <FormField label="Day of Week">
            <select value={form.day_of_week} onChange={e => setField('day_of_week', Number(e.target.value))} style={inputStyle}>
              {DOW_OPTIONS.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
            </select>
          </FormField>
        )}

        {form.frequency === 'monthly' && (
          <FormField label="Day of Month">
            <input
              type="number"
              min={1} max={28}
              value={form.day_of_month}
              onChange={e => setField('day_of_month', Math.max(1, Math.min(28, Number(e.target.value))))}
              style={inputStyle}
            />
          </FormField>
        )}

        <FormField label="Enabled">
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={e => setField('enabled', e.target.checked)}
              style={{ width: '15px', height: '15px', cursor: 'pointer' }}
            />
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
              Schedule this task to run automatically
            </span>
          </label>
        </FormField>

        {/* Chaining */}
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: '16px' }}>
          <SectionLabel>Chain (on success, run next)</SectionLabel>
        </div>

        <FormField label="Then run →">
          <select
            value={form.next_task_id ?? ''}
            onChange={e => setField('next_task_id', e.target.value ? Number(e.target.value) : null)}
            style={inputStyle}
          >
            <option value="">— None —</option>
            {chainCandidates.map(t => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
            Runs immediately after this task succeeds. Cycles are rejected.
          </div>
        </FormField>

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            type="submit"
            disabled={saving}
            style={{
              height: '32px', padding: '0 20px', fontSize: '13px', fontWeight: 600,
              background: 'var(--blue)', border: 'none', borderRadius: '6px',
              color: '#fff', cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.7 : 1,
            }}
          >{saving ? 'Saving…' : isEditing ? 'Update Task' : 'Create Task'}</button>
          <button
            type="button"
            onClick={onCancel}
            style={{
              height: '32px', padding: '0 16px', fontSize: '13px',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: '6px', color: 'var(--text-secondary)', cursor: 'pointer',
            }}
          >Cancel</button>
        </div>
      </form>
    </div>
  )
}

// ── RunCard ───────────────────────────────────────────────────────────────────

function RunCard({ run }) {
  const [expanded, setExpanded] = useState(false)
  const dur = run.ended_at && run.started_at
    ? ((new Date(run.ended_at) - new Date(run.started_at)) / 1000).toFixed(1) + 's'
    : run.status === 'running' ? 'running…' : '—'

  const output = run.output
  const hasPassed = output?.passed?.length > 0
  const hasFailed = output?.failed?.length > 0

  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: '6px',
      marginBottom: '8px', overflow: 'hidden',
      background: 'var(--bg-raised)',
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
        <span style={{ fontSize: '12px', color: 'var(--text-primary)', fontWeight: 600 }}>
          {run.status.toUpperCase()}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
          {fmtDatetime(run.started_at)}
        </span>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{dur}</span>
        {output && (
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {output.passed?.length ?? 0}/{output.total ?? 0} passed
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
          {output && (
            <div style={{ marginTop: '10px', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
              {hasPassed && (
                <SymbolList label="Passed" symbols={output.passed} color="var(--green)" />
              )}
              {hasFailed && (
                <SymbolList label="Failed / Skipped" symbols={output.failed} color="var(--red)" />
              )}
              {!hasPassed && !hasFailed && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  {output.note ?? 'No output'}
                </span>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SymbolList({ label, symbols, color }) {
  return (
    <div>
      <div style={{ fontSize: '10px', fontWeight: 700, color, marginBottom: '4px', textTransform: 'uppercase' }}>
        {label} ({symbols.length})
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
        {symbols.map(sym => (
          <span key={sym} style={{
            fontSize: '10px', fontWeight: 600,
            padding: '2px 6px', borderRadius: '3px',
            background: color === 'var(--green)' ? 'rgba(38,166,154,0.1)' : 'rgba(239,83,80,0.1)',
            color,
          }}>{sym}</span>
        ))}
      </div>
    </div>
  )
}

// ── Small helpers ─────────────────────────────────────────────────────────────

function FormField({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)', marginBottom: '5px', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </div>
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

const inputStyle = {
  width: '100%', height: '32px', padding: '0 10px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: '5px', color: 'var(--text-primary)', fontSize: '12px',
  outline: 'none', boxSizing: 'border-box',
}
