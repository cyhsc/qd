import { useState, useMemo } from 'react'

// ── Condition display metadata ────────────────────────────────────────────────

const COND_META = {
  rwb_gap_positive:                         { short: 'RWB+',   label: 'RWB gap positive'          },
  rwb_gap_rising:                           { short: 'RWB↑',   label: 'RWB gap rising'            },
  rwb_slow_width_rising:                    { short: 'SW↑',    label: 'RWB slow-width rising'     },
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
}

// Conditions that have a threshold + operator parameter
const PARAMETRIC_CONDITIONS = [
  'sqz_consecutive_positive_bars',
  'macd_histogram_consecutive_positive_bars',
  'rwb_bars_since_fast_above_slow',
  'rwb_slow_width_consecutive_positive_bars',
  'rwb_fast_width_consecutive_positive_bars',
  'rwb_slow_width_consecutive_rising_bars',
  'rwb_fast_width_consecutive_rising_bars',
]

function shortName(name)  { return COND_META[name]?.short ?? name }
function labelName(name)  { return COND_META[name]?.label ?? name }

// ── Component ─────────────────────────────────────────────────────────────────

export function ScreenerPanel({
  watchlists,
  screenConfigs,
  activeConfigId,
  onOpenChart,       // (sym) → void — switches to chart tab and loads symbol
  onImportList,      // (name, symbols, onProgress) → Promise<void>
  onToggleRule,      // (condName, defaultRole) → void
  onConditionParam,  // (condName, key, val) → void
}) {
  const [universeMode,   setUniverseMode]   = useState('watchlist')
  const [selectedListId, setSelectedListId] = useState(() =>
    watchlists[0]?.id != null ? String(watchlists[0].id) : null
  )
  const [manualInput,    setManualInput]    = useState('')
  const [running,        setRunning]        = useState(false)
  const [screenData,     setScreenData]     = useState(null)   // response from /screen/batch
  const [runError,       setRunError]       = useState(null)
  const [savingList,     setSavingList]     = useState(false)
  const [saveNameInput,  setSaveNameInput]  = useState('')
  const [saveProgress,   setSaveProgress]  = useState(null)   // {done, total}

  const activeConfig    = screenConfigs.find(c => c.id === activeConfigId)
  const configConditions = activeConfig?.conditions ?? {}

  // ── Universe ───────────────────────────────────────────────────────────────

  const symbols = useMemo(() => {
    if (universeMode === 'watchlist') {
      const list = watchlists.find(l => String(l.id) === String(selectedListId))
      return (list?.symbols ?? []).map(s => s.symbol)
    }
    return manualInput.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  }, [universeMode, selectedListId, manualInput, watchlists])

  // ── Results columns ────────────────────────────────────────────────────────
  // Derive required condition column names from the first result that has conditions.

  const requiredCols = useMemo(() => {
    if (!screenData?.results?.length) return []
    const first = screenData.results.find(r => r.conditions?.length > 0)
    if (!first) return []
    return first.conditions
      .filter(c => c.verdict_role !== null && c.verdict_role !== undefined)
      .map(c => c.name)
  }, [screenData])

  // Sort results: passed first, failed next, errored last
  const sortedResults = useMemo(() => {
    if (!screenData?.results) return []
    return [...screenData.results].sort((a, b) => {
      const rank = r => r.error ? 2 : r.verdict ? 0 : 1
      return rank(a) - rank(b)
    })
  }, [screenData])

  // ── Handlers ───────────────────────────────────────────────────────────────

  async function handleRun() {
    if (!symbols.length || running) return
    setRunning(true)
    setScreenData(null)
    setRunError(null)
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
      setScreenData(await res.json())
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

        {/* Conditions section — scrolls independently so button is never hidden */}
        <SectionLabel text="CONDITIONS" />
        <div style={{ flex: 1, overflowY: 'auto', padding: '0 14px 8px' }}>
          {Object.keys(configConditions).length === 0 ? (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.5 }}>
              No conditions configured. Use the <strong>Analysis</strong> button on a stock to set up conditions.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {Object.entries(configConditions).map(([name, cfg]) => {
                const role  = 'verdict_role' in cfg ? cfg.verdict_role : null
                const isReq = role !== null && role !== undefined
                const isParametric = PARAMETRIC_CONDITIONS.includes(name)
                const p     = cfg ?? {}
                return (
                  <div key={name} style={{
                    padding: '6px 8px', borderRadius: '5px',
                    background: 'var(--bg-raised)',
                    border: '1px solid var(--border)',
                  }}>
                    {/* Row 1: toggle + name */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '7px' }}>
                      <button
                        onClick={() => onToggleRule(name, cfg.verdict_role ?? null)}
                        title={isReq ? 'Click to make optional' : 'Click to make required'}
                        style={{
                          flexShrink: 0,
                          fontSize: '9px', fontWeight: 700, padding: '2px 5px',
                          borderRadius: '3px', border: 'none', cursor: 'pointer',
                          letterSpacing: '0.04em', textTransform: 'uppercase',
                          background: isReq ? 'rgba(41,98,255,0.15)' : 'rgba(120,123,134,0.12)',
                          color: isReq ? 'var(--blue)' : 'var(--text-muted)',
                          minWidth: '52px', textAlign: 'center',
                        }}
                      >
                        {isReq ? 'required' : 'optional'}
                      </button>
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
                    {isParametric && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '5px', marginTop: '6px' }}>
                        <span style={{ fontSize: '10px', color: 'var(--text-muted)', flexShrink: 0 }}>bars</span>
                        <select
                          value={p.op ?? 'gt'}
                          onChange={e => onConditionParam(name, 'op', e.target.value)}
                          style={{
                            height: '22px', padding: '0 4px', fontSize: '10px',
                            background: 'var(--bg-panel)', border: '1px solid var(--border)',
                            borderRadius: '3px', color: 'var(--text-primary)', cursor: 'pointer', outline: 'none',
                          }}
                        >
                          <option value="gt">&gt;</option>
                          <option value="eq">=</option>
                          <option value="lt">&lt;</option>
                        </select>
                        <input
                          type="number"
                          min="1"
                          value={p.threshold ?? 3}
                          onChange={e => onConditionParam(name, 'threshold', Math.max(1, parseInt(e.target.value) || 1))}
                          style={{
                            width: '44px', height: '22px', padding: '0 4px', fontSize: '10px',
                            background: 'var(--bg-panel)', border: '1px solid var(--border)',
                            borderRadius: '3px', color: 'var(--text-primary)', textAlign: 'center', outline: 'none',
                          }}
                        />
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
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
