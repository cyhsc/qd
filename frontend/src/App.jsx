import { useState, useCallback, useEffect, useRef } from 'react'
import { StockChart }     from './components/StockChart'
import { Watchlist }      from './components/Watchlist'
import { IndicatorPanel } from './components/IndicatorPanel'

// ── Configuration ────────────────────────────────────────────────────────────

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '10Y', 'MAX']

const INTRADAY_INTERVALS = ['1m', '2m', '5m', '15m', '30m', '1h', '90m']
const DAILY_INTERVALS    = ['D', 'W', 'M']
const INTERVAL_LABELS    = { D: 'Day', W: 'Week', M: 'Month' }

const INTRADAY_MAX_DAYS = {
  '1m': 7, '2m': 60, '5m': 60,
  '15m': 60, '30m': 60, '90m': 60, '1h': 730,
}
const RANGE_DAYS = {
  '1D': 1, '5D': 5, '1M': 30, '3M': 90,
  '6M': 180, '1Y': 365, '2Y': 730, '3Y': 1095, '5Y': 1825, '10Y': 3650, 'MAX': Infinity,
}

function isCompatible(range, ivl) {
  if (!ivl) return true
  const maxDays = INTRADAY_MAX_DAYS[ivl]
  if (maxDays == null) return true
  return RANGE_DAYS[range] <= maxDays
}

function bestRange(currentRange, ivl) {
  if (isCompatible(currentRange, ivl)) return currentRange
  const valid = RANGES.filter(r => isCompatible(r, ivl))
  return valid[valid.length - 1] ?? RANGES[0]
}

function priceChange(info) {
  if (!info?.current_price || !info?.prev_close) return null
  const diff = info.current_price - info.prev_close
  const pct  = (diff / info.prev_close) * 100
  return { diff, pct }
}

// ── Watchlist API ─────────────────────────────────────────────────────────────

const wlApi = {
  getAll:        ()              => fetch('/api/watchlists').then(r => r.json()),
  createList:    (name)          => fetch('/api/watchlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(r => r.json()),
  deleteList:    (id)            => fetch(`/api/watchlists/${id}`, { method: 'DELETE' }),
  addSymbol:     (id, sym, name) => fetch(`/api/watchlists/${id}/symbols`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym, name }) }),
  deleteSymbol:  (id, sym)       => fetch(`/api/watchlists/${id}/symbols/${sym}`, { method: 'DELETE' }),
}

function loadActiveListId() {
  return localStorage.getItem('qd_active_list_id') ?? '1'
}

// ── App ───────────────────────────────────────────────────────────────────────

