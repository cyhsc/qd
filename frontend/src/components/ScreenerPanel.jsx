import { useState, useMemo, useEffect, useRef } from 'react'

// ── Condition display metadata ────────────────────────────────────────────────

const COND_META = {
  rwb_gap_positive:                         { short: 'RWB≥',   label: 'RWB gap ≥ value'           },
  rwb_gap_rising:                           { short: 'RWB↑',   label: 'RWB gap rising'            },
  rwb_slow_width_rising:                    { short: 'SW↑',    label: 'RWB slow-width rising'     },
  rwb_fast_width_rising:                    { short: 'FW↑',    label: 'RWB fast-width rising'     },
  rwb_fast_above_slow:                      { short: 'F>S',    label: 'Fast width > slow width'   },
  rwb_bars_since_fast_above_slow:           { short: 'BFS-N',  label: 'Bars since fast>slow'      },
  rwb_slow_width_consecutive_positive_bars: { short: 'SW-P',   label: 'Slow-width conseq. +'      },
  rwb_fast_width_consecutive_positive_bars: { short: 'FW-P',   label: 'Fast-width conseq. +'      },
  rwb_slow_width_consecutive_rising_bars:   { short: 'SW-R',   label: 'Slow-width conseq. ↑'      },
  rwb_fast_width_consecutive_rising_bars:   { short: 'FW-R',   label: 'Fast-width conseq. ↑'      },
  macd_line_positive:                       { short: 'ML+',    label: 'MACD line positive'        },
  macd_line_rising:                         { short: 'ML↑',    label: 'MACD line rising'          },
  macd_histogram_positive:                  { short: 'MH+',    label: 'MACD histogram positive'   },
  macd_histogram_rising:                    { short: 'MH↑',    label: 'MACD histogram rising'     },
  macd_signal_positive:                     { short: 'MS+',    label: 'MACD signal positive'      },
  macd_histogram_consecutive_positive_bars: { short: 'MH-N',   label: 'MACD histogram conseq. +'  },
  sqz_momentum_positive:                    { short: 'SQZ+',   label: 'SQZ momentum positive'     },
  sqz_momentum_rising:                      { short: 'SQZ↑',   label: 'SQZ momentum rising'       },
  sqz_not_on:                               { short: '!ON',    label: 'SQZ not firing'            },
  sqz_consecutive_positive_bars:            { short: 'SQZ-N',  label: 'SQZ momentum conseq. +'    },
  stochrsi_k_cross_up_d:                    { short: 'SR K×D', label: 'StochRSI %K crosses up %D' },
  stochrsi_k_cross_up_value:                { short: 'SR K×V', label: 'StochRSI %K crosses up level' },
}

// Ordered list of every condition the analysis engine supports
const ALL_CONDITIONS = [
  'rwb_gap_positive', 'rwb_gap_rising', 'rwb_slow_width_rising', 'rwb_fast_width_rising',
  'rwb_fast_above_slow',
  'rwb_bars_since_fast_above_slow', 'rwb_slow_width_consecutive_positive_bars',
  'rwb_fast_width_consecutive_positive_bars', 'rwb_slow_width_consecutive_rising_bars',
  'rwb_fast_width_consecutive_rising_bars',
  'macd_line_positive', 'macd_line_rising', 'macd_histogram_positive', 'macd_histogram_rising',
  'macd_signal_positive', 'macd_histogram_consecutive_positive_bars',
  'sqz_momentum_positive', 'sqz_momentum_rising', 'sqz_not_on', 'sqz_consecutive_positive_bars',
  'stochrsi_k_cross_up_d', 'stochrsi_k_cross_up_value',
]

// Conditions that have a threshold + operator parameter
const PARAMETRIC_CONDITIONS = [
  'rwb_gap_positive',
  'sqz_consecutive_positive_bars',
  'macd_histogram_consecutive_positive_bars',
  'rwb_bars_since_fast_above_slow',
  'rwb_slow_width_consecutive_positive_bars',
  'rwb_fast_width_consecutive_positive_bars',
  'rwb_slow_width_consecutive_rising_bars',
  'rwb_fast_width_consecutive_rising_bars',
  'stochrsi_k_cross_up_value',
]

// Per-condition parameter metadata. Bar-count conditions (the default) compare
// an integer streak; "value" conditions compare a raw float (e.g. the RWB gap).
const DEFAULT_PARAM_META = {
  kind: 'bars', unit: 'bars', step: 1, min: 1, defOp: 'gt', defThreshold: 3,
  ops: ['gt', 'eq', 'lt'],
}
const PARAM_META = {
  rwb_gap_positive: {
    kind: 'value', unit: 'value', step: 0.1, min: null, defOp: 'gte', defThreshold: 0,
    ops: ['gte', 'gt', 'eq', 'lte', 'lt'],
  },
  // "cross" kind: %K rises through a level. No operator choice — the crossover
  // direction is fixed — so only the level (threshold) is editable.
  stochrsi_k_cross_up_value: {
    kind: 'cross', unit: 'level', step: 1, min: 0, defOp: 'cross_up', defThreshold: 20,
    ops: ['cross_up'],
  },
}
const paramMeta = (name) => PARAM_META[name] ?? DEFAULT_PARAM_META

// Operator display symbols. Bar-streak "lt" reads "1≤n<"; a value "lt" is plain "<".
const OP_LABEL = {
  bars:  { gt: '>', eq: '=', lt: '1≤n<' },
  value: { gt: '>', gte: '≥', eq: '=', lte: '≤', lt: '<' },
  cross: { cross_up: '↗ crosses up' },
}

