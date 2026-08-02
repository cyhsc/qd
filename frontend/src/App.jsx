import { useState, useCallback, useEffect, useRef } from 'react'
import { StockChart }    from './components/StockChart'
import { RenkoChart }    from './components/RenkoChart'
import { Watchlist }     from './components/Watchlist'
import { IndicatorPanel } from './components/IndicatorPanel'
import { ScreenerPanel } from './components/ScreenerPanel'
import { MarketPanel }  from './components/MarketPanel'
import { AgentPanel }   from './components/AgentPanel'

// ── Configuration ────────────────────────────────────────────────────────────

const RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '2Y', '3Y', '5Y', '10Y', 'MAX']

const INTRADAY_INTERVALS = ['1m', '5m', '15m', '30m', '1h']
const DAILY_INTERVALS    = ['D', 'W', 'M']

// Default display range when switching to an interval
const INTERVAL_DEFAULT_RANGE = {
  '1m': '1M', '5m': '1M', '15m': '1M', '30m': '1M', '1h': '1M',
  'D':  '1Y',
  'W':  '3Y',
  'M':  '10Y',
}
const INTERVAL_LABELS    = { D: 'Day', W: 'Week', M: 'Month' }

// Which named chart config to activate for each interval
// (null / anything else → 'Default')
const INTERVAL_CONFIG_NAME = { W: 'Weekly', M: 'Monthly' }