export default function App() {
  // ── Helpers to read localStorage (used as fallback / initial seed) ──────────

  function lsJson(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) ?? 'null') ?? fallback }
    catch { return fallback }
  }

  // ── Theme ─────────────────────────────────────────────────────────────────
  // Applied immediately from localStorage to avoid a flash; backend value
  // overwrites it once preferences load.

  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem('qd_theme') ?? 'light'
    document.documentElement.dataset.theme = saved
    return saved
  })

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('qd_theme', theme)
  }, [theme])

  const toggleTheme = () => setTheme(t => t === 'light' ? 'dark' : 'light')

  // ── Chart / indicator config state ───────────────────────────────────────
  // Initialised from localStorage so the UI is immediately usable; the backend
  // load below may overwrite these once it resolves.

  const [input,         setInput]         = useState('')
  const [symbol,        setSymbol]        = useState('')
  const [range,         setRange]         = useState('1Y')
  const [interval,      setInterval]      = useState('D')
  const [info,          setInfo]          = useState(null)
  const [candles,       setCandles]       = useState(null)
  const [volume,        setVolume]        = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [maConfigs,     setMaConfigs]     = useState(() => lsJson('qd_ma_configs',     []))
  const [macdConfigs,   setMacdConfigs]   = useState(() => lsJson('qd_macd_configs',   []))
  const [guppyConfigs,  setGuppyConfigs]  = useState(() => lsJson('qd_guppy_configs',  []))
  const [rwbConfigs,    setRwbConfigs]    = useState(() => lsJson('qd_rwb_configs',    []))
  const [squeezeConfigs,setSqueezeConfigs]= useState(() => lsJson('qd_squeeze_configs',[]))

  // Pre-calculated indicator data from backend
  const [maData,      setMaData]      = useState({})
  const [guppyData,   setGuppyData]   = useState(null)
  const [macdData,    setMacdData]    = useState({})
  const [rwbData,     setRwbData]     = useState(null)
  const [squeezeData, setSqueezeData] = useState(null)

  // Analysis modal state
  const [analysisOpen,    setAnalysisOpen]    = useState(false)
  const [analysisData,    setAnalysisData]    = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError,   setAnalysisError]   = useState(null)

  // Watchlist state
  const [watchlists,   setWatchlists]   = useState([])
  const [activeListId, setActiveListId] = useState(loadActiveListId)
  const [wlLoading,    setWlLoading]    = useState(true)

  // ── Backend preferences ───────────────────────────────────────────────────

  // Build the full preferences object from current state
  const prefsSnapshot = useCallback(() => ({
    theme,
    activeListId,
    maConfigs,
    macdConfigs,
    guppyConfigs,
    rwbConfigs,
    squeezeConfigs,
  }), [theme, activeListId, maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs])

  // Save preferences to backend (fire-and-forget)
  const savePrefs = useCallback((data) => {
    fetch('/api/preferences', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    }).catch(() => {})
  }, [])

  // Debounce ref — avoid hammering the backend on rapid config changes
  const saveTimer = useRef(null)
  const scheduleSave = useCallback((data) => {
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => savePrefs(data), 800)
  }, [savePrefs])

  // Load preferences from backend on mount.
  // If backend has no preferences yet, seed it with the current localStorage values.
  const prefsLoaded = useRef(false)
  useEffect(() => {
    fetch('/api/preferences')
      .then(r => r.json())
      .then(({ data }) => {
        if (data && Object.keys(data).length > 0) {
          // Apply saved preferences
          if (data.theme)          { setTheme(data.theme); document.documentElement.dataset.theme = data.theme }
          if (data.maConfigs)      setMaConfigs(data.maConfigs)
          if (data.macdConfigs)    setMacdConfigs(data.macdConfigs)
          if (data.guppyConfigs)   setGuppyConfigs(data.guppyConfigs)
          if (data.rwbConfigs)     setRwbConfigs(data.rwbConfigs)
          if (data.squeezeConfigs) setSqueezeConfigs(data.squeezeConfigs)
          if (data.activeListId != null) setActiveListId(data.activeListId)
        } else {
          // First time — seed backend with current localStorage values
          savePrefs({
            theme,
            activeListId,
            maConfigs,
            macdConfigs,
            guppyConfigs,
            rwbConfigs,
            squeezeConfigs,
          })
        }
        prefsLoaded.current = true
      })
      .catch(() => { prefsLoaded.current = true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to backend whenever any preference changes (skip the initial mount)
  useEffect(() => {
    if (!prefsLoaded.current) return
    scheduleSave(prefsSnapshot())
  }, [theme, activeListId, maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load watchlists from backend on mount
  useEffect(() => {
    wlApi.getAll()
      .then(data => {
        setWatchlists(data.lists ?? [])
        setActiveListId(id => {
          const ids = (data.lists ?? []).map(l => l.id)
          return ids.includes(id) ? id : (ids[0] ?? id)
        })
      })
      .catch(() => setWatchlists([]))
      .finally(() => setWlLoading(false))
  }, [])

  // ── Fetch chart data ──────────────────────────────────────────────────────

  // range is NOT passed to the backend — we always fetch max data for the interval
  // and zoom the chart client-side based on the range selection
  const fetchStock = useCallback(async (sym, ivl) => {
    if (!sym) return
    setLoading(true)
    setError(null)

    try {
      const params = new URLSearchParams()
      if (ivl) params.set('interval', ivl)

      const [histRes, infoRes] = await Promise.all([
        fetch(`/api/stocks/${sym}/history?${params}`),
        fetch(`/api/stocks/${sym}/info`),
      ])

      if (!histRes.ok) {
        const body = await histRes.json()
        throw new Error(body.detail ?? `HTTP ${histRes.status}`)
      }

      const hist = await histRes.json()
      setCandles(hist.candles)
      setVolume(hist.volume)
      if (infoRes.ok) setInfo(await infoRes.json())
    } catch (e) {
      setError(e.message)
      setCandles(null)
      setVolume(null)
      setInfo(null)
    } finally {
      setLoading(false)
    }
  }, [])

  // ── Fetch indicator data ──────────────────────────────────────────────────
  // Runs after history is loaded (candles dep ensures cache is warm).
  // Clears stale data immediately so the chart doesn't show old indicators
  // for a new symbol while the fetch is in flight.

  const fetchIndicators = useCallback(async (sym, ivl, maCfgs, macdCfgs, guppyCfgs, rwbCfgs, sqzCfgs) => {
    const hasAny = maCfgs.length || macdCfgs.length || guppyCfgs.length || rwbCfgs.length || sqzCfgs.length
    if (!sym || !hasAny) {
      setMaData({}); setGuppyData(null); setMacdData({}); setRwbData(null); setSqueezeData(null); return
    }
    const params = new URLSearchParams()
    if (ivl) params.set('interval', ivl)
    maCfgs.forEach(m   => params.append('ma',   m.period))
    macdCfgs.forEach(m => params.append('macd', `${m.fast},${m.slow},${m.signal}`))
    if (guppyCfgs.length) params.set('guppy',   '1')
    if (rwbCfgs.length)   params.set('rwb',     '1')
    if (sqzCfgs.length)   params.set('squeeze', '1')
    try {
      const res = await fetch(`/api/stocks/${sym}/indicators?${params}`)
      if (!res.ok) return
      const data = await res.json()
      setMaData(data.ma         ?? {})
      setGuppyData(data.guppy   ?? null)
      setMacdData(data.macd     ?? {})
      setRwbData(data.rwb       ?? null)
      setSqueezeData(data.squeeze ?? null)
    } catch { /* indicators are optional */ }
  }, [])

  useEffect(() => {
    if (!symbol || !candles) {
      setMaData({}); setGuppyData(null); setMacdData({}); setRwbData(null); setSqueezeData(null); return
    }
    fetchIndicators(symbol, interval, maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs)
  }, [symbol, interval, maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs, candles, fetchIndicators])

  // ── Toolbar handlers ──────────────────────────────────────────────────────

  const handleSearch = (e) => {
    e.preventDefault()
    const sym = input.trim().toUpperCase()
    if (!sym) return
    setSymbol(sym)
    fetchStock(sym, interval)
  }

  const handleAnalysis = async () => {
    const sym = symbol || input.trim().toUpperCase()
    if (!sym) return
    setAnalysisOpen(true)
    setAnalysisData(null)
    setAnalysisError(null)
    setAnalysisLoading(true)
    try {
      const res = await fetch(`/api/stocks/${sym}/screen`)
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail ?? `HTTP ${res.status}`)
      }
      setAnalysisData(await res.json())
    } catch (e) {
      setAnalysisError(e.message)
    } finally {
      setAnalysisLoading(false)
    }
  }

  // Range only zooms — no re-fetch
  const handleRange = (rng) => {
    const nextInterval = interval && !isCompatible(rng, interval) ? null : interval
    setRange(rng)
    if (nextInterval !== interval) setInterval(null)
  }

  // Interval change requires new data (different bar size = different max period)
  const handleInterval = (ivl) => {
    const next       = ivl === interval ? null : ivl
    const nextRange  = next ? bestRange(range, next) : range
    setInterval(next)
    if (nextRange !== range) setRange(nextRange)
    if (symbol) fetchStock(symbol, next)
  }

  // ── Select symbol (from watchlist or search) ──────────────────────────────

  const selectSymbol = useCallback((sym) => {
    setSymbol(sym)
    setInput(sym)
    fetchStock(sym, interval)
  }, [fetchStock, interval])

  // ── Watchlist handlers ────────────────────────────────────────────────────

  const handleAddSymbol = useCallback(async (listId, sym) => {
    // Validate & get name from stock info endpoint
    try {
      const infoRes = await fetch(`/api/stocks/${sym}/info`)
      if (!infoRes.ok) return { ok: false, error: `Symbol '${sym}' not found` }
      const info = await infoRes.json()

      const res = await wlApi.addSymbol(listId, info.symbol, info.name)
      if (res.status === 409) return { ok: false, error: `${sym} is already in this list` }
      if (!res.ok) return { ok: false, error: 'Failed to add symbol' }

      setWatchlists(prev => prev.map(l =>
        l.id !== listId ? l : { ...l, symbols: [...l.symbols, { symbol: info.symbol, name: info.name }] }
      ))
      return { ok: true }
    } catch {
      return { ok: false, error: 'Failed to add symbol' }
    }
  }, [])

  const handleDeleteSymbol = useCallback(async (listId, sym) => {
    // Optimistic update
    setWatchlists(prev => prev.map(l =>
      l.id !== listId ? l : { ...l, symbols: l.symbols.filter(s => s.symbol !== sym) }
    ))
    if (symbol === sym) {
      setSymbol('')
      setCandles(null)
      setVolume(null)
      setInfo(null)
    }
    await wlApi.deleteSymbol(listId, sym)
  }, [symbol])

  const handleCreateList = useCallback(async (name) => {
    const newList = await wlApi.createList(name)
    setWatchlists(prev => [...prev, newList])
    setActiveListId(newList.id)
  }, [])

  // Creates a new list and writes symbols straight to the DB — no yfinance calls.
  // Invalid symbols are surfaced later when the user clicks them (chart error banner).
  const handleImportList = useCallback(async (name, symbols, onProgress) => {
    const newList = await wlApi.createList(name)
    // Show the empty list immediately so the tab appears
    setWatchlists(prev => [...prev, { ...newList, symbols: [] }])
    setActiveListId(newList.id)

    let done = 0, failed = 0
    const added = []

    // Pure DB inserts — all in parallel, no yfinance
    await Promise.all(symbols.map(async sym => {
      try {
        const r = await wlApi.addSymbol(newList.id, sym, sym)
        if (r.ok) added.push({ symbol: sym, name: sym })
        else if (r.status !== 409) failed++   // 409 = duplicate, not a real failure
      } catch {
        failed++
      }
      done++
      onProgress(done, symbols.length, failed)
    }))

    // One state update with all successfully inserted symbols
    setWatchlists(prev => prev.map(l =>
      l.id !== newList.id ? l : { ...l, symbols: added }
    ))
  }, [])

  const handleDeleteList = useCallback(async (id) => {
    // Optimistic update
    setWatchlists(prev => {
      const next = prev.filter(l => l.id !== id)
      return next.length ? next : prev
    })
    setActiveListId(prev => {
      if (prev !== id) return prev
      const remaining = watchlists.filter(l => l.id !== id)
      return remaining[0]?.id ?? prev
    })
    await wlApi.deleteList(id)
  }, [watchlists])

  const change = priceChange(info)

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden' }}>

      {/* ── Watchlist sidebar ── */}
      <Watchlist
        lists={watchlists}
        activeListId={activeListId}
        activeSymbol={symbol}
        loading={wlLoading}
        onSelectList={setActiveListId}
        onCreateList={handleCreateList}
        onImportList={handleImportList}
        onDeleteList={handleDeleteList}
        onSelectSymbol={selectSymbol}
        onDeleteSymbol={handleDeleteSymbol}
        onAddSymbol={handleAddSymbol}
      />

      {/* ── Main content ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

        {/* ── Header: logo + search ── */}
        <header style={{
          height: '48px', flexShrink: 0,
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center',
          padding: '0 20px', gap: '16px',
        }}>
          <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.04em' }}>QD</span>

          <form onSubmit={handleSearch} style={{ display: 'flex', gap: '6px' }}>
            <input
              value={input}
              onChange={e => setInput(e.target.value)}
              placeholder="Symbol — e.g. AAPL, TSLA"
              style={{
                width: '220px', height: '32px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '6px', padding: '0 10px',
                color: 'var(--text-primary)', fontSize: '13px', outline: 'none',
              }}
            />
            <button type="submit" style={{
              height: '32px', padding: '0 14px',
              background: 'var(--blue)', border: 'none',
              borderRadius: '6px', color: '#fff', fontSize: '12px', fontWeight: 600,
            }}>
              Go
            </button>
            <button
              type="button"
              onClick={handleAnalysis}
              disabled={!symbol && !input.trim()}
              style={{
                height: '32px', padding: '0 14px',
                background: '#f57c00',
                border: 'none',
                borderRadius: '6px', color: '#fff',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                opacity: (!symbol && !input.trim()) ? 0.4 : 1,
              }}
            >
              Analysis
            </button>
          </form>
        </header>

        {/* ── Toolbar: interval (left) + range (right) ── */}
        <div style={{
          height: '40px', flexShrink: 0,
          background: 'var(--bg-panel)',
          borderBottom: '1px solid var(--border)',
          display: 'flex', alignItems: 'center',
          padding: '0 16px', justifyContent: 'space-between',
        }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            {INTRADAY_INTERVALS.map(ivl => (
              <IntervalBtn key={ivl} label={ivl} active={interval === ivl} onClick={() => handleInterval(ivl)} />
            ))}
            <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 6px' }} />
            {DAILY_INTERVALS.map(ivl => (
              <IntervalBtn key={ivl} label={INTERVAL_LABELS[ivl]} active={interval === ivl} onClick={() => handleInterval(ivl)} />
            ))}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            {RANGES.map(r => {
              const disabled = interval ? !isCompatible(r, interval) : false
              return (
                <RangeBtn
                  key={r} label={r} active={range === r} disabled={disabled}
                  onClick={() => !disabled && handleRange(r)}
                />
              )
            })}
            <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
            <IndicatorPanel
              maConfigs={maConfigs}       onMaChange={setMaConfigs}
              macdConfigs={macdConfigs}   onMacdChange={setMacdConfigs}
              guppyConfigs={guppyConfigs} onGuppyChange={setGuppyConfigs}
              rwbConfigs={rwbConfigs}         onRwbChange={setRwbConfigs}
              squeezeConfigs={squeezeConfigs} onSqueezeChange={setSqueezeConfigs}
            />
            <button
              onClick={toggleTheme}
              title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
              style={{
                width: '28px', height: '28px', padding: 0,
                border: 'none', borderRadius: '5px',
                background: 'transparent',
                color: 'var(--text-secondary)',
                cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                transition: 'color 0.15s',
              }}
            >
              {theme === 'light' ? (
                /* Moon icon */
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
                </svg>
              ) : (
                /* Sun icon */
                <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
                  <circle cx="12" cy="12" r="5"/>
                  <line x1="12" y1="1" x2="12" y2="3" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="12" y1="21" x2="12" y2="23" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="1" y1="12" x2="3" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="21" y1="12" x2="23" y2="12" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                  <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* ── Price bar ── */}
        {info && (
          <div style={{
            flexShrink: 0,
            background: 'var(--bg-panel)',
            borderBottom: '1px solid var(--border)',
            padding: '8px 20px',
            display: 'flex', alignItems: 'baseline', gap: '12px',
          }}>
            <span style={{ fontSize: '13px', fontWeight: 700 }}>{info.symbol}</span>
            <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{info.name}</span>
            {info.sector && (
              <span style={{ fontSize: '11px', color: 'var(--text-primary)' }}>
                {info.sector}{info.industry ? ` · ${info.industry}` : ''}
              </span>
            )}
            {info.current_price != null && (
              <span style={{ fontSize: '20px', fontWeight: 600, marginLeft: '8px' }}>
                {info.current_price.toFixed(2)}
                <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '4px' }}>
                  {info.currency}
                </span>
              </span>
            )}
            {change && (
              <span style={{
                fontSize: '13px', fontWeight: 500,
                color: change.diff >= 0 ? 'var(--green)' : 'var(--red)',
              }}>
                {change.diff >= 0 ? '+' : ''}{change.diff.toFixed(2)}
                {' '}({change.diff >= 0 ? '+' : ''}{change.pct.toFixed(2)}%)
              </span>
            )}
          </div>
        )}

        {/* ── Chart area ── */}
        <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {!symbol && !loading && <Placeholder text="Select a symbol or search above" />}
          {loading && <Placeholder text="Loading…" />}
          {error && !loading && (
            <div style={{
              position: 'absolute', inset: 0,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <div style={{
                padding: '12px 20px', borderRadius: '8px',
                background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
                color: 'var(--red)', fontSize: '13px',
              }}>
                {error}
              </div>
            </div>
          )}
          {candles && !loading && (
            <StockChart
              candles={candles}    volume={volume}
              visibleDays={RANGE_DAYS[range]}
              theme={theme}
              maConfigs={maConfigs}       maData={maData}
              macdConfigs={macdConfigs}   macdData={macdData}
              guppyConfigs={guppyConfigs} guppyData={guppyData}
              rwbConfigs={rwbConfigs}         rwbData={rwbData}
              squeezeConfigs={squeezeConfigs} squeezeData={squeezeData}
            />
          )}
        </main>
      </div>

      {/* ── Analysis modal ── */}
      {analysisOpen && (
        <AnalysisModal
          loading={analysisLoading}
          error={analysisError}
          data={analysisData}
          onClose={() => setAnalysisOpen(false)}
        />
      )}
    </div>
  )
}

// ── Analysis modal ────────────────────────────────────────────────────────────

function SignSlope({ sign, slope, value }) {
  const signColor = sign === 'positive' ? 'var(--green)' : sign === 'negative' ? 'var(--red)' : 'var(--text-muted)'
  const slopeColor = slope === 'rising' ? 'var(--green)' : slope === 'falling' ? 'var(--red)' : 'var(--text-muted)'
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px' }}>
      <span style={{ color: signColor, fontWeight: 600 }}>{sign}</span>
      {' / '}
      <span style={{ color: slopeColor }}>{slope}</span>
      <span style={{ color: 'var(--text-muted)', marginLeft: '6px' }}>
        {value >= 0 ? '+' : ''}{value.toFixed(4)}
      </span>
    </span>
  )
}

function AnalysisModal({ loading, error, data, onClose }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '580px', maxHeight: '85vh',
          background: 'var(--bg-panel)',
          border: '1px solid var(--border)',
          borderRadius: '10px',
          display: 'flex', flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '14px 18px', borderBottom: '1px solid var(--border)', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 700, fontSize: '14px' }}>
            {data ? `Analysis — ${data.symbol}` : 'Analysis'}
          </span>
          <button onClick={onClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: '18px', lineHeight: 1, padding: '0 2px',
          }}>×</button>
        </div>

        {/* Body */}
        <div style={{ overflowY: 'auto', padding: '16px 18px', flex: 1 }}>
          {loading && (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: '13px' }}>
              Running analysis… (fetching 3 years of data)
            </div>
          )}
          {error && (
            <div style={{
              padding: '12px 16px', borderRadius: '6px',
              background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
              color: 'var(--red)', fontSize: '13px',
            }}>
              {error}
            </div>
          )}
          {data && (
            <>
              {/* Verdict banner */}
              {(() => {
                const required = data.conditions.filter(c => c.verdict_role !== null && c.verdict_role !== undefined)
                const failing  = required.filter(c => c.passed !== c.verdict_role)
                const passing  = required.length - failing.length
                return (
                  <div style={{
                    padding: '12px 16px', borderRadius: '8px', marginBottom: '16px',
                    background: data.verdict ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.1)',
                    border: `1px solid ${data.verdict ? 'var(--green)' : 'var(--red)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: failing.length ? '8px' : 0 }}>
                      <span style={{ fontSize: '20px', fontWeight: 700, color: data.verdict ? 'var(--green)' : 'var(--red)' }}>
                        {data.verdict ? 'PASS' : 'FAIL'}
                      </span>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {passing} / {required.length} required rules met
                      </span>
                    </div>
                    {failing.length > 0 && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                        {failing.map(c => (
                          <span key={c.name} style={{
                            fontSize: '10px', fontWeight: 600, fontFamily: 'var(--font-mono)',
                            padding: '2px 6px', borderRadius: '3px',
                            background: 'rgba(239,83,80,0.15)', color: 'var(--red)',
                          }}>
                            {c.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })()}

              {/* MACD */}
              <SectionHeader label="MACD  (12, 26, 9)" />
              <AnalysisTable rows={[
                ['Line',      data.macd.macd],
                ['Signal',    data.macd.signal],
                ['Histogram', data.macd.histogram],
              ]} />

              {/* RWB */}
              <SectionHeader label="RWB  (fast 3-15 / slow 30-60)" />
              <AnalysisTable rows={[
                ['RWB gap',    data.rwb.rwb],
                ['Fast width', data.rwb.fast_width],
                ['Slow width', data.rwb.slow_width],
              ]} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', paddingLeft: '2px' }}>
                Fast width &gt; slow width: {' '}
                <span style={{ color: data.rwb.fast_width_above_slow_width ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                  {String(data.rwb.fast_width_above_slow_width)}
                </span>
              </div>

              {/* SQZ */}
              <SectionHeader label="Squeeze Momentum" />
              <AnalysisTable rows={[['Momentum', data.sqz.momentum]]} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', paddingLeft: '2px' }}>
                Squeeze state: {' '}
                <span style={{
                  fontWeight: 600,
                  color: data.sqz.squeeze_state === 'off' ? 'var(--green)'
                       : data.sqz.squeeze_state === 'on'  ? 'var(--red)'
                       : 'var(--text-secondary)',
                }}>
                  {data.sqz.squeeze_state.toUpperCase()}
                </span>
              </div>

              {/* Conditions */}
              <SectionHeader label="Conditions" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {data.conditions.map((c, i) => {
                  const isRequired = c.verdict_role !== null && c.verdict_role !== undefined
                  const isFailing  = isRequired && c.passed !== c.verdict_role
                  return (
                    <div key={i} style={{
                      display: 'flex', alignItems: 'flex-start', gap: '8px',
                      padding: '6px 8px', borderRadius: '5px',
                      background: isFailing
                        ? 'rgba(239,83,80,0.1)'
                        : c.passed ? 'rgba(38,166,154,0.07)' : 'rgba(0,0,0,0.03)',
                      border: isFailing ? '1px solid rgba(239,83,80,0.3)' : '1px solid transparent',
                    }}>
                      <span style={{
                        flexShrink: 0, fontWeight: 700, fontSize: '12px', marginTop: '1px',
                        color: c.passed ? 'var(--green)' : 'var(--red)',
                      }}>
                        {c.passed ? '✓' : '✗'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '2px' }}>
                          <span style={{
                            fontSize: '10px', fontWeight: 700, fontFamily: 'var(--font-mono)',
                            color: 'var(--text-primary)',
                          }}>
                            {c.name}
                          </span>
                          {isRequired && (
                            <span style={{
                              fontSize: '9px', fontWeight: 600, padding: '1px 4px',
                              borderRadius: '3px', textTransform: 'uppercase', letterSpacing: '0.05em',
                              background: isFailing ? 'var(--red)' : 'rgba(41,98,255,0.15)',
                              color: isFailing ? '#fff' : 'var(--blue)',
                            }}>
                              {c.verdict_role ? 'required' : 'must-fail'}
                            </span>
                          )}
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          {c.description}
                        </span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function SectionHeader({ label }) {
  return (
    <div style={{
      fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
      letterSpacing: '0.08em', color: 'var(--text-muted)',
      marginBottom: '6px', marginTop: '4px',
    }}>
      {label}
    </div>
  )
}

function AnalysisTable({ rows }) {
  return (
    <div style={{
      border: '1px solid var(--border)', borderRadius: '6px',
      overflow: 'hidden', marginBottom: '12px', fontSize: '11px',
    }}>
      {rows.map(([label, la], i) => (
        <div key={label} style={{
          display: 'flex', alignItems: 'center',
          padding: '6px 10px',
          background: i % 2 === 0 ? 'transparent' : 'var(--bg-raised)',
          borderTop: i > 0 ? '1px solid var(--border)' : 'none',
        }}>
          <span style={{ width: '80px', flexShrink: 0, color: 'var(--text-muted)', fontWeight: 600 }}>
            {label}
          </span>
          <SignSlope sign={la.sign} slope={la.slope} value={la.value} />
        </div>
      ))}
    </div>
  )
}

// ── Small reusable components ─────────────────────────────────────────────────

function IntervalBtn({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      height: '28px', padding: '0 9px', border: 'none',
      borderRadius: '5px', fontSize: '11px', fontWeight: 500,
      background: active ? 'var(--bg-raised)' : 'transparent',
      color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
      transition: 'all 0.15s', cursor: 'pointer',
    }}>
      {label}
    </button>
  )
}

function RangeBtn({ label, active, disabled, onClick }) {
  return (
    <button onClick={onClick} style={{
      height: '28px', padding: '0 9px', border: 'none',
      borderRadius: '5px', fontSize: '11px', fontWeight: 500,
      background: active ? 'var(--bg-raised)' : 'transparent',
      color: disabled ? 'var(--text-muted)' : active ? 'var(--text-primary)' : 'var(--text-secondary)',
      opacity: disabled ? 0.35 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
      transition: 'all 0.15s',
    }}>
      {label}
    </button>
  )
}

function Placeholder({ text }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: 'var(--text-muted)', fontSize: '13px',
    }}>
      {text}
    </div>
  )
}