function shortName(name)  { return COND_META[name]?.short ?? name }
function labelName(name)  { return COND_META[name]?.label ?? name }

// ── Component ─────────────────────────────────────────────────────────────────

export function ScreenerPanel({
  watchlists,
  screenConfigs,
  activeConfigId,
  onSwitchScreener,   // (id) → void
  onCreateScreener,   // (name) → Promise<config>
  onDeleteScreener,   // (id) → void
  onRenameScreener,   // (id, name) → void
  onSaveUniverse,     // (id, {mode, list_id, symbols}) → void
  onOpenChart,        // (sym) → void
  onImportList,       // (name, symbols, onProgress) → Promise<void>
  onConditionParam,   // (condName, key, val) → void
  onSaveLogic,        // (logic) → void
}) {
  const [universeMode,   setUniverseMode]   = useState('watchlist')
  const [selectedListId, setSelectedListId] = useState(() =>
    watchlists[0]?.id != null ? String(watchlists[0].id) : null
  )
  const [manualInput,    setManualInput]    = useState('')

  // ── Sync universe from the active screener config ─────────────────────────
  const syncingRef     = useRef(false)
  const universeTimer  = useRef(null)

  useEffect(() => {
    const cfg = screenConfigs.find(c => String(c.id) === String(activeConfigId))
    if (!cfg) return
    syncingRef.current = true
    const u = cfg.conditions?._universe ?? {}
    setUniverseMode(u.mode ?? 'watchlist')
    setSelectedListId(
      u.list_id != null ? String(u.list_id)
        : watchlists[0]?.id != null ? String(watchlists[0].id) : null
    )
    setManualInput(u.symbols ?? '')
    // Clear sync flag after React has flushed state updates
    requestAnimationFrame(() => { syncingRef.current = false })
  }, [activeConfigId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-save universe changes (debounced, skipped when syncing from config)
  useEffect(() => {
    if (syncingRef.current) return
    clearTimeout(universeTimer.current)
    universeTimer.current = setTimeout(() => {
      if (activeConfigId == null) return
      onSaveUniverse(activeConfigId, {
        mode:     universeMode,
        list_id:  universeMode === 'watchlist' && selectedListId ? Number(selectedListId) : null,
        symbols:  universeMode === 'manual' ? manualInput : '',
      })
    }, 800)
    return () => clearTimeout(universeTimer.current)
  }, [universeMode, selectedListId, manualInput]) // eslint-disable-line react-hooks/exhaustive-deps
  const [running,        setRunning]        = useState(false)
  const [screenData,     setScreenData]     = useState(null)   // response from /screen/batch
  const [runError,       setRunError]       = useState(null)
  const [savingList,     setSavingList]     = useState(false)
  const [saveNameInput,   setSaveNameInput]   = useState('')
  const [saveProgress,    setSaveProgress]   = useState(null)   // {done, total}
  const [autoSave,        setAutoSave]        = useState(null)   // {name, saving, done, total, error}
  const [creatingScreener, setCreatingScreener] = useState(false)
  const [newScreenerName,  setNewScreenerName]  = useState('')
  const [renamingId,       setRenamingId]       = useState(null)
  const [renameInput,      setRenameInput]      = useState('')

  const activeConfig     = screenConfigs.find(c => String(c.id) === String(activeConfigId))

  // Merge stored conditions over the full default set so every condition is
  // always visible even for configs created before the full list was seeded.
  const configConditions = useMemo(() => {
    const stored = activeConfig?.conditions ?? {}
    const merged = {}
    for (const name of ALL_CONDITIONS) {
      merged[name] = { verdict_role: null, ...stored[name] }
    }
    // Also preserve any extra keys already in stored (e.g. _universe)
    for (const [k, v] of Object.entries(stored)) {
      if (!(k in merged)) merged[k] = v
    }
    return merged
  }, [activeConfig])

  // ── Screener selector handlers ─────────────────────────────────────────────

  async function handleCreateScreener(e) {
    e.preventDefault()
    const name = newScreenerName.trim()
    if (!name) return
    await onCreateScreener(name)
    setNewScreenerName('')
    setCreatingScreener(false)
  }

  function handleStartRename(cfg) {
    setRenamingId(cfg.id)
    setRenameInput(cfg.name)
  }

  function handleFinishRename(e) {
    e.preventDefault()
    const name = renameInput.trim()
    if (name && renamingId != null) onRenameScreener(renamingId, name)
    setRenamingId(null)
    setRenameInput('')
  }

  // ── Universe ───────────────────────────────────────────────────────────────

  const symbols = useMemo(() => {
    if (universeMode === 'watchlist') {
      const list = watchlists.find(l => String(l.id) === String(selectedListId))
      return (list?.symbols ?? []).map(s => s.symbol)
    }
    return manualInput.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  }, [universeMode, selectedListId, manualInput, watchlists])

  // ── Verdict logic (always active) ────────────────────────────────────────────
  // Effective logic = stored _logic, or one derived from the config's required
  // conditions (a single AND group). The derived form is behaviourally identical
  // to the backend's legacy "AND of required conditions" so existing configs keep
  // working until the user edits the logic.

  const effectiveLogic = useMemo(() => {
    const stored = activeConfig?.conditions?._logic
    if (stored?.groups) return stored
    const required = ALL_CONDITIONS.filter(n => {
      const r = activeConfig?.conditions?.[n]?.verdict_role
      return r !== null && r !== undefined
    })
    return {
      operator: 'AND',
      groups: [{ operator: 'AND', conditions: required }],
    }
  }, [activeConfig])

  const logicConditionSet = useMemo(
    () => new Set(collectLogicConditions(effectiveLogic)),
    [effectiveLogic],
  )

  // Results columns = every condition that appears in any group.
  const requiredCols = useMemo(() => {
    if (!screenData?.results?.length) return []
    const first = screenData.results.find(r => r.conditions?.length > 0)
    if (!first) return []
    return first.conditions.map(c => c.name).filter(n => logicConditionSet.has(n))
  }, [screenData, logicConditionSet])

  // Sort results: passed first, failed next, errored last
  const sortedResults = useMemo(() => {
    if (!screenData?.results) return []
    return [...screenData.results].sort((a, b) => {
      const rank = r => r.error ? 2 : r.verdict ? 0 : 1
      return rank(a) - rank(b)
    })
  }, [screenData])

  // ── Handlers ───────────────────────────────────────────────────────────────

  // Compose the auto-save watchlist name: YYYY-MM-DD-[screener name]-[watch list name]
  function autoSaveName() {
    const d    = new Date()
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const screener  = (activeConfig?.name ?? 'screen').trim()
    const universe  = universeMode === 'watchlist'
      ? (watchlists.find(l => String(l.id) === String(selectedListId))?.name ?? 'watchlist').trim()
      : 'manual'
    return `${date}-${screener}-${universe}`
  }

  async function handleRun() {
    if (!symbols.length || running) return
    setRunning(true)
    setScreenData(null)
    setRunError(null)
    setAutoSave(null)
    try {
      const res = await fetch('/api/stocks/screen/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbols, config_id: activeConfigId }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      const data = await res.json()
      setScreenData(data)

      // Auto-save the passing symbols to a dated watchlist
      const passed = data.passed ?? []
      if (passed.length) {
        const name = autoSaveName()
        setAutoSave({ name, saving: true, done: 0, total: passed.length, error: null })
        try {
          await onImportList(name, passed, (done, total) =>
            setAutoSave(prev => prev && { ...prev, done, total })
          )
          setAutoSave(prev => prev && { ...prev, saving: false })
        } catch (e) {
          setAutoSave(prev => prev && { ...prev, saving: false, error: e.message || 'Save failed' })
        }
      }
    } catch (e) {
      setRunError(e.message)
    } finally {
      setRunning(false)
    }
  }

  async function handleSaveList() {
    const name = saveNameInput.trim()
    if (!name || !screenData?.passed?.length) return
    setSaveProgress({ done: 0, total: screenData.passed.length })
    await onImportList(name, screenData.passed, (done, total) => setSaveProgress({ done, total }))
    setSaveProgress(null)
    setSavingList(false)
    setSaveNameInput('')
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const passedCount  = screenData?.passed?.length  ?? 0
  const totalCount   = screenData?.results?.length ?? 0
  const erroredCount = Object.keys(screenData?.errored ?? {}).length

  return (
    <div style={{ display: 'flex', flex: 1, overflow: 'hidden', minHeight: 0 }}>

      {/* ── Left panel: Universe + Conditions ── */}
      {/* overflow:hidden on the panel; only the conditions section scrolls internally */}
      <div style={{
        width: '290px', flexShrink: 0,
        display: 'flex', flexDirection: 'column',
        borderRight: '1px solid var(--border)',
        overflow: 'hidden',
      }}>

        {/* ── Screener selector ── */}
        <SectionLabel text="SCREENER" />
        <div style={{ padding: '0 14px 10px', flexShrink: 0 }}>
          {creatingScreener ? (
            <form onSubmit={handleCreateScreener} style={{ display: 'flex', gap: '4px' }}>
              <input
                autoFocus
                value={newScreenerName}
                onChange={e => setNewScreenerName(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setCreatingScreener(false)}
                placeholder="Screener name…"
                style={{
                  flex: 1, height: '28px', padding: '0 8px', fontSize: '12px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: '5px', color: 'var(--text-primary)', outline: 'none',
                }}
              />
              <button type="submit" style={{
                height: '28px', padding: '0 8px', fontSize: '11px',
                background: 'var(--blue)', border: 'none', borderRadius: '5px',
                color: '#fff', cursor: 'pointer',
              }}>OK</button>
              <button type="button" onClick={() => setCreatingScreener(false)} style={{
                height: '28px', padding: '0 6px', fontSize: '14px',
                background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              }}>×</button>
            </form>
          ) : renamingId != null ? (
            <form onSubmit={handleFinishRename} style={{ display: 'flex', gap: '4px' }}>
              <input
                autoFocus
                value={renameInput}
                onChange={e => setRenameInput(e.target.value)}
                onKeyDown={e => e.key === 'Escape' && setRenamingId(null)}
                style={{
                  flex: 1, height: '28px', padding: '0 8px', fontSize: '12px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: '5px', color: 'var(--text-primary)', outline: 'none',
                }}
              />
              <button type="submit" style={{
                height: '28px', padding: '0 8px', fontSize: '11px',
                background: 'var(--blue)', border: 'none', borderRadius: '5px',
                color: '#fff', cursor: 'pointer',
              }}>OK</button>
              <button type="button" onClick={() => setRenamingId(null)} style={{
                height: '28px', padding: '0 6px', fontSize: '14px',
                background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
              }}>×</button>
            </form>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
              <select
                value={activeConfigId ?? ''}
                onChange={e => onSwitchScreener(Number(e.target.value))}
                style={{
                  flex: 1, height: '28px', padding: '0 6px', fontSize: '12px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: '5px', color: 'var(--text-primary)',
                  cursor: 'pointer', outline: 'none',
                }}
              >
                {screenConfigs.map(c => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {/* Rename */}
              <button
                onClick={() => activeConfig && handleStartRename(activeConfig)}
                title="Rename screener"
                style={{
                  height: '28px', padding: '0 6px', fontSize: '12px',
                  background: 'none', border: 'none',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}
              >✎</button>
              {/* Delete (only if more than one) */}
              {screenConfigs.length > 1 && (
                <button
                  onClick={() => onDeleteScreener(activeConfigId)}
                  title="Delete screener"
                  style={{
                    height: '28px', padding: '0 5px', fontSize: '15px',
                    background: 'none', border: 'none',
                    color: 'var(--text-muted)', cursor: 'pointer',
                  }}
                >×</button>
              )}
              {/* Create new */}
              <button
                onClick={() => setCreatingScreener(true)}
                title="New screener"
                style={{
                  height: '28px', padding: '0 6px', fontSize: '17px',
                  background: 'none', border: 'none',
                  color: 'var(--text-muted)', cursor: 'pointer',
                }}
              >+</button>
            </div>
          )}
        </div>

        {/* Universe section — fixed height, never scrolls away */}
        <SectionLabel text="UNIVERSE" />
        <div style={{ padding: '0 14px 12px', flexShrink: 0 }}>
          <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
            {['watchlist', 'manual'].map(mode => (
              <button
                key={mode}
                onClick={() => setUniverseMode(mode)}
                style={{
                  flex: 1, height: '28px', fontSize: '11px', fontWeight: 500,
                  border: '1px solid var(--border)', borderRadius: '5px', cursor: 'pointer',
                  background: universeMode === mode ? 'var(--blue)' : 'var(--bg-raised)',
                  color: universeMode === mode ? '#fff' : 'var(--text-secondary)',
                  textTransform: 'capitalize',
                }}
              >
                {mode}
              </button>
            ))}
          </div>

          {universeMode === 'watchlist' ? (
            <select
              value={selectedListId ?? ''}
              onChange={e => setSelectedListId(e.target.value)}
              style={{
                width: '100%', height: '30px', padding: '0 8px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '5px', color: 'var(--text-primary)',
                fontSize: '12px', cursor: 'pointer', outline: 'none',
              }}
            >
              {watchlists.map(l => (
                <option key={l.id} value={l.id}>
                  {l.name} ({l.symbols?.length ?? 0})
                </option>
              ))}
            </select>
          ) : (
            <textarea
              value={manualInput}
              onChange={e => setManualInput(e.target.value)}
              placeholder={'AAPL\nTSLA\nMSFT\n…'}
              rows={5}
              style={{
                width: '100%', padding: '6px 8px', boxSizing: 'border-box',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '5px', color: 'var(--text-primary)',
                fontSize: '12px', fontFamily: 'var(--font-mono)',
                resize: 'none', outline: 'none',
              }}
            />
          )}

          {symbols.length > 0 && (
            <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-muted)' }}>
              {symbols.length} symbol{symbols.length !== 1 ? 's' : ''}
            </div>
          )}
        </div>

        {/* Logic section */}
        <SectionLabel text="VERDICT LOGIC" />
        <div style={{ padding: '0 14px 10px', flexShrink: 0 }}>
          <LogicBuilder
            logic={effectiveLogic}
            allConditions={ALL_CONDITIONS}
            onChange={onSaveLogic}
          />
        </div>

        {/* Conditions section — scrolls independently so button is never hidden */}
        <SectionLabel text="CONDITIONS" />
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px 8px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {ALL_CONDITIONS.map(name => {
                const cfg   = configConditions[name] ?? { verdict_role: null }
                const isParametric = PARAMETRIC_CONDITIONS.includes(name)
                const p     = cfg ?? {}
                const inGroup = logicConditionSet.has(name)
                return (
                  <div key={name} style={{
                    padding: '6px 8px', borderRadius: '5px',
                    background: 'var(--bg-raised)',
                    border: `1px solid ${inGroup ? 'rgba(41,98,255,0.35)' : 'var(--border)'}`,
                  }}>
                    {/* Row 1: group-membership badge + name */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <span style={{
                        flexShrink: 0,
                        fontSize: '9px', fontWeight: 700, padding: '2px 5px',
                        borderRadius: '3px',
                        letterSpacing: '0.04em', textTransform: 'uppercase',
                        background: inGroup ? 'rgba(41,98,255,0.15)' : 'rgba(120,123,134,0.08)',
                        color: inGroup ? 'var(--blue)' : 'var(--text-muted)',
                        minWidth: '52px', textAlign: 'center',
                      }}>
                        {inGroup ? 'in group' : 'unused'}
                      </span>
                      <span style={{
                        fontSize: '11px', fontFamily: 'var(--font-mono)',
                        color: 'var(--text-primary)', fontWeight: 600,
                        flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }} title={labelName(name)}>
                        {shortName(name)}
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: '5px' }}>
                          {labelName(name)}
                        </span>
                      </span>
                    </div>
                    {/* Row 2: parametric controls (threshold + op) */}
                    {isParametric && (() => {
                      const pm = paramMeta(name)
                      return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>{pm.unit}</span>
                        <select
                          value={p.op ?? pm.defOp}
                          onChange={e => onConditionParam(name, 'op', e.target.value)}
                          style={{
                            height: '22px', padding: '0 4px', fontSize: '10px',
                            background: 'var(--bg-panel)', border: '1px solid var(--border)',
                            borderRadius: '3px', color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
                          }}
                        >
                          {pm.ops.map(o => (
                            <option
                              key={o}
                              value={o}
                              title={pm.kind === 'bars' && o === 'lt' ? 'active streak shorter than threshold' : undefined}
                            >
                              {OP_LABEL[pm.kind][o]}
                            </option>
                          ))}
                        </select>
                        <input
                          type="number"
                          step={pm.step}
                          {...(pm.min != null ? { min: pm.min } : {})}
                          value={p.threshold ?? pm.defThreshold}
                          onChange={e => {
                            const raw = e.target.value
                            let v = pm.kind === 'bars' ? parseInt(raw) : parseFloat(raw)
                            if (Number.isNaN(v)) v = pm.defThreshold
                            if (pm.min != null) v = Math.max(pm.min, v)
                            onConditionParam(name, 'threshold', v)
                          }}
                          style={{
                            width: '44px', height: '22px', padding: '0 4px', fontSize: '10px',
                            background: 'var(--bg-panel)', border: '1px solid var(--border)',
                            borderRadius: '3px', color: 'var(--text-primary)', textAlign: 'center', outline: 'none',
                          }}
                        />
                      </div>
                      )
                    })()}
                  </div>
                )
              })}
          </div>
        </div>

        {/* Run button — always pinned at the bottom, never scrolls away */}
        <div style={{ padding: '10px 14px', flexShrink: 0, borderTop: '1px solid var(--border)' }}>
          <button
            onClick={handleRun}
            disabled={running || symbols.length === 0}
            style={{
              width: '100%', height: '36px',
              background: running ? 'var(--bg-raised)' : symbols.length === 0 ? 'var(--bg-raised)' : 'var(--blue)',
              border: 'none', borderRadius: '6px',
              color: running || symbols.length === 0 ? 'var(--text-muted)' : '#fff',
              fontSize: '13px', fontWeight: 600,
              cursor: running || symbols.length === 0 ? 'not-allowed' : 'pointer',
              opacity: symbols.length === 0 ? 0.4 : 1,
              transition: 'all 0.15s',
            }}
          >
            {running
              ? `Screening ${symbols.length} symbol${symbols.length !== 1 ? 's' : ''}…`
              : `Run Screen  (${symbols.length})`}
          </button>
        </div>
      </div>

      {/* ── Right panel: Results ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

        {/* Results header */}
        {(screenData || running) && (
          <div style={{
            flexShrink: 0,
            display: 'flex', alignItems: 'center', gap: '12px',
            padding: '10px 16px',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-panel)',
          }}>
            {running ? (
              <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
                Screening {symbols.length} symbols…
              </span>
            ) : (
              <>
                <span style={{ fontSize: '13px', fontWeight: 600 }}>
                  <span style={{ color: 'var(--green)' }}>{passedCount}</span>
                  <span style={{ color: 'var(--text-muted)' }}> / {totalCount} passed</span>
                </span>
                {erroredCount > 0 && (
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                    · {erroredCount} error{erroredCount !== 1 ? 's' : ''}
                  </span>
                )}

                {/* Auto-save status */}
                {autoSave && (
                  <span style={{ fontSize: '11px', color: autoSave.error ? 'var(--red)' : 'var(--text-muted)' }}>
                    {autoSave.error
                      ? `Auto-save failed: ${autoSave.error}`
                      : autoSave.saving
                        ? `Saving to ${autoSave.name}… ${autoSave.done}/${autoSave.total}`
                        : `✓ Saved to ${autoSave.name}`}
                  </span>
                )}

                {/* Save as watchlist */}
                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  {savingList ? (
                    saveProgress ? (
                      <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
                        Saving… {saveProgress.done}/{saveProgress.total}
                      </span>
                    ) : (
                      <>
                        <input
                          autoFocus
                          value={saveNameInput}
                          onChange={e => setSaveNameInput(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter') handleSaveList()
                            if (e.key === 'Escape') { setSavingList(false); setSaveNameInput('') }
                          }}
                          placeholder="Watchlist name…"
                          style={{
                            height: '28px', width: '160px', padding: '0 8px',
                            background: 'var(--bg-raised)', border: '1px solid var(--border)',
                            borderRadius: '5px', color: 'var(--text-primary)',
                            fontSize: '12px', outline: 'none',
                          }}
                        />
                        <button
                          onClick={handleSaveList}
                          disabled={!saveNameInput.trim()}
                          style={{
                            height: '28px', padding: '0 10px', fontSize: '12px',
                            background: 'var(--blue)', border: 'none', borderRadius: '5px',
                            color: '#fff', cursor: saveNameInput.trim() ? 'pointer' : 'not-allowed',
                            opacity: saveNameInput.trim() ? 1 : 0.5,
                          }}
                        >
                          Save
                        </button>
                        <button
                          onClick={() => { setSavingList(false); setSaveNameInput('') }}
                          style={{
                            height: '28px', padding: '0 8px', fontSize: '14px',
                            background: 'none', border: 'none',
                            color: 'var(--text-muted)', cursor: 'pointer',
                          }}
                        >
                          ×
                        </button>
                      </>
                    )
                  ) : (
                    passedCount > 0 && (
                      <button
                        onClick={() => setSavingList(true)}
                        style={{
                          height: '28px', padding: '0 12px', fontSize: '12px',
                          background: 'var(--bg-raised)', border: '1px solid var(--border)',
                          borderRadius: '5px', color: 'var(--text-primary)',
                          cursor: 'pointer', fontWeight: 500,
                        }}
                      >
                        Save as Watchlist
                      </button>
                    )
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Error banner */}
        {runError && (
          <div style={{
            margin: '12px 16px', padding: '10px 14px', borderRadius: '6px',
            background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
            color: 'var(--red)', fontSize: '13px',
          }}>
            {runError}
          </div>
        )}

        {/* Empty state */}
        {!screenData && !running && !runError && (
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: '8px',
            color: 'var(--text-muted)',
          }}>
            <span style={{ fontSize: '32px', opacity: 0.3 }}>⚡</span>
            <span style={{ fontSize: '13px' }}>Select a universe and run the screen</span>
          </div>
        )}

        {/* Running spinner */}
        {running && (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-muted)', fontSize: '13px',
          }}>
            Screening {symbols.length} symbols — this may take a minute…
          </div>
        )}

        {/* Results table */}
        {screenData && !running && (
          <div style={{ flex: 1, overflow: 'auto' }}>
            <table style={{
              width: '100%', borderCollapse: 'collapse',
              fontSize: '12px',
            }}>
              <thead>
                <tr style={{ background: 'var(--bg-panel)', position: 'sticky', top: 0, zIndex: 2 }}>
                  <Th left>Symbol</Th>
                  <Th left>Name</Th>
                  {requiredCols.map(name => (
                    <Th key={name} title={labelName(name)}>{shortName(name)}</Th>
                  ))}
                  <Th>Score</Th>
                  <Th>Result</Th>
                </tr>
              </thead>
              <tbody>
                {sortedResults.map((row, i) => (
                  <ResultRow
                    key={row.symbol}
                    row={row}
                    cols={requiredCols}
                    zebra={i % 2 === 1}
                    onOpenChart={onOpenChart}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

// ── LogicBuilder ──────────────────────────────────────────────────────────────

// Deepest group nesting the UI allows (top-level groups = depth 1).
const MAX_GROUP_DEPTH = 3

// All leaf condition names referenced anywhere in a (possibly nested) logic tree.
function collectLogicConditions(logic) {
  const out = []
  const walk = (group) => {
    for (const c of group.conditions ?? []) out.push(c)
    for (const child of group.groups ?? []) walk(child)
  }
  for (const g of logic?.groups ?? []) walk(g)
  return out
}

// A group contributes nothing if it has no conditions and no non-empty children.
function groupIsEmpty(group) {
  if ((group.conditions ?? []).length) return false
  return (group.groups ?? []).every(groupIsEmpty)
}

// How many child verdicts a group combines: leaf conditions + non-empty sub-groups.
// This is the denominator for the group's "N of M" control (mirrors the backend,
// which skips empty groups).
function groupChildCount(group) {
  const conds = (group.conditions ?? []).length
  const subs  = (group.groups ?? []).filter(g => !groupIsEmpty(g)).length
  return conds + subs
}

// Immutably transform the group at `path` (array of indices into nested `groups`).
// fn(group) -> newGroup, or null to delete it.
function updateGroupAtPath(logic, path, fn) {
  const recur = (groups, depth) =>
    groups
      .map((g, i) => {
        if (i !== path[depth]) return g
        if (depth === path.length - 1) return fn(g)
        return { ...g, groups: recur(g.groups ?? [], depth + 1) }
      })
      .filter(Boolean)
  return { ...logic, groups: recur(logic.groups, 0) }
}

// Re-clamp every "N of" min_match into [1, childCount] after any structural change,
// and drop empty `groups` keys so the shape stays clean.
function reclampLogic(logic) {
  const fixGroup = (g) => {
    const groups = (g.groups ?? []).map(fixGroup)
    const next = { ...g }
    if (groups.length) next.groups = groups
    else delete next.groups
    if (next.operator === 'NOF' && next.min_match != null) {
      const n = groupChildCount(next)
      next.min_match = Math.min(Math.max(next.min_match, 1), Math.max(n, 1))
    }
    return next
  }
  const groups = (logic.groups ?? []).map(fixGroup)
  const top = { ...logic, groups }
  if (top.operator === 'NOF' && top.min_match != null) {
    top.min_match = Math.min(Math.max(top.min_match, 1), Math.max(groups.length, 1))
  }
  return top
}

function LogicBuilder({ logic, allConditions, onChange }) {
  const commit = (next) => onChange(reclampLogic(next))

  function setTopOp(op) {
    const next = { ...logic, operator: op }
    // Seed a sensible top-level min_match the first time it becomes "N of".
    if (op === 'NOF') {
      const n = logic.groups.length
      next.min_match = Math.min(Math.max(logic.min_match ?? 2, 1), Math.max(n, 1))
    }
    commit(next)
  }

  function setTopMinMatch(value) {
    commit({ ...logic, min_match: value })
  }

  function addGroup() {
    commit({ ...logic, groups: [...logic.groups, { operator: 'AND', conditions: [] }] })
  }

  // ── Path-addressed mutators (operate on a group anywhere in the tree) ────────
  function setGroupOp(path, op) {
    commit(updateGroupAtPath(logic, path, g => {
      const next = { ...g, operator: op }
      // Seed a sensible min_match the first time a group becomes "N of".
      if (op === 'NOF') {
        const n = groupChildCount(g)
        next.min_match = Math.min(Math.max(g.min_match ?? 2, 1), Math.max(n, 1))
      }
      return next
    }))
  }

  function setGroupMinMatch(path, value) {
    commit(updateGroupAtPath(logic, path, g => ({ ...g, min_match: value })))
  }

  function addCondToGroup(path, cond) {
    if (!cond) return
    commit(updateGroupAtPath(logic, path, g =>
      (g.conditions ?? []).includes(cond)
        ? g
        : { ...g, conditions: [...(g.conditions ?? []), cond] }
    ))
  }

  function removeCondFromGroup(path, cond) {
    commit(updateGroupAtPath(logic, path, g =>
      ({ ...g, conditions: (g.conditions ?? []).filter(c => c !== cond) })
    ))
  }

  function addSubGroup(path) {
    commit(updateGroupAtPath(logic, path, g =>
      ({ ...g, groups: [...(g.groups ?? []), { operator: 'AND', conditions: [] }] })
    ))
  }

  function removeGroup(path) {
    const next = updateGroupAtPath(logic, path, () => null)
    // Always keep at least one top-level group so logic mode is never empty.
    if (!next.groups.length) next.groups = [{ operator: 'AND', conditions: [] }]
    commit(next)
  }

  const btnBase = {
    height: '22px', padding: '0 8px', fontSize: '10px', fontWeight: 600,
    border: '1px solid var(--border)', borderRadius: '3px', cursor: 'pointer',
    letterSpacing: '0.04em',
  }
  const opBtn = (active) => ({
    ...btnBase,
    background: active ? 'var(--blue)' : 'var(--bg-panel)',
    color: active ? '#fff' : 'var(--text-muted)',
    borderColor: active ? 'var(--blue)' : 'var(--border)',
  })

  const multiGroup = logic.groups.length > 1

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {/* Top-level operator — only relevant with more than one group */}
      {multiGroup && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>Combine groups with</span>
          <button style={opBtn(logic.operator === 'AND')} onClick={() => setTopOp('AND')}>AND</button>
          <button style={opBtn(logic.operator === 'OR')}  onClick={() => setTopOp('OR')}>OR</button>
          <button style={opBtn(logic.operator === 'NOF')} onClick={() => setTopOp('NOF')}>N OF</button>
          {logic.operator === 'NOF' && (
            <span style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: 'var(--text-muted)' }}>
              <input
                type="number"
                min={1}
                max={Math.max(logic.groups.length, 1)}
                value={logic.min_match ?? 1}
                onChange={e => setTopMinMatch(Number(e.target.value))}
                style={{
                  width: '34px', height: '22px', padding: '0 4px', fontSize: '10px',
                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                  borderRadius: '3px', color: 'var(--text-primary)', outline: 'none',
                  textAlign: 'center',
                }}
              />
              of {logic.groups.length} groups
            </span>
          )}
        </div>
      )}

      {/* Groups */}
      {logic.groups.map((group, gi) => (
        <GroupEditor
          key={gi}
          group={group}
          path={[gi]}
          depth={1}
          label={`Group ${gi + 1}`}
          allConditions={allConditions}
          opBtn={opBtn}
          btnBase={btnBase}
          onSetOp={setGroupOp}
          onSetMinMatch={setGroupMinMatch}
          onAddCond={addCondToGroup}
          onRemoveCond={removeCondFromGroup}
          onAddSubGroup={addSubGroup}
          onRemove={removeGroup}
        />
      ))}

      {/* Add group button */}
      <button
        onClick={addGroup}
        style={{
          ...btnBase,
          alignSelf: 'flex-start',
          background: 'var(--bg-panel)',
          color: 'var(--text-secondary)',
        }}
      >
        + Add group
      </button>

      <div style={{ fontSize: '10px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
        A group passes when all (AND), any (OR), or at least N (N OF) of its
        members pass — where members are its conditions and any nested
        sub-groups. Conditions not in any group are ignored for the verdict.
      </div>
    </div>
  )
}

// ── GroupEditor (recursive) ─────────────────────────────────────────────────
// Renders a single group — its operator, conditions, and nested sub-groups —
// and recurses for each sub-group. All mutations are addressed by `path`
// (an array of indices into the nested `groups` arrays).

function GroupEditor({
  group, path, depth, label, allConditions,
  opBtn, btnBase, onSetOp, onSetMinMatch, onAddCond, onRemoveCond,
  onAddSubGroup, onRemove,
}) {
  const conditions = group.conditions ?? []
  const subGroups  = group.groups ?? []
  const memberCount = groupChildCount(group)
  const canNest = depth < MAX_GROUP_DEPTH

  return (
    <div style={{
      padding: '6px 8px', borderRadius: '5px',
      background: depth > 1 ? 'var(--bg-raised)' : 'var(--bg-panel)',
      border: '1px solid var(--border)',
    }}>
      {/* Group header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginBottom: '5px' }}>
        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>
          {label}
        </span>
        <button style={opBtn(group.operator === 'AND')} onClick={() => onSetOp(path, 'AND')}>AND</button>
        <button style={opBtn(group.operator === 'OR')}  onClick={() => onSetOp(path, 'OR')}>OR</button>
        <button style={opBtn(group.operator === 'NOF')} onClick={() => onSetOp(path, 'NOF')}>N OF</button>
        {group.operator === 'NOF' && (
          <span style={{ display: 'flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: 'var(--text-muted)' }}>
            <input
              type="number"
              min={1}
              max={Math.max(memberCount, 1)}
              value={group.min_match ?? 1}
              onChange={e => onSetMinMatch(path, Number(e.target.value))}
              style={{
                width: '34px', height: '22px', padding: '0 4px', fontSize: '10px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '3px', color: 'var(--text-primary)', outline: 'none',
                textAlign: 'center',
              }}
            />
            of {memberCount}
          </span>
        )}
        <button
          onClick={() => onRemove(path)}
          title="Remove group"
          style={{ ...btnBase, marginLeft: 'auto', background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '13px' }}
        >
          ✕
        </button>
      </div>

      {/* Condition chips */}
      {conditions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginBottom: '5px' }}>
          {conditions.map(cond => (
            <span key={cond} style={{
              display: 'inline-flex', alignItems: 'center', gap: '3px',
              padding: '2px 6px', borderRadius: '3px', fontSize: '10px',
              background: 'rgba(41,98,255,0.12)', color: 'var(--blue)',
              fontFamily: 'var(--font-mono)', fontWeight: 600,
            }}>
              {COND_META[cond]?.short ?? cond}
              <button
                onClick={() => onRemoveCond(path, cond)}
                style={{ background: 'none', border: 'none', color: 'var(--blue)', cursor: 'pointer', fontSize: '11px', padding: '0', lineHeight: 1 }}
              >✕</button>
            </span>
          ))}
        </div>
      )}

      {/* Nested sub-groups */}
      {subGroups.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', margin: '0 0 5px 10px', paddingLeft: '6px', borderLeft: '2px solid var(--border)' }}>
          {subGroups.map((child, ci) => (
            <GroupEditor
              key={ci}
              group={child}
              path={[...path, ci]}
              depth={depth + 1}
              label="Subgroup"
              allConditions={allConditions}
              opBtn={opBtn}
              btnBase={btnBase}
              onSetOp={onSetOp}
              onSetMinMatch={onSetMinMatch}
              onAddCond={onAddCond}
              onRemoveCond={onRemoveCond}
              onAddSubGroup={onAddSubGroup}
              onRemove={onRemove}
            />
          ))}
        </div>
      )}

      {/* Add condition dropdown */}
      <select
        value=""
        onChange={e => { onAddCond(path, e.target.value); e.target.value = '' }}
        style={{
          width: '100%', height: '22px', padding: '0 4px', fontSize: '10px',
          background: 'var(--bg-raised)', border: '1px solid var(--border)',
          borderRadius: '3px', color: 'var(--text-muted)', cursor: 'pointer', outline: 'none',
        }}
      >
        <option value="">+ add condition…</option>
        {allConditions
          .filter(c => !conditions.includes(c))
          .map(c => (
            <option key={c} value={c}>
              {COND_META[c]?.short ?? c} — {COND_META[c]?.label ?? c}
            </option>
          ))
        }
      </select>

      {/* Add nested sub-group */}
      {canNest && (
        <button
          onClick={() => onAddSubGroup(path)}
          style={{
            ...btnBase, marginTop: '5px', alignSelf: 'flex-start',
            background: 'none', color: 'var(--text-muted)',
          }}
        >
          + Add subgroup
        </button>
      )}
    </div>
  )
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionLabel({ text }) {
  return (
    <div style={{
      padding: '12px 14px 6px',
      fontSize: '10px', fontWeight: 700,
      letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--text-muted)',
    }}>
      {text}
    </div>
  )
}

function Th({ children, left, title }) {
  return (
    <th
      title={title}
      style={{
        padding: '7px 10px',
        textAlign: left ? 'left' : 'center',
        fontWeight: 600, fontSize: '11px',
        color: 'var(--text-muted)',
        borderBottom: '1px solid var(--border)',
        whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      {children}
    </th>
  )
}

function ResultRow({ row, cols, zebra, onOpenChart }) {
  const bg = zebra ? 'var(--bg-raised)' : 'transparent'

  if (row.error) {
    return (
      <tr style={{ background: bg, opacity: 0.5 }}>
        <td style={{ padding: '6px 10px', fontFamily: 'var(--font-mono)', fontWeight: 700 }}>
          {row.symbol}
        </td>
        <td colSpan={cols.length + 2} style={{ padding: '6px 10px', color: 'var(--red)', fontSize: '11px' }}>
          Error: {row.error}
        </td>
      </tr>
    )
  }

  // Build a quick lookup: condition name → passed bool
  const condMap = {}
  for (const c of (row.conditions ?? [])) condMap[c.name] = c.passed

  return (
    <tr
      style={{ background: bg, cursor: 'pointer' }}
      onClick={() => onOpenChart(row.symbol)}
      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover, rgba(41,98,255,0.06))'}
      onMouseLeave={e => e.currentTarget.style.background = bg}
    >
      <td style={{
        padding: '6px 10px',
        fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: '12px',
        color: row.verdict ? 'var(--green)' : 'var(--red)',
        whiteSpace: 'nowrap',
      }}>
        {row.symbol}
      </td>
      <td style={{
        padding: '6px 10px', color: 'var(--text-secondary)', fontSize: '11px',
        maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {/* Name not in batch result — leave blank for now */}
      </td>
      {cols.map(name => (
        <td key={name} style={{ padding: '6px 10px', textAlign: 'center' }}>
          {name in condMap ? (
            <span style={{
              fontWeight: 700, fontSize: '13px',
              color: condMap[name] ? 'var(--green)' : 'var(--red)',
            }}>
              {condMap[name] ? '✓' : '✗'}
            </span>
          ) : (
            <span style={{ color: 'var(--text-muted)' }}>—</span>
          )}
        </td>
      ))}
      <td style={{ padding: '6px 10px', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '11px' }}>
        {row.score ?? '—'}/{row.total ?? '—'}
      </td>
      <td style={{ padding: '6px 10px', textAlign: 'center' }}>
        <span style={{
          display: 'inline-block',
          padding: '2px 8px', borderRadius: '4px', fontSize: '10px', fontWeight: 700,
          background: row.verdict
            ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.12)',
          color: row.verdict ? 'var(--green)' : 'var(--red)',
          letterSpacing: '0.05em',
        }}>
          {row.verdict ? 'PASS' : 'FAIL'}
        </span>
      </td>
    </tr>
  )
}