const INTRADAY_MAX_DAYS = {
  '1m': 7, '5m': 60,
  '15m': 60, '30m': 60, '1h': 730,
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

/**
 * Returns true if a chart config's indicators object has been populated
 * (i.e. it has at least one indicator series OR a non-default chart type).
 * Freshly-seeded configs have all-empty arrays and chartType='candlestick',
 * so they return false until the user configures them.
 */
function isConfigPopulated(ind) {
  if (!ind) return false
  return !!(
    ind.maConfigs?.length      ||
    ind.macdConfigs?.length    ||
    ind.guppyConfigs?.length   ||
    ind.rwbConfigs?.length     ||
    ind.squeezeConfigs?.length ||
    ind.screenIndConfigs?.length ||
    (ind.chartType && ind.chartType !== 'candlestick')
  )
}

// ── Watchlist API ─────────────────────────────────────────────────────────────

const wlApi = {
  getAll:        ()              => fetch('/api/watchlists').then(r => r.json()),
  createList:    (name)          => fetch('/api/watchlists', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).then(r => r.json()),
  deleteList:    (id)            => fetch(`/api/watchlists/${id}`, { method: 'DELETE' }),
  addSymbol:     (id, sym, name) => fetch(`/api/watchlists/${id}/symbols`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym, name }) }),
  deleteSymbol:  (id, sym)       => fetch(`/api/watchlists/${id}/symbols/${sym}`, { method: 'DELETE' }),
  reorderSymbols:(id, symbols)   => fetch(`/api/watchlists/${id}/symbols/reorder`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ symbols }) }),
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
  const [confirmDelete, setConfirmDelete] = useState(null)  // {id, name} | null
  const [range,         setRange]         = useState('1Y')
  const [interval,      setInterval]      = useState('D')
  const [chartType,     setChartType]     = useState(() => lsJson('qd_chart_type', 'candlestick'))

  // Persist chart type to localStorage (must be after useState above)
  useEffect(() => { localStorage.setItem('qd_chart_type', chartType) }, [chartType])
  const [info,          setInfo]          = useState(null)
  const [candles,       setCandles]       = useState(null)
  const [volume,        setVolume]        = useState(null)
  const [eventsData,    setEventsData]    = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [maConfigs,     setMaConfigs]     = useState(() => lsJson('qd_ma_configs',     []))
  const [macdConfigs,   setMacdConfigs]   = useState(() => lsJson('qd_macd_configs',   []))
  const [guppyConfigs,  setGuppyConfigs]  = useState(() => lsJson('qd_guppy_configs',  []))
  const [rwbConfigs,    setRwbConfigs]    = useState(() => lsJson('qd_rwb_configs',    []))
  const [squeezeConfigs,setSqueezeConfigs]= useState(() => lsJson('qd_squeeze_configs',[]))
  // Screen indicator panes — rows of { id, configId } (configId = screener config)
  const [screenIndConfigs, setScreenIndConfigs] = useState(() => lsJson('qd_screenind_configs', []))
  // Screen configs — list of { id, name, conditions } objects, persisted on backend
  const [screenConfigs,  setScreenConfigs]  = useState([])
  const [activeConfigId, setActiveConfigId] = useState(null)

  // Chart configs — list of { id, name, indicators } objects, persisted on backend
  const [chartConfigs,       setChartConfigs]       = useState([])
  const [activeChartConfigId, setActiveChartConfigId] = useState(null)

  // Pre-calculated indicator data from backend
  const [maData,      setMaData]      = useState({})
  const [guppyData,   setGuppyData]   = useState(null)
  const [macdData,    setMacdData]    = useState({})
  const [rwbData,     setRwbData]     = useState(null)
  const [squeezeData, setSqueezeData] = useState(null)
  const [screenIndData, setScreenIndData] = useState({})   // { rowId: [{time,value}] }

  const [topView,  setTopView]  = useState('chart')  // 'chart' | 'screener'
  const [mainTab, setMainTab] = useState('chart') // 'chart' | 'overview' | 'financials' | 'dividends'
  const [financialsData,    setFinancialsData]    = useState(null)
  const [financialsLoading, setFinancialsLoading] = useState(false)
  const [financialsSymbol,  setFinancialsSymbol]  = useState(null)
  const [dividendsData,     setDividendsData]     = useState(null)
  const [dividendsLoading,  setDividendsLoading]  = useState(false)
  const [dividendsSymbol,   setDividendsSymbol]   = useState(null)
  const [featureData,       setFeatureData]       = useState(null)
  const [featureLoading,    setFeatureLoading]    = useState(false)
  const [featureKey,        setFeatureKey]        = useState(null)   // `${symbol}:${norm}`
  const [featureNorm,       setFeatureNorm]       = useState('price') // 'price' | 'atr'

  // Analysis modal state
  const [analysisOpen,    setAnalysisOpen]    = useState(false)
  const [analysisData,    setAnalysisData]    = useState(null)
  const [analysisLoading, setAnalysisLoading] = useState(false)
  const [analysisError,   setAnalysisError]   = useState(null)

  // Watchlist state
  const [watchlists,   setWatchlists]   = useState([])
  const [activeListId, setActiveListId] = useState(loadActiveListId)
  const [wlLoading,    setWlLoading]    = useState(true)
  const [sidebarWidth, setSidebarWidth] = useState(() => lsJson('qd_sidebar_width', 220))

  // Sidebar resize drag
  const sidebarDragRef  = useRef(null)
  const symbolInputRef  = useRef(null)
  // Monotonic id for chart fetches so out-of-order responses can be discarded
  const fetchSeqRef     = useRef(0)
  const handleSidebarMouseDown = useCallback((e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarWidth
    document.body.style.userSelect = 'none'
    document.body.style.cursor = 'col-resize'
    const onMove = (ev) => {
      const next = Math.max(140, Math.min(400, startW + ev.clientX - startX))
      setSidebarWidth(next)
    }
    const onUp = () => {
      document.body.style.userSelect = ''
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setSidebarWidth(w => { localStorage.setItem('qd_sidebar_width', w); return w })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [sidebarWidth])

  // ── Backend preferences ───────────────────────────────────────────────────

  // Build the full preferences object from current state
  const prefsSnapshot = useCallback(() => ({
    theme,
    activeListId,
    activeChartConfigId,
  }), [theme, activeListId, activeChartConfigId])

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

  // Snapshot of whatever was in localStorage at startup — used to migrate old indicator
  // settings into the chart config system on first load if the backend config is empty.
  const initialIndicatorsRef = useRef({
    maConfigs:      lsJson('qd_ma_configs',     []),
    macdConfigs:    lsJson('qd_macd_configs',   []),
    guppyConfigs:   lsJson('qd_guppy_configs',  []),
    rwbConfigs:     lsJson('qd_rwb_configs',    []),
    squeezeConfigs: lsJson('qd_squeeze_configs',[]),
    screenIndConfigs: lsJson('qd_screenind_configs', []),
    chartType:      lsJson('qd_chart_type',     'candlestick'),
  })

  // Load preferences from backend on mount, then load chart configs.
  // Sequenced (not parallel) so the migration logic below has preferences available.
  const prefsLoaded = useRef(false)
  const chartConfigsLoaded = useRef(false)
  useEffect(() => {
    let savedActiveChartConfigId = null

    fetch('/api/preferences')
      .then(r => r.json())
      .then(({ data }) => {
        if (data && Object.keys(data).length > 0) {
          if (data.theme) { setTheme(data.theme); document.documentElement.dataset.theme = data.theme }
          if (data.activeListId != null) setActiveListId(data.activeListId)
          if (data.activeChartConfigId != null) {
            setActiveChartConfigId(data.activeChartConfigId)
            savedActiveChartConfigId = data.activeChartConfigId
          }
        } else {
          // First time — seed backend with current state
          savePrefs({ theme, activeListId, activeChartConfigId: null })
        }
        prefsLoaded.current = true
      })
      .then(() => fetch('/api/chart-configs'))
      .then(r => r.json())
      .then(configs => {
        setChartConfigs(configs)
        if (configs.length === 0) return
        // On load, pick the config for the current interval (interval starts as 'D' → 'Default').
        // Fall back to the previously saved config, then to the first available.
        const intervalName = INTERVAL_CONFIG_NAME[interval] ?? 'Default'
        const intervalCfg  = configs.find(c => c.name === intervalName)
        const saved = intervalCfg
          ?? configs.find(c => c.id === savedActiveChartConfigId)
          ?? configs[0]
        setActiveChartConfigId(saved.id)

        // If the saved config has no indicators, migrate from the localStorage snapshot
        const ind = saved.indicators ?? {}
        const isEmpty = !ind.maConfigs?.length && !ind.macdConfigs?.length &&
                        !ind.guppyConfigs?.length && !ind.rwbConfigs?.length &&
                        !ind.squeezeConfigs?.length
        const initial = initialIndicatorsRef.current
        const hasInitial = initial.maConfigs?.length || initial.macdConfigs?.length ||
                           initial.guppyConfigs?.length || initial.rwbConfigs?.length ||
                           initial.squeezeConfigs?.length
        if (isEmpty && hasInitial) {
          applyChartConfig(initial)
          // Persist the migrated indicators into this chart config
          fetch(`/api/chart-configs/${saved.id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: saved.name, indicators: initial }),
          }).catch(() => {})
          setChartConfigs(prev => prev.map(c =>
            c.id !== saved.id ? c : { ...c, indicators: initial }
          ))
        } else {
          applyChartConfig(saved.indicators)
        }

        chartConfigsLoaded.current = true
      })
      .catch(() => {
        prefsLoaded.current = true
        chartConfigsLoaded.current = true
      })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Persist to backend whenever any preference changes (skip the initial mount)
  useEffect(() => {
    if (!prefsLoaded.current) return
    scheduleSave(prefsSnapshot())
  }, [theme, activeListId, activeChartConfigId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Load watchlists from backend on mount
  const reloadWatchlists = useCallback(() => {
    wlApi.getAll()
      .then(data => {
        setWatchlists(data.lists ?? [])
        setActiveListId(id => {
          const ids = (data.lists ?? []).map(l => l.id)
          return ids.includes(id) ? id : (ids[0] ?? id)
        })
      })
      .catch(() => {})
  }, [])

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

  // Load screen configs from backend on mount
  useEffect(() => {
    fetch('/api/screen-configs')
      .then(r => r.json())
      .then(configs => {
        setScreenConfigs(configs)
        if (configs.length > 0) setActiveConfigId(configs[0].id)
      })
      .catch(() => {})
  }, [])

  // ── Screener config management ────────────────────────────────────────────

  // Conditions seeded when creating a new screener.
  // Backend default required conditions (matching _VERDICT_RULES in screen.py) start as true
  // so they're active immediately. All others default to null (informational).
  // Parametric conditions also include their default threshold / op.
  const DEFAULT_SCREENER_CONDITIONS = {
    // RWB — rwb_gap_positive and rwb_gap_rising are required by default
    rwb_gap_positive:                         { verdict_role: true, threshold: 0, op: 'gte' },
    rwb_gap_rising:                           { verdict_role: true },
    rwb_slow_width_rising:                    { verdict_role: null },
    rwb_fast_above_slow:                      { verdict_role: null },
    rwb_bars_since_fast_above_slow:           { verdict_role: null, threshold: 3, op: 'gt' },
    rwb_slow_width_consecutive_positive_bars: { verdict_role: null, threshold: 3, op: 'gt' },
    rwb_fast_width_consecutive_positive_bars: { verdict_role: null, threshold: 3, op: 'gt' },
    rwb_slow_width_consecutive_rising_bars:   { verdict_role: null, threshold: 3, op: 'gt' },
    rwb_fast_width_consecutive_rising_bars:   { verdict_role: null, threshold: 3, op: 'gt' },
    // MACD — macd_line_positive and macd_histogram_positive are required by default
    macd_line_positive:                       { verdict_role: true },
    macd_line_rising:                         { verdict_role: null },
    macd_histogram_positive:                  { verdict_role: true },
    macd_histogram_rising:                    { verdict_role: null },
    macd_signal_positive:                     { verdict_role: null },
    macd_histogram_consecutive_positive_bars: { verdict_role: null, threshold: 3, op: 'gt' },
    // SQZ — sqz_momentum_positive and sqz_not_on are required by default
    sqz_momentum_positive:                    { verdict_role: true },
    sqz_momentum_rising:                      { verdict_role: null },
    sqz_not_on:                               { verdict_role: true },
    sqz_consecutive_positive_bars:            { verdict_role: null, threshold: 3, op: 'gt' },
  }

  const handleCreateScreener = useCallback(async (name) => {
    const res = await fetch('/api/screen-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, conditions: DEFAULT_SCREENER_CONDITIONS }),
    })
    if (!res.ok) return null
    const created = await res.json()
    setScreenConfigs(prev => [...prev, created])
    setActiveConfigId(created.id)
    return created
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const requestDeleteScreener = useCallback((id) => {
    if (screenConfigs.length <= 1) return
    const cfg = screenConfigs.find(c => c.id === id)
    setConfirmDelete({ id, name: cfg?.name ?? '' })
  }, [screenConfigs])

  const handleDeleteScreener = useCallback(async (id) => {
    if (screenConfigs.length <= 1) return
    await fetch(`/api/screen-configs/${id}`, { method: 'DELETE' }).catch(() => {})
    setScreenConfigs(prev => {
      const next = prev.filter(c => c.id !== id)
      if (String(activeConfigId) === String(id)) setActiveConfigId(next[0]?.id ?? null)
      return next
    })
  }, [screenConfigs, activeConfigId])

  const handleRenameScreener = useCallback(async (id, name) => {
    const cfg = screenConfigs.find(c => c.id === id)
    if (!cfg) return
    setScreenConfigs(prev => prev.map(c => c.id !== id ? c : { ...c, name }))
    fetch(`/api/screen-configs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, conditions: cfg.conditions }),
    }).catch(() => {})
  }, [screenConfigs])

  // Save universe selection into the screener config's conditions JSON under '_universe'
  const screenerConfigsRef = useRef(screenConfigs)
  screenerConfigsRef.current = screenConfigs
  const handleSaveUniverse = useCallback((id, universeData) => {
    setScreenConfigs(prev => prev.map(c =>
      c.id !== id ? c : { ...c, conditions: { ...c.conditions, _universe: universeData } }
    ))
    fetch(`/api/screen-configs/${id}/conditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition_name: '_universe', settings: universeData }),
    }).catch(() => {})
  }, [])

  // Helper: push a config's indicators (including chartType) into live state
  function applyChartConfig(indicators) {
    if (!indicators) return
    setMaConfigs(     indicators.maConfigs      ?? [])
    setMacdConfigs(   indicators.macdConfigs    ?? [])
    setGuppyConfigs(  indicators.guppyConfigs   ?? [])
    setRwbConfigs(    indicators.rwbConfigs     ?? [])
    setSqueezeConfigs(indicators.squeezeConfigs ?? [])
    setScreenIndConfigs(indicators.screenIndConfigs ?? [])
    setChartType(     indicators.chartType      ?? 'candlestick')
  }

  // Debounce-save indicator changes to the active chart config
  const chartSaveTimer = useRef(null)
  const saveChartConfig = useCallback((id, indicators) => {
    clearTimeout(chartSaveTimer.current)
    chartSaveTimer.current = setTimeout(() => {
      const cfg = chartConfigs.find(c => c.id === id)
      if (!cfg) return
      fetch(`/api/chart-configs/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: cfg.name, indicators }),
      }).catch(() => {})
    }, 800)
  }, [chartConfigs])

  // ── Fetch chart data ──────────────────────────────────────────────────────

  // range is NOT passed to the backend — we always fetch max data for the interval
  // and zoom the chart client-side based on the range selection
  const fetchStock = useCallback(async (sym, ivl) => {
    if (!sym) return
    // Tag this request; if a newer selection starts before we finish, the
    // stale response is discarded so it can't clobber the current symbol's
    // data (and leave the chart parked on an old time window).
    const seq = ++fetchSeqRef.current
    const isStale = () => seq !== fetchSeqRef.current
    setLoading(true)
    setError(null)
    setEventsData(null)

    try {
      const params = new URLSearchParams()
      if (ivl) params.set('interval', ivl)

      const [histRes, infoRes] = await Promise.all([
        fetch(`/api/stocks/${sym}/history?${params}`),
        fetch(`/api/stocks/${sym}/info`),
      ])
      if (isStale()) return

      if (!histRes.ok) {
        const body = await histRes.json()
        throw new Error(body.detail ?? `HTTP ${histRes.status}`)
      }

      const hist = await histRes.json()
      if (isStale()) return
      setCandles(hist.candles)
      setVolume(hist.volume)
      if (infoRes.ok) setInfo(await infoRes.json())

      // Fetch events in the background (non-blocking — chart shows immediately)
      fetch(`/api/stocks/${sym}/events`)
        .then(r => r.ok ? r.json() : null)
        .then(d => { if (d && !isStale()) setEventsData(d) })
        .catch(() => {})
    } catch (e) {
      if (isStale()) return
      setError(e.message)
      setCandles(null)
      setVolume(null)
      setInfo(null)
    } finally {
      if (!isStale()) setLoading(false)
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
    // Indicators write to the same chart series as the candles. Tie them to the
    // current selection so a late response for a previous symbol can't call
    // setData on the chart (which would shift the time scale off the latest bars).
    const seq = fetchSeqRef.current
    const isStale = () => seq !== fetchSeqRef.current
    const params = new URLSearchParams()
    if (ivl) params.set('interval', ivl)
    maCfgs.forEach(m   => params.append('ma',   m.period))
    macdCfgs.forEach(m => params.append('macd', `${m.fast},${m.slow},${m.signal}`))
    if (guppyCfgs.length) params.set('guppy',   '1')
    if (rwbCfgs.length)   params.set('rwb',     '1')
    if (sqzCfgs.length)   params.set('squeeze', '1')
    try {
      const res = await fetch(`/api/stocks/${sym}/indicators?${params}`)
      if (!res.ok || isStale()) return
      const data = await res.json()
      if (isStale()) return
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

  // ── Fetch screen-indicator history (daily interval only) ─────────────────
  useEffect(() => {
    if (!symbol || !candles || interval !== 'D' || screenIndConfigs.length === 0) {
      setScreenIndData({})
      return
    }
    let cancelled = false
    ;(async () => {
      const entries = await Promise.all(screenIndConfigs.map(async cfg => {
        if (cfg.configId == null) return [cfg.id, null]
        try {
          const res = await fetch(`/api/stocks/${symbol}/screen-history?config_id=${cfg.configId}`)
          if (!res.ok) return [cfg.id, null]
          const d = await res.json()
          return [cfg.id, d.data]
        } catch {
          return [cfg.id, null]
        }
      }))
      if (!cancelled) setScreenIndData(Object.fromEntries(entries))
    })()
    return () => { cancelled = true }
  }, [symbol, interval, candles, screenIndConfigs])

  // ── Toolbar handlers ──────────────────────────────────────────────────────

  const handleSearch = (e) => {
    e.preventDefault()
    const sym = input.trim().toUpperCase()
    if (!sym) return
    setSymbol(sym)
    fetchStock(sym, interval)
    setInput('')
    symbolInputRef.current?.blur()
  }

  const activeChartConfigIdRef = useRef(activeChartConfigId)
  activeChartConfigIdRef.current = activeChartConfigId

  // Debounce-save all indicator state (including chartType) to the active chart config.
  // Skip the initial mount (chartConfigsLoaded guards against premature saves).
  useEffect(() => {
    if (!chartConfigsLoaded.current) return
    const id = activeChartConfigIdRef.current
    if (id == null) return
    const indicators = { maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs, screenIndConfigs, chartType }
    // Mirror into local state so switching configs sees the latest values
    setChartConfigs(prev => prev.map(c => c.id !== id ? c : { ...c, indicators }))
    saveChartConfig(id, indicators)
  }, [maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs, screenIndConfigs, chartType]) // eslint-disable-line react-hooks/exhaustive-deps

  // Switch to a different chart config — apply its indicators immediately
  const handleChartConfigChange = useCallback((id) => {
    const cfg = chartConfigs.find(c => c.id === id)
    if (!cfg) return
    setActiveChartConfigId(id)
    applyChartConfig(cfg.indicators)
  }, [chartConfigs]) // eslint-disable-line react-hooks/exhaustive-deps

  // Create a new chart config, seeded from the current indicator state
  const handleCreateChartConfig = useCallback(async (name) => {
    const indicators = {
      maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs, screenIndConfigs, chartType,
    }
    const res = await fetch('/api/chart-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, indicators }),
    })
    if (!res.ok) return
    const created = await res.json()
    setChartConfigs(prev => [...prev, created])
    setActiveChartConfigId(created.id)
  }, [maConfigs, macdConfigs, guppyConfigs, rwbConfigs, squeezeConfigs, screenIndConfigs, chartType])

  // Delete a chart config (must keep at least one)
  const handleDeleteChartConfig = useCallback(async (id) => {
    if (chartConfigs.length <= 1) return
    await fetch(`/api/chart-configs/${id}`, { method: 'DELETE' }).catch(() => {})
    setChartConfigs(prev => {
      const next = prev.filter(c => c.id !== id)
      if (activeChartConfigIdRef.current === id) {
        setActiveChartConfigId(next[0]?.id ?? null)
        applyChartConfig(next[0]?.indicators)
      }
      return next
    })
  }, [chartConfigs]) // eslint-disable-line react-hooks/exhaustive-deps

  const fetchFinancials = useCallback(async (sym) => {
    if (financialsSymbol === sym) return // already loaded
    setFinancialsLoading(true)
    setFinancialsData(null)
    try {
      const res = await fetch(`/api/stocks/${sym}/financials`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setFinancialsData(await res.json())
      setFinancialsSymbol(sym)
    } catch { /* silently show empty */ } finally {
      setFinancialsLoading(false)
    }
  }, [financialsSymbol])

  const fetchDividends = useCallback(async (sym) => {
    if (dividendsSymbol === sym) return
    setDividendsLoading(true)
    setDividendsData(null)
    try {
      const res = await fetch(`/api/stocks/${sym}/dividends`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setDividendsData(await res.json())
      setDividendsSymbol(sym)
    } catch { /* silently show empty */ } finally {
      setDividendsLoading(false)
    }
  }, [dividendsSymbol])

  const fetchFeatures = useCallback(async (sym, norm) => {
    const key = `${sym}:${norm}`
    if (featureKey === key) return
    setFeatureLoading(true)
    setFeatureData(null)
    try {
      const res = await fetch(`/api/stocks/${sym}/shape?normalize=${norm}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setFeatureData(await res.json())
      setFeatureKey(key)
    } catch { /* silently show empty */ } finally {
      setFeatureLoading(false)
    }
  }, [featureKey])

  const handleFeatureNorm = useCallback((norm) => {
    setFeatureNorm(norm)
    if (symbol) fetchFeatures(symbol, norm)
  }, [symbol, fetchFeatures])

  const handleTabChange = useCallback((tab) => {
    setMainTab(tab)
    if (tab === 'financials' && symbol) fetchFinancials(symbol)
    if (tab === 'dividends'  && symbol) fetchDividends(symbol)
    if (tab === 'feature'    && symbol) fetchFeatures(symbol, featureNorm)
  }, [symbol, fetchFinancials, fetchDividends, fetchFeatures, featureNorm])

  // Reload lazy tabs if symbol changes while on that tab
  useEffect(() => {
    if (mainTab === 'financials' && symbol && financialsSymbol !== symbol) fetchFinancials(symbol)
    if (mainTab === 'dividends'  && symbol && dividendsSymbol  !== symbol) fetchDividends(symbol)
    if (mainTab === 'feature'    && symbol) fetchFeatures(symbol, featureNorm)
  }, [symbol]) // eslint-disable-line react-hooks/exhaustive-deps

  // Patch a single condition in the active screen config (backend + local state)
  const patchCondition = useCallback((conditionName, settings) => {
    if (activeConfigId == null) return
    // Optimistic local update
    setScreenConfigs(prev => prev.map(cfg =>
      cfg.id !== activeConfigId ? cfg : {
        ...cfg,
        conditions: {
          ...cfg.conditions,
          [conditionName]: { ...(cfg.conditions[conditionName] ?? {}), ...settings },
        },
      }
    ))
    // Persist to backend
    fetch(`/api/screen-configs/${activeConfigId}/conditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition_name: conditionName, settings }),
    }).catch(() => {})
  }, [activeConfigId])

  const handleToggleRule = useCallback((conditionName, defaultRole) => {
    // Find current effective role from active config
    const config = screenConfigs.find(c => c.id === activeConfigId)
    const cond   = config?.conditions?.[conditionName] ?? {}
    const effective = 'verdict_role' in cond ? cond.verdict_role : defaultRole
    const next = effective !== null ? null : (defaultRole !== null ? defaultRole : true)
    patchCondition(conditionName, { verdict_role: next })
  }, [screenConfigs, activeConfigId, patchCondition])

  const handleConditionParam = useCallback((conditionName, key, value) => {
    patchCondition(conditionName, { [key]: value })
  }, [patchCondition])

  const handleSaveLogic = useCallback((logic) => {
    if (activeConfigId == null) return
    // Optimistic local update
    setScreenConfigs(prev => prev.map(cfg => {
      if (cfg.id !== activeConfigId) return cfg
      if (logic === null) {
        const { _logic, ...rest } = cfg.conditions ?? {}
        return { ...cfg, conditions: rest }
      }
      return { ...cfg, conditions: { ...cfg.conditions, _logic: logic } }
    }))
    // Persist: settings=null removes the key; settings=dict merges it in
    fetch(`/api/screen-configs/${activeConfigId}/conditions`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ condition_name: '_logic', settings: logic }),
    }).catch(() => {})
  }, [activeConfigId])

  const handleAnalysis = useCallback(async () => {
    const sym = symbol || input.trim().toUpperCase()
    if (!sym) return
    setAnalysisOpen(true)
    setAnalysisData(null)
    setAnalysisError(null)
    setAnalysisLoading(true)
    try {
      const qs = new URLSearchParams()
      if (activeConfigId != null) qs.set('config_id', activeConfigId)
      const res = await fetch(`/api/stocks/${sym}/screen?${qs}`)
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
  }, [symbol, input, activeConfigId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Re-run analysis when the active config's conditions change while the modal is open
  const analysisOpenRef = useRef(false)
  analysisOpenRef.current = analysisOpen
  const activeConditions = screenConfigs.find(c => c.id === activeConfigId)?.conditions
  useEffect(() => {
    if (!analysisOpenRef.current) return
    const t = setTimeout(() => handleAnalysis(), 400)
    return () => clearTimeout(t)
  }, [activeConditions]) // eslint-disable-line react-hooks/exhaustive-deps

  // Global keydown: route alphanumeric keys to the symbol input when nothing else is focused
  useEffect(() => {
    const onKeyDown = (e) => {
      // Ignore modifier combos (Ctrl/Cmd shortcuts)
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Ignore if already typing in any input / textarea / select
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // Ignore if the analysis modal is open (it has its own inputs)
      if (analysisOpenRef.current) return
      // Only intercept printable alphanumeric keys and Backspace
      if (!/^[a-zA-Z0-9]$/.test(e.key) && e.key !== 'Backspace') return
      symbolInputRef.current?.focus()
      // Select existing content so a fresh keystroke overwrites the current
      // symbol (e.g. after clicking a watchlist row, which fills the box).
      // Skip for Backspace so it deletes one char instead of wiping the box.
      if (e.key !== 'Backspace') symbolInputRef.current?.select()
      // Don't preventDefault — let the keystroke land naturally in the now-focused input
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // Range only zooms — no re-fetch
  const handleRange = (rng) => {
    const nextInterval = interval && !isCompatible(rng, interval) ? null : interval
    setRange(rng)
    if (nextInterval !== interval) setInterval(null)
  }

  // Interval change requires new data (different bar size = different max period).
  // Also auto-switches to the interval-specific chart config (W→Weekly, M→Monthly,
  // everything else→Default).
  const handleInterval = (ivl) => {
    const next      = ivl === interval ? null : ivl
    const nextRange = next ? (INTERVAL_DEFAULT_RANGE[next] ?? bestRange(range, next)) : range
    setInterval(next)
    if (nextRange !== range) setRange(nextRange)
    if (symbol) fetchStock(symbol, next)

    // Switch chart config for this interval
    const targetName = INTERVAL_CONFIG_NAME[next] ?? 'Default'
    const cfg = chartConfigs.find(c => c.name === targetName)
    if (cfg && cfg.id !== activeChartConfigId) {
      setActiveChartConfigId(cfg.id)
      // Only apply the config when it has been configured at least once.
      // If it is still empty (freshly seeded), keep the current indicators
      // as-is — they will be auto-saved to this config by the debounce-save
      // effect, so the config self-populates on the first visit.
      if (isConfigPopulated(cfg.indicators)) {
        applyChartConfig(cfg.indicators)
      }
    }
  }

  // ── Select symbol (from watchlist or search) ──────────────────────────────

  const selectSymbol = useCallback((sym) => {
    setSymbol(sym)
    setInput(sym)
    fetchStock(sym, interval)
  }, [fetchStock, interval])

  // Chart view: Up/Down arrows step through the active watchlist's symbols.
  useEffect(() => {
    if (topView !== 'chart') return
    const onKeyDown = (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
      if (e.ctrlKey || e.metaKey || e.altKey) return
      // Don't hijack arrows while typing / inside a control or open modal
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (analysisOpenRef.current) return

      const list = watchlists.find(l => l.id === activeListId)
      const syms = list?.symbols ?? []
      if (syms.length === 0) return

      const cur = syms.findIndex(s => s.symbol === symbol)
      let next
      if (cur === -1) {
        next = e.key === 'ArrowDown' ? 0 : syms.length - 1
      } else {
        next = cur + (e.key === 'ArrowDown' ? 1 : -1)
        if (next < 0 || next >= syms.length) return  // clamp at the ends
      }
      e.preventDefault()
      selectSymbol(syms[next].symbol)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [topView, watchlists, activeListId, symbol, selectSymbol])

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

  // Add one symbol to one or more OTHER existing lists. Returns per-list results
  // so the caller (modal) can report added / already-there / failed for each.
  const handleCopySymbolToLists = useCallback(async (targetListIds, sym, name) => {
    const results = await Promise.all(targetListIds.map(async id => {
      try {
        const res = await wlApi.addSymbol(id, sym, name || sym)
        return { id, ok: res.ok, duplicate: res.status === 409 }
      } catch {
        return { id, ok: false, duplicate: false }
      }
    }))
    // Optimistically update every list that actually got a new symbol
    const added = new Set(results.filter(r => r.ok).map(r => r.id))
    if (added.size) {
      setWatchlists(prev => prev.map(l =>
        added.has(l.id) ? { ...l, symbols: [...l.symbols, { symbol: sym, name: name || sym }] } : l
      ))
    }
    return results
  }, [])

  const handleReorderSymbols = useCallback((listId, symbols) => {
    // Optimistic local update
    setWatchlists(prev => prev.map(l =>
      l.id !== listId ? l : {
        ...l,
        symbols: symbols.map(sym => l.symbols.find(s => s.symbol === sym)).filter(Boolean),
      }
    ))
    // Persist to backend (fire-and-forget)
    wlApi.reorderSymbols(listId, symbols).catch(() => {})
  }, [])

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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>

      {/* ── Top nav bar: logo · tabs · theme ── */}
      <div style={{
        height: '40px', flexShrink: 0,
        background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', padding: '0 16px', gap: '8px',
      }}>
        <span style={{ fontWeight: 700, fontSize: '15px', letterSpacing: '0.04em', marginRight: '8px' }}>QD</span>

        {/* Top-level tabs */}
        {[
          { id: 'market',   label: 'Market'   },
          { id: 'chart',    label: 'Chart'    },
          { id: 'screener', label: 'Screener' },
          { id: 'agent',    label: 'Agent'    },
        ].map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTopView(id)}
            style={{
              height: '40px', padding: '0 16px',
              background: 'none', border: 'none',
              borderBottom: topView === id ? '2px solid var(--blue)' : '2px solid transparent',
              color: topView === id ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: '13px', fontWeight: topView === id ? 600 : 400,
              cursor: 'pointer', transition: 'color 0.1s',
            }}
          >
            {label}
          </button>
        ))}

        {/* Theme toggle pinned to the right */}
        <button
          onClick={toggleTheme}
          title={theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'}
          style={{
            marginLeft: 'auto',
            width: '32px', height: '32px', padding: 0,
            border: 'none', borderRadius: '6px',
            background: 'transparent', color: 'var(--text-secondary)',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
            transition: 'color 0.15s',
          }}
        >
          {theme === 'light' ? (
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
            </svg>
          ) : (
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

      {/* ── View area: fills remaining height ── */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>

      {/* ══════════════════════════════════════════════════════════════
          CHART VIEW
      ══════════════════════════════════════════════════════════════ */}
      <div style={{
        display: topView === 'chart' ? 'flex' : 'none',
        height: '100%', overflow: 'hidden',
      }}>

        {/* Watchlist sidebar */}
        <Watchlist
          width={sidebarWidth}
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
          onCopySymbol={handleCopySymbolToLists}
          onAddSymbol={handleAddSymbol}
          onReorderSymbols={handleReorderSymbols}
        />

        {/* Sidebar resize handle */}
        <div
          ref={sidebarDragRef}
          onMouseDown={handleSidebarMouseDown}
          style={{
            width: '4px', flexShrink: 0, cursor: 'col-resize',
            background: 'var(--border)', transition: 'background 0.15s',
          }}
          onMouseEnter={e => e.currentTarget.style.background = 'var(--blue)'}
          onMouseLeave={e => e.currentTarget.style.background = 'var(--border)'}
        />

        {/* Main content */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>

          {/* Search header */}
          <header style={{
            height: '48px', flexShrink: 0,
            background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', padding: '0 20px', gap: '16px',
          }}>
            <form onSubmit={handleSearch} style={{ display: 'flex', gap: '6px' }}>
              <input
                ref={symbolInputRef}
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
              }}>Go</button>
            </form>
          </header>

          {/* Inner tabs */}
          <div style={{
            display: 'flex', alignItems: 'flex-end',
            background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
            padding: '0 20px', flexShrink: 0, height: '36px',
          }}>
            {['chart', 'overview', 'financials', 'dividends', 'feature'].map(tab => (
              <button
                key={tab}
                onClick={() => handleTabChange(tab)}
                style={{
                  height: '36px', padding: '0 14px',
                  background: 'none', border: 'none',
                  borderBottom: mainTab === tab ? '2px solid var(--blue)' : '2px solid transparent',
                  color: mainTab === tab ? 'var(--text-primary)' : 'var(--text-muted)',
                  fontSize: '12px', fontWeight: mainTab === tab ? 600 : 400,
                  cursor: 'pointer', textTransform: 'capitalize', transition: 'color 0.1s',
                }}
              >{tab === 'feature' ? 'Feature Data' : tab}</button>
            ))}
          </div>

          {mainTab === 'overview'   && <OverviewPanel info={info} />}
          {mainTab === 'financials' && <FinancialsPanel data={financialsData} loading={financialsLoading} symbol={symbol} />}
          {mainTab === 'dividends'  && <DividendsPanel  data={dividendsData}  loading={dividendsLoading}  symbol={symbol} />}
          {mainTab === 'feature'    && <FeatureDataPanel data={featureData} loading={featureLoading} symbol={symbol} norm={featureNorm} onSetNorm={handleFeatureNorm} />}

          {mainTab === 'chart' && <>

          {/* Toolbar */}
          <div style={{
            height: '40px', flexShrink: 0,
            background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
            display: 'flex', alignItems: 'center', padding: '0 16px', justifyContent: 'space-between',
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
                  <RangeBtn key={r} label={r} active={range === r} disabled={disabled}
                    onClick={() => !disabled && handleRange(r)} />
                )
              })}
              <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
              <ChartTypeSelector value={chartType} onChange={setChartType} />
              <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
              <button
                type="button" onClick={handleAnalysis}
                disabled={!symbol && !input.trim()}
                title="Run analysis on current symbol"
                style={{
                  height: '24px', padding: '0 10px',
                  background: '#f57c00', border: 'none', borderRadius: '4px',
                  color: '#fff', fontSize: '11px', fontWeight: 600, cursor: 'pointer',
                  opacity: (!symbol && !input.trim()) ? 0.4 : 1,
                }}
              >Analysis</button>
              <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
              <IndicatorPanel
                maConfigs={maConfigs}       onMaChange={setMaConfigs}
                macdConfigs={macdConfigs}   onMacdChange={setMacdConfigs}
                guppyConfigs={guppyConfigs} onGuppyChange={setGuppyConfigs}
                rwbConfigs={rwbConfigs}         onRwbChange={setRwbConfigs}
                squeezeConfigs={squeezeConfigs} onSqueezeChange={setSqueezeConfigs}
                screenIndConfigs={screenIndConfigs} onScreenIndChange={setScreenIndConfigs}
                screenerConfigs={screenConfigs}
              />
              <div style={{ width: '1px', height: '16px', background: 'var(--border)', margin: '0 4px' }} />
              <ChartConfigSelector
                configs={chartConfigs}
                activeId={activeChartConfigId}
                onSelect={handleChartConfigChange}
                onCreate={handleCreateChartConfig}
                onDelete={handleDeleteChartConfig}
              />
            </div>
          </div>

          {/* Price bar */}
          {info && (
            <div style={{
              flexShrink: 0, background: 'var(--bg-panel)',
              borderBottom: '1px solid var(--border)', padding: '8px 20px',
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
                  <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '4px' }}>{info.currency}</span>
                </span>
              )}
              {change && (
                <span style={{ fontSize: '13px', fontWeight: 500, color: change.diff >= 0 ? 'var(--green)' : 'var(--red)' }}>
                  {change.diff >= 0 ? '+' : ''}{change.diff.toFixed(2)}
                  {' '}({change.diff >= 0 ? '+' : ''}{change.pct.toFixed(2)}%)
                </span>
              )}
            </div>
          )}

          {/* Chart area */}
          <main style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
            {!symbol && !loading && <Placeholder text="Select a symbol or search above" />}
            {loading && chartType !== 'renko' && <Placeholder text="Loading…" />}
            {error && !loading && chartType !== 'renko' && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{
                  padding: '12px 20px', borderRadius: '8px',
                  background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
                  color: 'var(--red)', fontSize: '13px',
                }}>{error}</div>
              </div>
            )}
            {candles && !loading && chartType !== 'renko' && (
              <StockChart
                candles={candles} volume={volume}
                chartType={chartType} visibleDays={RANGE_DAYS[range]} theme={theme}
                interval={interval ?? 'D'}
                events={eventsData}
                maConfigs={maConfigs}       maData={maData}
                macdConfigs={macdConfigs}   macdData={macdData}
                guppyConfigs={guppyConfigs} guppyData={guppyData}
                rwbConfigs={rwbConfigs}         rwbData={rwbData}
                squeezeConfigs={squeezeConfigs} squeezeData={squeezeData}
                screenIndConfigs={interval === 'D'
                  ? screenIndConfigs.map(c => ({
                      ...c,
                      name: screenConfigs.find(s => s.id === c.configId)?.name ?? `#${c.configId}`,
                    }))
                  : []}
                screenIndData={screenIndData}
              />
            )}
            {symbol && chartType === 'renko' && <RenkoChart symbol={symbol} theme={theme} />}
          </main>

          </>} {/* end mainTab === 'chart' */}
        </div>
      </div> {/* end Chart view */}

      {/* ══════════════════════════════════════════════════════════════
          SCREENER VIEW  —  always mounted for state preservation
      ══════════════════════════════════════════════════════════════ */}
      <div style={{
        display: topView === 'screener' ? 'flex' : 'none',
        height: '100%', overflow: 'hidden',
      }}>
        <ScreenerPanel
          watchlists={watchlists}
          screenConfigs={screenConfigs}
          activeConfigId={activeConfigId}
          onSwitchScreener={setActiveConfigId}
          onCreateScreener={handleCreateScreener}
          onDeleteScreener={requestDeleteScreener}
          onRenameScreener={handleRenameScreener}
          onSaveUniverse={handleSaveUniverse}
          onOpenChart={(sym) => { selectSymbol(sym); setTopView('chart') }}
          onImportList={handleImportList}
          onConditionParam={handleConditionParam}
          onSaveLogic={handleSaveLogic}
        />
      </div> {/* end Screener view */}

      {/* ══════════════════════════════════════════════════════════════
          MARKET VIEW
      ══════════════════════════════════════════════════════════════ */}
      <div style={{
        display: topView === 'market' ? 'flex' : 'none',
        height: '100%', overflow: 'hidden',
      }}>
        <MarketPanel theme={theme} />
      </div>

      {/* ══════════════════════════════════════════════════════════════
          AGENT VIEW
      ══════════════════════════════════════════════════════════════ */}
      <div style={{
        display: topView === 'agent' ? 'flex' : 'none',
        height: '100%', overflow: 'hidden',
      }}>
        <AgentPanel watchlists={watchlists} screenConfigs={screenConfigs} onNewWatchlist={reloadWatchlists} active={topView === 'agent'} />
      </div>

      </div> {/* end view area */}

      {/* ── Analysis modal ── */}
      {analysisOpen && (
        <AnalysisModal
          loading={analysisLoading}
          error={analysisError}
          data={analysisData}
          configConditions={screenConfigs.find(c => c.id === activeConfigId)?.conditions ?? {}}
          onToggleRule={handleToggleRule}
          onConditionParam={handleConditionParam}
          onClose={() => setAnalysisOpen(false)}
        />
      )}

      {/* ── Delete-screener confirmation ── */}
      {confirmDelete && (
        <ConfirmModal
          title="Delete screener"
          message={
            confirmDelete.name
              ? <>Delete <strong>{confirmDelete.name}</strong>? This cannot be undone.</>
              : 'Delete this screener? This cannot be undone.'
          }
          confirmLabel="Delete"
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => { handleDeleteScreener(confirmDelete.id); setConfirmDelete(null) }}
        />
      )}
    </div>
  )
}

// ── Confirmation modal ─────────────────────────────────────────────────────────

function ConfirmModal({ title, message, confirmLabel = 'Confirm', onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel()
      else if (e.key === 'Enter') onConfirm()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onConfirm, onCancel])

  return (
    <div
      onClick={onCancel}
      style={{
        position: 'fixed', inset: 0, zIndex: 1100,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '380px', background: 'var(--bg-panel)',
          border: '1px solid var(--border)', borderRadius: '10px',
          overflow: 'hidden', boxShadow: '0 8px 32px rgba(0,0,0,0.25)',
        }}
      >
        <div style={{
          padding: '14px 18px', borderBottom: '1px solid var(--border)',
          fontWeight: 700, fontSize: '14px',
        }}>{title}</div>
        <div style={{ padding: '18px', fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
          {message}
        </div>
        <div style={{
          display: 'flex', justifyContent: 'flex-end', gap: '8px',
          padding: '12px 18px', borderTop: '1px solid var(--border)',
        }}>
          <button
            onClick={onCancel}
            style={{
              height: '30px', padding: '0 14px', fontSize: '12px', fontWeight: 600,
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: '6px', color: 'var(--text-primary)', cursor: 'pointer',
            }}
          >Cancel</button>
          <button
            autoFocus
            onClick={onConfirm}
            style={{
              height: '30px', padding: '0 14px', fontSize: '12px', fontWeight: 600,
              background: 'var(--red)', border: 'none',
              borderRadius: '6px', color: '#fff', cursor: 'pointer',
            }}
          >{confirmLabel}</button>
        </div>
      </div>
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

function AnalysisModal({ loading, error, data, configConditions, onToggleRule, onConditionParam, onClose }) {
  // Effective role: config's verdict_role overrides the backend default stored in c.verdict_role.
  // The backend already applied the config when computing c.verdict_role, so they match —
  // but we read from configConditions directly so the UI is instant (no round-trip lag).
  const effectiveRole = (c) => {
    const cond = configConditions?.[c.name]
    return (cond && 'verdict_role' in cond) ? cond.verdict_role : c.verdict_role
  }
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
                const required = data.conditions.filter(c => effectiveRole(c) !== null && effectiveRole(c) !== undefined)
                const failing  = required.filter(c => c.passed !== effectiveRole(c))
                const passing  = required.length - failing.length
                const verdict  = failing.length === 0 && required.length > 0
                return (
                  <div style={{
                    padding: '12px 16px', borderRadius: '8px', marginBottom: '16px',
                    background: verdict ? 'rgba(38,166,154,0.12)' : 'rgba(239,83,80,0.1)',
                    border: `1px solid ${verdict ? 'var(--green)' : 'var(--red)'}`,
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: failing.length ? '8px' : 0 }}>
                      <span style={{ fontSize: '20px', fontWeight: 700, color: verdict ? 'var(--green)' : 'var(--red)' }}>
                        {verdict ? 'PASS' : 'FAIL'}
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
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', paddingLeft: '2px' }}>
                Consecutive positive histogram bars:{' '}
                <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                  {data.macd.consecutive_positive_bars}
                </span>
              </div>

              {/* RWB */}
              <SectionHeader label="RWB  (fast 3-15 / slow 30-60)" />
              <AnalysisTable rows={[
                ['RWB gap',    data.rwb.rwb],
                ['Fast width', data.rwb.fast_width],
                ['Slow width', data.rwb.slow_width],
              ]} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', paddingLeft: '2px', display: 'flex', gap: '16px' }}>
                <span>Fast width &gt; slow width:{' '}
                  <span style={{ color: data.rwb.fast_width_above_slow_width ? 'var(--green)' : 'var(--red)', fontWeight: 600 }}>
                    {String(data.rwb.fast_width_above_slow_width)}
                  </span>
                </span>
                <span>Bars since cross-up:{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.rwb.bars_since_fast_above_slow}
                  </span>
                </span>
                <span>Slow width positive bars:{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.rwb.slow_width_consecutive_positive_bars}
                  </span>
                </span>
                <span>Fast width positive bars:{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.rwb.fast_width_consecutive_positive_bars}
                  </span>
                </span>
                <span>Slow width rising bars:{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.rwb.slow_width_consecutive_rising_bars}
                  </span>
                </span>
                <span>Fast width rising bars:{' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.rwb.fast_width_consecutive_rising_bars}
                  </span>
                </span>
              </div>

              {/* SQZ */}
              <SectionHeader label="Squeeze Momentum" />
              <AnalysisTable rows={[['Momentum', data.sqz.momentum]]} />
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '12px', paddingLeft: '2px', display: 'flex', gap: '16px' }}>
                <span>Squeeze state: {' '}
                  <span style={{
                    fontWeight: 600,
                    color: data.sqz.squeeze_state === 'off' ? 'var(--green)'
                         : data.sqz.squeeze_state === 'on'  ? 'var(--red)'
                         : 'var(--text-secondary)',
                  }}>
                    {data.sqz.squeeze_state.toUpperCase()}
                  </span>
                </span>
                <span>Consecutive positive bars: {' '}
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {data.sqz.consecutive_positive_bars}
                  </span>
                </span>
              </div>

              {/* Conditions */}
              <SectionHeader label="Conditions" />
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {data.conditions.map((c, i) => {
                  const role       = effectiveRole(c)
                  const isRequired = role !== null && role !== undefined
                  const isFailing  = isRequired && c.passed !== role
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
                          <button
                            onClick={() => onToggleRule(c.name, c.verdict_role)}
                            title={isRequired ? 'Click to make optional' : 'Click to make required'}
                            style={{
                              fontSize: '9px', fontWeight: 600, padding: '1px 5px',
                              borderRadius: '3px', textTransform: 'uppercase', letterSpacing: '0.05em',
                              border: 'none', cursor: 'pointer',
                              background: isRequired
                                ? (isFailing ? 'var(--red)' : 'rgba(41,98,255,0.15)')
                                : 'rgba(120,123,134,0.15)',
                              color: isRequired
                                ? (isFailing ? '#fff' : 'var(--blue)')
                                : 'var(--text-muted)',
                            }}
                          >
                            {isRequired ? (role ? 'required' : 'must-fail') : 'optional'}
                          </button>
                        </div>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', lineHeight: 1.4 }}>
                          {c.description}
                        </span>
                        {(c.name === 'sqz_consecutive_positive_bars' || c.name === 'macd_histogram_consecutive_positive_bars' || c.name === 'rwb_bars_since_fast_above_slow' || c.name === 'rwb_slow_width_consecutive_positive_bars' || c.name === 'rwb_fast_width_consecutive_positive_bars' || c.name === 'rwb_slow_width_consecutive_rising_bars' || c.name === 'rwb_fast_width_consecutive_rising_bars') && (() => {
                          const p = configConditions?.[c.name] ?? { threshold: 3, op: 'gt' }
                          return (
                            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px' }}>
                              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>Consecutive bars</span>
                              <select
                                value={p.op}
                                onChange={e => onConditionParam(c.name, 'op', e.target.value)}
                                style={{
                                  height: '22px', padding: '0 4px', fontSize: '11px',
                                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                                  borderRadius: '3px', color: 'var(--text-primary)', cursor: 'pointer',
                                }}
                              >
                                <option value="gt">greater than</option>
                                <option value="eq">equal to</option>
                                <option value="lt">less than</option>
                              </select>
                              <input
                                type="number"
                                min="1"
                                value={p.threshold}
                                onChange={e => onConditionParam(c.name, 'threshold', Math.max(1, parseInt(e.target.value) || 1))}
                                style={{
                                  width: '48px', height: '22px', padding: '0 4px', fontSize: '11px',
                                  background: 'var(--bg-raised)', border: '1px solid var(--border)',
                                  borderRadius: '3px', color: 'var(--text-primary)', textAlign: 'center',
                                }}
                              />
                            </div>
                          )
                        })()}
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

// ── Chart config selector ─────────────────────────────────────────────────────

function ChartConfigSelector({ configs, activeId, onSelect, onCreate, onDelete }) {
  const [creating, setCreating] = useState(false)
  const [nameInput, setNameInput] = useState('')

  const handleCreate = (e) => {
    e.preventDefault()
    const name = nameInput.trim()
    if (!name) return
    onCreate(name)
    setNameInput('')
    setCreating(false)
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
      {creating ? (
        <form onSubmit={handleCreate} style={{ display: 'flex', alignItems: 'center', gap: '3px' }}>
          <input
            autoFocus
            value={nameInput}
            onChange={e => setNameInput(e.target.value)}
            placeholder="Config name…"
            onKeyDown={e => e.key === 'Escape' && setCreating(false)}
            style={{
              height: '24px', width: '110px', padding: '0 6px',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: '4px', color: 'var(--text-primary)', fontSize: '11px', outline: 'none',
            }}
          />
          <button type="submit" style={{
            height: '24px', padding: '0 7px', fontSize: '11px',
            background: 'var(--blue)', border: 'none', borderRadius: '4px',
            color: '#fff', cursor: 'pointer',
          }}>OK</button>
          <button type="button" onClick={() => setCreating(false)} style={{
            height: '24px', padding: '0 6px', fontSize: '13px',
            background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer',
          }}>×</button>
        </form>
      ) : (
        <>
          <select
            value={activeId ?? ''}
            onChange={e => onSelect(Number(e.target.value))}
            style={{
              height: '24px', padding: '0 4px',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: '4px', color: 'var(--text-primary)',
              fontSize: '11px', cursor: 'pointer', outline: 'none', maxWidth: '110px',
            }}
          >
            {configs.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          {configs.length > 1 && (
            <button
              onClick={() => onDelete(activeId)}
              title="Delete this chart config"
              style={{
                height: '24px', padding: '0 5px', fontSize: '14px',
                background: 'none', border: 'none',
                color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1,
              }}
            >×</button>
          )}
          <button
            onClick={() => setCreating(true)}
            title="New chart config"
            style={{
              height: '24px', padding: '0 5px', fontSize: '16px',
              background: 'none', border: 'none',
              color: 'var(--text-muted)', cursor: 'pointer', lineHeight: 1,
            }}
          >+</button>
        </>
      )}
    </div>
  )
}

// ── Chart type selector ───────────────────────────────────────────────────────

const CHART_TYPE_OPTIONS = [
  { value: 'candlestick', label: 'Candles' },
  { value: 'bars',        label: 'Bars'    },
  { value: 'line',        label: 'Line'    },
  { value: 'renko',       label: 'Renko'   },
]

function ChartTypeSelector({ value, onChange }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      title="Chart type"
      style={{
        height: '24px', padding: '0 6px',
        background: 'var(--bg-raised)', border: '1px solid var(--border)',
        borderRadius: '4px', color: 'var(--text-primary)',
        fontSize: '11px', fontWeight: 500, cursor: 'pointer', outline: 'none',
      }}
    >
      {CHART_TYPE_OPTIONS.map(opt => (
        <option key={opt.value} value={opt.value}>{opt.label}</option>
      ))}
    </select>
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

// ── Overview panel ────────────────────────────────────────────────────────────

function OverviewStat({ label, value, color }) {
  if (value == null) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
        {label}
      </span>
      <span style={{ fontSize: '13px', fontWeight: 600, color: color || 'var(--text-primary)' }}>
        {value}
      </span>
    </div>
  )
}

function OverviewPanel({ info }) {
  if (!info) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
        Search for a symbol to see overview
      </div>
    )
  }

  const stats = [
    { label: 'Market Cap',      value: info.market_cap },
    { label: 'Trailing P/E',    value: info.trailing_pe },
    { label: 'Forward P/E',     value: info.forward_pe },
    { label: 'Price / Book',    value: info.price_to_book },
    { label: 'TTM Yield',       value: info.dividend_yield != null ? `${info.dividend_yield.toFixed(2)}%` : null },
    { label: '52W High',        value: info['52w_high'] },
    { label: '52W Low',         value: info['52w_low'] },
    { label: 'Avg Volume',      value: info.avg_volume },
    { label: 'Revenue',         value: info.revenue },
    { label: 'Gross Profit',    value: info.gross_profit },
    { label: 'EBITDA',          value: info.ebitda },
    { label: 'Debt / Equity',   value: info.debt_to_equity },
    { label: 'ROE',             value: info.return_on_equity != null ? `${info.return_on_equity}%` : null,
      color: info.return_on_equity > 0 ? 'var(--green)' : info.return_on_equity < 0 ? 'var(--red)' : undefined },
    { label: 'ROA',             value: info.return_on_assets != null ? `${info.return_on_assets}%` : null,
      color: info.return_on_assets > 0 ? 'var(--green)' : info.return_on_assets < 0 ? 'var(--red)' : undefined },
    { label: 'Revenue Growth',  value: info.revenue_growth != null ? `${info.revenue_growth}%` : null,
      color: info.revenue_growth > 0 ? 'var(--green)' : info.revenue_growth < 0 ? 'var(--red)' : undefined },
    { label: 'Earnings Growth', value: info.earnings_growth != null ? `${info.earnings_growth}%` : null,
      color: info.earnings_growth > 0 ? 'var(--green)' : info.earnings_growth < 0 ? 'var(--red)' : undefined },
    { label: 'Employees',       value: info.employees?.toLocaleString() },
    { label: 'Country',         value: info.country },
  ]

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
      {/* Name + meta */}
      <div style={{ marginBottom: '20px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '10px', marginBottom: '4px' }}>
          <span style={{ fontSize: '20px', fontWeight: 700 }}>{info.symbol}</span>
          <span style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>{info.name}</span>
          {info.exchange && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{info.exchange}</span>
          )}
        </div>
        {info.sector && (
          <span style={{ fontSize: '12px', color: 'var(--text-primary)' }}>
            {info.sector}{info.industry ? ` · ${info.industry}` : ''}
          </span>
        )}
        {info.website && (
          <a href={info.website} target="_blank" rel="noreferrer"
            style={{ display: 'block', fontSize: '11px', color: 'var(--blue)', marginTop: '4px' }}>
            {info.website}
          </a>
        )}
      </div>

      {/* Stats grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))',
        gap: '16px 24px',
        marginBottom: '24px',
        padding: '16px',
        background: 'var(--bg-raised)',
        borderRadius: '8px',
        border: '1px solid var(--border)',
      }}>
        {stats.map(s => <OverviewStat key={s.label} label={s.label} value={s.value} color={s.color} />)}
      </div>

      {/* Description */}
      {info.description && (
        <div>
          <div style={{
            fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
            letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '8px',
          }}>
            About
          </div>
          <p style={{
            fontSize: '13px', lineHeight: 1.7,
            color: 'var(--text-secondary)', margin: 0,
            maxWidth: '800px',
          }}>
            {info.description}
          </p>
        </div>
      )}
    </div>
  )
}

// ── Financials panel ──────────────────────────────────────────────────────────

// Ordered row definitions: { key, level, expandable? }
// level 0 = bold parent row, level 1 = indented child row
// Rows not in the list are appended at the end as level-0 rows.
const INCOME_ROWS = [
  { key: 'Total Revenue',                             level: 0 },
  { key: 'Operating Revenue',                         level: 1 },
  { key: 'Cost Of Revenue',                           level: 1 },
  { key: 'Gross Profit',                              level: 0 },
  { key: 'Operating Expense',                         level: 0 },
  { key: 'Research And Development',                  level: 1 },
  { key: 'Research Development',                      level: 1 },
  { key: 'Selling General And Administrative',        level: 1 },
  { key: 'Selling General Administrative',            level: 1 },
  { key: 'Other Operating Expenses',                  level: 1 },
  { key: 'Total Operating Expenses',                  level: 1 },
  { key: 'Operating Income',                          level: 0 },
  { key: 'Operating Income Or Loss',                  level: 0 },
  { key: 'Net Non Operating Interest Income Expense', level: 0 },
  { key: 'Interest Income Non Operating',             level: 1 },
  { key: 'Interest Expense Non Operating',            level: 1 },
  { key: 'Interest Expense',                          level: 1 },
  { key: 'Total Other Income Expense Net',            level: 1 },
  { key: 'Other Income Expense',                      level: 0 },
  { key: 'Pretax Income',                             level: 0 },
  { key: 'Income Before Tax',                         level: 0 },
  { key: 'Tax Provision',                             level: 1 },
  { key: 'Income Tax Expense',                        level: 1 },
  { key: 'Net Income Common Stockholders',            level: 0 },
  { key: 'Net Income',                                level: 1 },
  { key: 'Net Income From Continuing Ops',            level: 1 },
  { key: 'Minority Interests',                        level: 1 },
  { key: 'Net Income Applicable To Common Shares',    level: 1 },
  { key: 'Basic EPS',                                 level: 0 },
  { key: 'Basic Average Shares',                      level: 1 },
  { key: 'Diluted EPS',                               level: 0 },
  { key: 'Diluted Average Shares',                    level: 1 },
  { key: 'EBITDA',                                    level: 0 },
  { key: 'Ebitda',                                    level: 0 },
]

const BALANCE_ROWS = [
  { key: 'Total Assets',                                   level: 0 },
  { key: 'Current Assets',                                 level: 0 },
  { key: 'Total Current Assets',                           level: 0 },
  { key: 'Cash And Cash Equivalents',                      level: 1 },
  { key: 'Cash Cash Equivalents And Short Term Investments', level: 1 },
  { key: 'Other Short Term Investments',                   level: 1 },
  { key: 'Net Receivables',                                level: 1 },
  { key: 'Inventory',                                      level: 1 },
  { key: 'Other Current Assets',                           level: 1 },
  { key: 'Total Non Current Assets',                       level: 0 },
  { key: 'Net PPE',                                        level: 1 },
  { key: 'Property Plant Equipment',                       level: 1 },
  { key: 'Goodwill',                                       level: 1 },
  { key: 'Intangible Assets',                              level: 1 },
  { key: 'Long Term Investments',                          level: 1 },
  { key: 'Other Non Current Assets',                       level: 1 },
  { key: 'Total Liabilities Net Minority Interest',        level: 0 },
  { key: 'Total Liabilities',                              level: 0 },
  { key: 'Current Liabilities',                            level: 0 },
  { key: 'Total Current Liabilities',                      level: 0 },
  { key: 'Payables And Accrued Expenses',                  level: 1 },
  { key: 'Accounts Payable',                               level: 1 },
  { key: 'Current Debt',                                   level: 1 },
  { key: 'Short Long Term Debt',                           level: 1 },
  { key: 'Other Current Liabilities',                      level: 1 },
  { key: 'Total Non Current Liabilities Net Minority Interest', level: 0 },
  { key: 'Long Term Debt',                                 level: 1 },
  { key: 'Other Non Current Liabilities',                  level: 1 },
  { key: 'Stockholders Equity',                            level: 0 },
  { key: 'Total Equity Gross Minority Interest',           level: 0 },
  { key: 'Common Stock Equity',                            level: 0 },
  { key: 'Retained Earnings',                              level: 1 },
  { key: 'Common Stock',                                   level: 1 },
  { key: 'Additional Paid In Capital',                     level: 1 },
  { key: 'Treasury Stock',                                 level: 1 },
]

const CASHFLOW_ROWS = [
  { key: 'Operating Cash Flow',                         level: 0 },
  { key: 'Total Cash From Operating Activities',        level: 0 },
  { key: 'Net Income From Continuing Operations',       level: 1 },
  { key: 'Net Income',                                  level: 1 },
  { key: 'Depreciation Amortization Depletion',         level: 1 },
  { key: 'Depreciation And Amortization',               level: 1 },
  { key: 'Deferred Tax',                                level: 1 },
  { key: 'Stock Based Compensation',                    level: 1 },
  { key: 'Change In Working Capital',                   level: 1 },
  { key: 'Change In Receivables',                       level: 2 },
  { key: 'Change In Inventory',                         level: 2 },
  { key: 'Change In Payables',                          level: 2 },
  { key: 'Other Non Cash Items',                        level: 1 },
  { key: 'Investing Cash Flow',                         level: 0 },
  { key: 'Total Cash From Investing Activities',        level: 0 },
  { key: 'Capital Expenditure',                         level: 1 },
  { key: 'Net PPE Purchase And Sale',                   level: 1 },
  { key: 'Net Business Purchase And Sale',              level: 1 },
  { key: 'Net Investment Purchase And Sale',            level: 1 },
  { key: 'Other Investing Activities',                  level: 1 },
  { key: 'Financing Cash Flow',                         level: 0 },
  { key: 'Total Cash From Financing Activities',        level: 0 },
  { key: 'Net Short Term Debt Issuance',                level: 1 },
  { key: 'Net Long Term Debt Issuance',                 level: 1 },
  { key: 'Net Common Stock Issuance',                   level: 1 },
  { key: 'Cash Dividends Paid',                         level: 1 },
  { key: 'Other Financing Activities',                  level: 1 },
  { key: 'End Cash Position',                           level: 0 },
  { key: 'Free Cash Flow',                              level: 0 },
]

const STMT_ROW_DEFS = { income: INCOME_ROWS, balance: BALANCE_ROWS, cashflow: CASHFLOW_ROWS }

// Format a raw dollar value into millions with commas, matching Yahoo Finance style
function fmtM(v) {
  if (v == null) return '—'
  const millions = v / 1e6
  const abs = Math.abs(millions)
  const formatted = abs.toLocaleString('en-US', { maximumFractionDigits: abs < 10 ? 2 : 0 })
  return millions < 0 ? `(${formatted})` : formatted
}

function fmtEPS(v) {
  if (v == null) return '—'
  return v < 0 ? `(${Math.abs(v).toFixed(2)})` : v.toFixed(2)
}

const EPS_ROWS = new Set(['Basic EPS', 'Diluted EPS', 'Basic Eps', 'Diluted Eps'])
const SHARE_ROWS = new Set(['Basic Average Shares', 'Diluted Average Shares'])

function fmtVal(label, v) {
  if (EPS_ROWS.has(label)) return fmtEPS(v)
  if (SHARE_ROWS.has(label)) return v == null ? '—' : (v / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 }) + 'M'
  return fmtM(v)
}

function pctChange(curr, prev) {
  if (curr == null || prev == null || prev === 0) return null
  return ((curr - prev) / Math.abs(prev)) * 100
}

function FinancialTable({ table, stmtKey, collapsed, onToggle }) {
  if (!table || !table.rows.length) {
    return <div style={{ color: 'var(--text-muted)', fontSize: '13px', padding: '24px 0' }}>No data available</div>
  }

  const defs = STMT_ROW_DEFS[stmtKey] ?? []
  const defMap = Object.fromEntries(defs.map(d => [d.key, d]))
  const defsInData = defs.filter(d => table.rows.some(r => r.label === d.key))
  const definedKeys = new Set(defs.map(d => d.key))
  const extraRows = table.rows.filter(r => !definedKeys.has(r.label))

  const rowByLabel = Object.fromEntries(table.rows.map(r => [r.label, r]))

  // Build ordered display rows, skipping rows with no data
  const ordered = [
    ...defsInData,
    ...extraRows.map(r => ({ key: r.label, level: 0 })),
  ]

  // Determine which level-0 rows are parents (have level-1 children)
  const parentKeys = new Set()
  for (let i = 0; i < ordered.length - 1; i++) {
    if (ordered[i].level === 0 && ordered[i + 1]?.level > 0) parentKeys.add(ordered[i].key)
  }

  const cols = table.columns

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: '500px' }}>
        <thead>
          <tr>
            <th style={{
              textAlign: 'left', padding: '6px 0 10px',
              fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
              borderBottom: '2px solid var(--border)',
              minWidth: '260px', position: 'sticky', left: 0, background: 'var(--bg-panel)',
            }}>
              Breakdown
            </th>
            {cols.map(col => (
              <th key={col} style={{
                textAlign: 'right', padding: '6px 20px 10px',
                fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
                borderBottom: '2px solid var(--border)', whiteSpace: 'nowrap',
              }}>
                {col.length === 10 ? col.slice(0, 7) : col}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {ordered.map(({ key, level }) => {
            const row = rowByLabel[key]
            if (!row) return null
            const isParent = parentKeys.has(key)
            const isCollapsed = collapsed.has(key)
            const parentOfThis = ordered.slice(0, ordered.findIndex(o => o.key === key))
              .reverse().find(o => o.level < level)
            const hidden = parentOfThis && collapsed.has(parentOfThis.key)
            if (hidden) return null

            const isLevel0 = level === 0
            return (
              <tr
                key={key}
                style={{ borderBottom: '1px solid var(--border)', cursor: isParent ? 'pointer' : 'default' }}
                onClick={isParent ? () => onToggle(key) : undefined}
              >
                <td style={{
                  padding: '9px 0 9px ' + (level * 20) + 'px',
                  fontSize: '12px',
                  fontWeight: isLevel0 ? 600 : 400,
                  color: isLevel0 ? 'var(--text-primary)' : 'var(--text-secondary)',
                  position: 'sticky', left: 0, background: 'var(--bg-panel)',
                }}>
                  {isParent && (
                    <span style={{ fontSize: '9px', color: 'var(--text-muted)', marginRight: '6px' }}>
                      {isCollapsed ? '▶' : '▼'}
                    </span>
                  )}
                  {key}
                </td>
                {row.values.map((v, j) => {
                  const chg = (isLevel0 && j === 0 && cols[0]?.startsWith('TTM') && j < row.values.length - 1)
                    ? null
                    : (isLevel0 && j < row.values.length - 1 ? pctChange(v, row.values[j + 1]) : null)
                  const isNeg = v != null && v < 0
                  return (
                    <td key={j} style={{ textAlign: 'right', padding: '9px 20px', verticalAlign: 'top' }}>
                      <div style={{
                        fontSize: '12px', fontFamily: 'var(--font-mono)',
                        fontWeight: isLevel0 ? 600 : 400,
                        color: v == null ? 'var(--text-muted)' : isNeg ? 'var(--red)' : 'var(--text-primary)',
                      }}>
                        {fmtVal(key, v)}
                      </div>
                      {chg != null && (
                        <div style={{ fontSize: '10px', color: chg >= 0 ? 'var(--green)' : 'var(--red)', marginTop: '2px' }}>
                          {chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(1)}%
                        </div>
                      )}
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '12px' }}>
        All figures in USD Millions except per-share data
      </div>
    </div>
  )
}

function FinancialsPanel({ data, loading, symbol }) {
  const [subTab,   setSubTab]   = useState('income')
  const [period,   setPeriod]   = useState('annual')
  const [collapsed, setCollapsed] = useState(new Set())

  const onToggle = (key) => setCollapsed(prev => {
    const next = new Set(prev)
    next.has(key) ? next.delete(key) : next.add(key)
    return next
  })

  if (!symbol) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      Search for a symbol to see financials
    </div>
  )
  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      Loading financials…
    </div>
  )

  const SUBTABS = [
    { key: 'income',   label: 'Income Statement' },
    { key: 'balance',  label: 'Balance Sheet' },
    { key: 'cashflow', label: 'Cash Flow Statement' },
  ]
  const table = data?.[subTab]?.[period]

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 28px', borderBottom: '1px solid var(--border)',
        background: 'var(--bg-panel)', flexShrink: 0, height: '40px',
      }}>
        <div style={{ display: 'flex' }}>
          {SUBTABS.map(({ key, label }) => (
            <button key={key} onClick={() => { setSubTab(key); setCollapsed(new Set()) }}
              style={{
                height: '40px', padding: '0 16px',
                background: 'none', border: 'none',
                borderBottom: subTab === key ? '2px solid var(--blue)' : '2px solid transparent',
                color: subTab === key ? 'var(--text-primary)' : 'var(--text-muted)',
                fontSize: '12px', fontWeight: subTab === key ? 600 : 400, cursor: 'pointer',
              }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          {['annual', 'quarterly'].map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              style={{
                height: '26px', padding: '0 12px',
                border: '1px solid var(--border)', borderRadius: '4px',
                background: period === p ? 'var(--blue)' : 'transparent',
                color: period === p ? '#fff' : 'var(--text-muted)',
                fontSize: '11px', fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
              }}>
              {p}
            </button>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 28px' }}>
        <FinancialTable table={table} stmtKey={subTab} collapsed={collapsed} onToggle={onToggle} />
      </div>
    </div>
  )
}

// ── Dividends panel ───────────────────────────────────────────────────────────

function DividendsPanel({ data, loading, symbol }) {
  if (!symbol) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      Search for a symbol to see dividend information
    </div>
  )
  if (loading) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      Loading dividend data…
    </div>
  )
  if (!data) return (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      No data available
    </div>
  )

  const noDividends = !data.annual_rate && (!data.history || data.history.length === 0)

  const statCards = [
    { label: 'TTM Dividends',      value: data.annual_rate   != null ? `$${data.annual_rate.toFixed(4)}` : null },
    { label: 'TTM Yield',          value: data.dividend_yield != null ? `${data.dividend_yield.toFixed(2)}%` : null },
    { label: '5Y Avg Yield',       value: data.five_year_avg_yield != null ? `${data.five_year_avg_yield.toFixed(2)}%` : null },
    { label: 'Payout Ratio',       value: data.payout_ratio  != null ? `${(data.payout_ratio * 100).toFixed(1)}%` : null },
    { label: 'Ex-Dividend Date',   value: data.ex_dividend_date ?? null },
    { label: 'Last Dividend',      value: data.last_dividend  != null ? `$${data.last_dividend.toFixed(4)}` : null },
    { label: 'Frequency',          value: data.frequency ?? null },
  ].filter(s => s.value != null)

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>
      {noDividends ? (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: '60px 0', gap: '8px',
        }}>
          <span style={{ fontSize: '32px' }}>—</span>
          <span style={{ fontSize: '13px', color: 'var(--text-muted)' }}>
            {data.symbol} does not pay a dividend
          </span>
        </div>
      ) : (
        <>
          {/* Stats row */}
          {statCards.length > 0 && (
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
              gap: '12px 24px',
              marginBottom: '32px',
              padding: '16px 20px',
              background: 'var(--bg-raised)',
              borderRadius: '8px',
              border: '1px solid var(--border)',
            }}>
              {statCards.map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  <span style={{ fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    {label}
                  </span>
                  <span style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
                    {value}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Payment history */}
          {data.history?.length > 0 && (
            <>
              <div style={{
                fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                letterSpacing: '0.08em', color: 'var(--text-muted)', marginBottom: '10px',
              }}>
                Payment History
              </div>
              <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: '520px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border)' }}>
                    {['Ex-Date', 'Amount', 'Change'].map(h => (
                      <th key={h} style={{
                        textAlign: h === 'Ex-Date' ? 'left' : 'right',
                        padding: '6px 16px 10px ' + (h === 'Ex-Date' ? '0' : '16px'),
                        fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
                      }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border)' }}>
                      <td style={{ padding: '8px 0', fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {row.date}
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 16px', fontSize: '12px', fontFamily: 'var(--font-mono)', fontWeight: 600, color: 'var(--text-primary)' }}>
                        {row.amount != null ? `$${row.amount.toFixed(4)}` : '—'}
                      </td>
                      <td style={{ textAlign: 'right', padding: '8px 0 8px 16px', fontSize: '11px' }}>
                        {row.change != null ? (
                          <span style={{ color: row.change >= 0 ? 'var(--green)' : 'var(--red)' }}>
                            {row.change >= 0 ? '▲' : '▼'} {Math.abs(row.change).toFixed(2)}%
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </>
      )}
    </div>
  )
}

// ── Feature Data (chart-shape signature) ──────────────────────────────────────

const FEATURE_MAX_ROWS   = 500   // cap rendered table rows (newest first)
const FEATURE_CHART_ROWS = 250   // trailing bars per sparkline

const FEATURE_LABELS = {
  stack:      'Stack (fan order)',
  separation: 'Separation',
  sep_trend:  'Sep. trend',
  slope:      'Slope',
  curvature:  'Curvature',
  fast_slow:  'Fast–slow slope',
  macd:       'MACD',
  macd_hist:  'MACD hist',
  sqz:        'Squeeze',
  sqz_mom:    'Squeeze mom',
}

// Small auto-scaled line chart for a single feature series (oldest → newest).
function Sparkline({ values, width = 260, height = 64 }) {
  const pad = 6
  const n = values.length
  if (n === 0) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = (max - min) || 1
  const innerW = width - pad * 2
  const innerH = height - pad * 2
  const xAt = (i) => pad + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW)
  const yAt = (v) => pad + innerH - ((v - min) / span) * innerH
  const pts = values.map((v, i) => `${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ')
  const zeroY = (min < 0 && max > 0) ? yAt(0) : null
  const last = values[n - 1]
  const lastColor = last > 0 ? 'var(--green)' : last < 0 ? 'var(--red)' : 'var(--text-muted)'
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}
         preserveAspectRatio="none" style={{ display: 'block' }}>
      {zeroY != null && (
        <line x1={pad} x2={width - pad} y1={zeroY} y2={zeroY}
              stroke="var(--border)" strokeWidth="1" strokeDasharray="3 3" />
      )}
      <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth="1.5"
                vectorEffect="non-scaling-stroke" />
      <circle cx={xAt(n - 1)} cy={yAt(last)} r="2.5" fill={lastColor} />
    </svg>
  )
}

function FeatureDataPanel({ data, loading, symbol, norm, onSetNorm }) {
  const [view, setView] = useState('table')

  const center = (msg) => (
    <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
      {msg}
    </div>
  )
  if (!symbol) return center('Search for a symbol to see feature data')
  if (loading)  return center('Computing feature data…')
  if (!data)    return center('No data available')

  const fields = data.fields ?? []
  const allRows = data.data ?? []
  if (allRows.length === 0) return center(`Not enough bars to compute features for ${data.symbol}`)

  const tableRows = allRows.slice(-FEATURE_MAX_ROWS).reverse()   // newest first
  const truncated = allRows.length > FEATURE_MAX_ROWS
  const chartRows = allRows.slice(-FEATURE_CHART_ROWS)           // oldest → newest

  const NormBtn = ({ value, label }) => (
    <button
      onClick={() => onSetNorm(value)}
      style={{
        height: '24px', padding: '0 10px', fontSize: '11px', fontWeight: 600,
        border: '1px solid var(--border)', cursor: 'pointer',
        background: norm === value ? 'var(--blue)' : 'var(--bg-raised)',
        color: norm === value ? '#fff' : 'var(--text-secondary)',
        borderRadius: value === 'price' ? '5px 0 0 5px' : '0 5px 5px 0',
      }}
    >{label}</button>
  )

  const ViewBtn = ({ value, label }) => (
    <button
      onClick={() => setView(value)}
      style={{
        height: '24px', padding: '0 10px', fontSize: '11px', fontWeight: 600,
        border: '1px solid var(--border)', cursor: 'pointer',
        background: view === value ? 'var(--blue)' : 'var(--bg-raised)',
        color: view === value ? '#fff' : 'var(--text-secondary)',
        borderRadius: value === 'table' ? '5px 0 0 5px' : '0 5px 5px 0',
      }}
    >{label}</button>
  )

  const cell = (v) => {
    if (typeof v !== 'number') return String(v)
    const color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--red)' : 'var(--text-muted)'
    return <span style={{ color }}>{v >= 0 ? '+' : ''}{v.toFixed(4)}</span>
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header row: view toggle + normalize toggle + meta */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: '14px',
        padding: '12px 28px', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ display: 'flex' }}>
          <ViewBtn value="table" label="Table" />
          <ViewBtn value="chart" label="Chart" />
        </div>
        <div style={{ display: 'flex' }}>
          <NormBtn value="price" label="Price-norm" />
          <NormBtn value="atr"   label="ATR-norm" />
        </div>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          {data.symbol} · {allRows.length.toLocaleString()} bars
          {view === 'table'
            ? (truncated ? ` · showing latest ${FEATURE_MAX_ROWS}` : '')
            : ` · last ${Math.min(FEATURE_CHART_ROWS, allRows.length)} bars`}
          {' · dimensionless — comparable across stocks'}
        </span>
      </div>

      {view === 'table' ? (
        <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 24px' }}>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr>
                {['time', ...fields].map((h, idx) => (
                  <th key={h} style={{
                    position: 'sticky', top: 0, zIndex: 1,
                    background: 'var(--bg-panel)',
                    textAlign: idx === 0 ? 'left' : 'right',
                    padding: '8px 12px',
                    borderBottom: '2px solid var(--border)',
                    fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)',
                    whiteSpace: 'nowrap',
                  }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row, i) => (
                <tr key={row.time ?? i} style={{ borderBottom: '1px solid var(--border)' }}>
                  <td style={{ padding: '6px 12px', fontSize: '12px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                    {row.time}
                  </td>
                  {fields.map(f => (
                    <td key={f} style={{ textAlign: 'right', padding: '6px 12px', fontSize: '12px', fontWeight: 600 }}>
                      {cell(row[f])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ flex: 1, overflow: 'auto', padding: '0 28px 24px' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: '16px',
          }}>
            {fields.map(f => {
              const vals = chartRows.map(r => r[f])
              const lastV = vals[vals.length - 1]
              const minV = Math.min(...vals), maxV = Math.max(...vals)
              const lastColor = lastV > 0 ? 'var(--green)' : lastV < 0 ? 'var(--red)' : 'var(--text-muted)'
              return (
                <div key={f} style={{
                  border: '1px solid var(--border)', borderRadius: '8px',
                  padding: '10px 12px', background: 'var(--bg-raised)',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '6px' }}>
                    <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)' }}>
                      {FEATURE_LABELS[f] ?? f}
                    </span>
                    <span style={{ fontSize: '12px', fontWeight: 700, fontFamily: 'var(--font-mono)', color: lastColor }}>
                      {lastV >= 0 ? '+' : ''}{lastV.toFixed(4)}
                    </span>
                  </div>
                  <Sparkline values={vals} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '4px', fontSize: '9px', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                    <span>{minV.toFixed(3)}</span>
                    <span>{maxV.toFixed(3)}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
