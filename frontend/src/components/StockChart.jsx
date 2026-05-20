import { useCallback, useEffect, useRef, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'

// ── Guppy period groups ───────────────────────────────────────────────────────

const GUPPY_SHORT = [3, 5, 8, 10, 12, 15]
const GUPPY_LONG  = [30, 35, 40, 45, 50, 60]

// ── Layout constants ──────────────────────────────────────────────────────────

const SPLIT_DEFAULT = 0.65
const SPLIT_MIN     = 0.20
const SPLIT_MAX     = 0.85

// Static margins used when no sub-pane is visible
const MARGINS_SOLO = {
  main: { top: 0.05, bottom: 0.22 },
  vol:  { top: 0.80, bottom: 0.00 },
}

// Main + volume margins for the draggable split layout
function mainVolMargins(split) {
  return {
    main: { top: 0.03, bottom: (1 - split) + 0.03 },
    vol:  { top: split - 0.10, bottom: (1 - split) + 0.01 },
  }
}

// Divide the bottom (1-split) slice evenly among `total` sub-panes.
// `index` is 0-based: panes appear top-to-bottom in the order they are registered.
function subPaneMargins(split, index, total) {
  const H       = (1 - split) / total
  const paneTop = split + index * H
  return {
    top:    paneTop + 0.03,
    bottom: Math.max(0.02, 1 - paneTop - H + 0.02),
  }
}

// ── Chart options ─────────────────────────────────────────────────────────────

const THEME_COLORS = {
  light: { bg: '#ffffff', text: '#434651', grid: '#f0f3fa', border: '#e0e3eb' },
  dark:  { bg: '#131722', text: '#9598a1', grid: '#1e222d', border: '#2a2e39' },
}

function themeChartOpts(theme) {
  const c = THEME_COLORS[theme] ?? THEME_COLORS.light
  return {
    layout: { background: { color: c.bg }, textColor: c.text },
    grid:   { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    timeScale:       { borderColor: c.border },
    rightPriceScale: { borderColor: c.border },
  }
}

const CHART_OPTS = {
  ...themeChartOpts('light'),   // overwritten immediately by the theme effect
  crosshair: { mode: CrosshairMode.Normal },
  timeScale: {
    ...themeChartOpts('light').timeScale,
    timeVisible:    true,
    secondsVisible: false,
  },
  rightPriceScale: {
    ...themeChartOpts('light').rightPriceScale,
    scaleMargins: MARGINS_SOLO.main,
  },
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPrice(n)  { return n == null ? '—' : n.toFixed(2) }
function fmtMacd(n)   { return n == null ? '—' : n.toFixed(4) }
function fmtRwb(n)    { return n == null ? '—' : n.toFixed(4) }

function fmtVolume(n) {
  if (n == null) return '—'
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// ── Visible-range helper ──────────────────────────────────────────────────────

const RIGHT_BAR_PADDING = 10   // empty bar slots reserved to the right of the last bar

function applyVisibleRange(chart, candles, visibleDays) {
  if (!candles?.length) return

  const lastIdx = candles.length - 1
  const to = lastIdx + RIGHT_BAR_PADDING   // always 10 empty slots on the right

  if (!isFinite(visibleDays)) {
    chart.timeScale().setVisibleLogicalRange({ from: 0, to })
    return
  }

  // Find the leftmost bar index that falls within visibleDays of the last bar.
  // Comparing time values directly works for both Unix-second numbers and
  // "YYYY-MM-DD" strings (ISO date strings sort lexicographically).
  const last   = candles[lastIdx]
  const cutoff = typeof last.time === 'number'
    ? last.time - visibleDays * 86400
    : new Date(Date.now() - visibleDays * 86400000).toISOString().slice(0, 10)

  let fromIdx = 0
  for (let i = lastIdx; i >= 0; i--) {
    if (candles[i].time < cutoff) { fromIdx = i + 1; break }
  }

  try {
    chart.timeScale().setVisibleLogicalRange({ from: fromIdx, to })
  } catch {
    chart.timeScale().setVisibleLogicalRange({ from: 0, to })
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StockChart({
  candles, volume,
  visibleDays    = Infinity,
  theme          = 'light',
  maConfigs      = [],
  macdConfigs    = [],
  guppyConfigs   = [],
  rwbConfigs     = [],
  squeezeConfigs = [],
  maData         = {},    // { "20": [{time,value}, ...] }
  guppyData      = null,  // { short: {"3": [...], ...}, long: {"30": [...], ...} }
  macdData       = {},    // { "12,26,9": { macd_line, signal_line, histogram } }
  rwbData        = null,  // { fast_width: [...], slow_width: [...], rwb: [...] }
  squeezeData    = null,  // { mom: [...], sqz: [...] }
}) {
  const containerRef   = useRef(null)
  const chartRef       = useRef(null)
  const candleRef      = useRef(null)
  const volumeRef      = useRef(null)
  const candlesRef     = useRef([])
  const lastBarRef     = useRef(null)
  const visibleDaysRef = useRef(visibleDays)

  const maSeriesMap   = useRef(new Map())
  const maLastValsRef = useRef({})

  const macdSeriesMap = useRef(new Map())
  const macdLastRef   = useRef({})
  const macdByTimeRef = useRef({})
  const macdScaleRef  = useRef(null)   // anchor series for scale-margin updates

  // guppySeriesMap: id → Map<period, series>
  const guppySeriesMap = useRef(new Map())

  // rwbSeriesMap: id → { fastLine, slowLine, rwbHist }
  const rwbSeriesMap  = useRef(new Map())
  const rwbScaleRef   = useRef(null)

  // sqzSeriesMap: id → { momHist, sqzLine }
  const sqzSeriesMap  = useRef(new Map())
  const sqzScaleRef   = useRef(null)

  const [hover,      setHover]      = useState(null)
  const [maLegend,   setMaLegend]   = useState({})
  const [macdLegend, setMacdLegend] = useState({})
  const [rwbLegend,  setRwbLegend]  = useState(null)   // { fast, slow, rwb }
  const [sqzLegend,  setSqzLegend]  = useState(null)   // { mom, momColor, sqzColor }

  // ── Draggable split ───────────────────────────────────────────────────────
  const [split,       setSplit]       = useState(SPLIT_DEFAULT)
  const [isDragging,  setIsDragging]  = useState(false)
  const splitRef      = useRef(SPLIT_DEFAULT)
  const isDraggingRef = useRef(false)

  useEffect(() => { splitRef.current = split }, [split])

  useEffect(() => {
    const onMove = (e) => {
      if (!isDraggingRef.current || !containerRef.current) return
      const rect     = containerRef.current.getBoundingClientRect()
      const newSplit = Math.max(SPLIT_MIN, Math.min(SPLIT_MAX,
        (e.clientY - rect.top) / rect.height))
      setSplit(newSplit)
    }
    const onUp = () => {
      if (!isDraggingRef.current) return
      isDraggingRef.current = false
      setIsDragging(false)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [])

  const hasMacd = macdConfigs.length    > 0
  const hasRwb  = rwbConfigs.length     > 0
  const hasSqz  = squeezeConfigs.length > 0

  // Keep a ref so chart creation ([] effect) can read the initial theme
  const themeRef = useRef(theme)
  useEffect(() => { themeRef.current = theme }, [theme])

  // Live-update chart colors when theme changes
  useEffect(() => {
    if (!chartRef.current) return
    chartRef.current.applyOptions(themeChartOpts(theme))
  }, [theme])

  useEffect(() => { visibleDaysRef.current = visibleDays }, [visibleDays])

  // ── syncSubPaneMargins ────────────────────────────────────────────────────
  // Re-applies scale margins to all active sub-panes whenever the split moves
  // or a pane is added/removed.  Reads exclusively from refs so it never needs
  // to be recreated (empty dep array is intentional).

  const syncSubPaneMargins = useCallback(() => {
    // Order: MACD → RWB → Squeeze  (matches activeSubPanes order in render)
    const live = [macdScaleRef, rwbScaleRef, sqzScaleRef].filter(r => r.current != null)
    const total = live.length
    if (total === 0) return
    live.forEach((ref, idx) => {
      ref.current.priceScale().applyOptions({
        scaleMargins: subPaneMargins(splitRef.current, idx, total),
      })
    })
  }, [])

  // ── Create chart (once) ───────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      ...CHART_OPTS,
      ...themeChartOpts(themeRef.current),
      timeScale: {
        ...themeChartOpts(themeRef.current).timeScale,
        timeVisible: true, secondsVisible: false,
      },
      rightPriceScale: {
        ...themeChartOpts(themeRef.current).rightPriceScale,
        scaleMargins: MARGINS_SOLO.main,
      },
      width:  containerRef.current.clientWidth,
      height: containerRef.current.clientHeight,
    })
    chartRef.current = chart

    candleRef.current = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderVisible: false,
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    })

    volumeRef.current = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    })
    chart.priceScale('vol').applyOptions({ scaleMargins: MARGINS_SOLO.vol })

    chart.subscribeCrosshairMove(param => {
      if (param.logical == null || !param.seriesData?.size) {
        setHover(lastBarRef.current)
        setMaLegend({ ...maLastValsRef.current })
        setMacdLegend({ ...macdLastRef.current })
        return
      }
      const candle = param.seriesData.get(candleRef.current)
      const vol    = param.seriesData.get(volumeRef.current)
      if (candle) {
        const idx       = param.logical
        const prevClose = idx > 0 ? candlesRef.current[idx - 1]?.close ?? null : null
        const change    = prevClose != null ? candle.close - prevClose : null
        const changePct = prevClose != null ? (change / prevClose) * 100 : null
        setHover({
          open: candle.open, high: candle.high, low: candle.low, close: candle.close,
          volume: vol?.value ?? null, change, changePct,
        })
        const macdVals = {}
        for (const [id, byTime] of Object.entries(macdByTimeRef.current))
          macdVals[id] = byTime.get(candle.time) ?? macdLastRef.current[id] ?? null
        setMacdLegend(macdVals)
      }
      const maVals = {}
      for (const [id, series] of maSeriesMap.current) {
        const pt = param.seriesData.get(series)
        maVals[id] = pt?.value ?? maLastValsRef.current[id] ?? null
      }
      setMaLegend(maVals)
    })

    const ro = new ResizeObserver(() => {
      if (containerRef.current)
        chart.resize(containerRef.current.clientWidth, containerRef.current.clientHeight)
    })
    ro.observe(containerRef.current)

    return () => {
      ro.disconnect()
      chart.remove()
      chartRef.current  = null
      candleRef.current = null
      volumeRef.current = null
      macdScaleRef.current = null
      rwbScaleRef.current  = null
      sqzScaleRef.current  = null
      maSeriesMap.current.clear()
      macdSeriesMap.current.clear()
      guppySeriesMap.current.clear()
      rwbSeriesMap.current.clear()
      sqzSeriesMap.current.clear()
      maLastValsRef.current  = {}
      macdLastRef.current    = {}
      macdByTimeRef.current  = {}
    }
  }, [])

  // ── Update scale margins whenever split or sub-pane visibility changes ────

  useEffect(() => {
    if (!chartRef.current) return
    const hasAny = hasMacd || hasRwb || hasSqz
    if (hasAny) {
      const m = mainVolMargins(split)
      chartRef.current.priceScale('right').applyOptions({ scaleMargins: m.main })
      chartRef.current.priceScale('vol').applyOptions({   scaleMargins: m.vol  })
      syncSubPaneMargins()
    } else {
      chartRef.current.priceScale('right').applyOptions({ scaleMargins: MARGINS_SOLO.main })
      chartRef.current.priceScale('vol').applyOptions({   scaleMargins: MARGINS_SOLO.vol  })
    }
  }, [split, hasMacd, hasRwb, hasSqz, syncSubPaneMargins])

  // ── Load candle + volume data ─────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current || !candleRef.current || !candles?.length) return
    candlesRef.current = candles
    candleRef.current.setData(candles)
    if (volumeRef.current && volume?.length) volumeRef.current.setData(volume)
    applyVisibleRange(chartRef.current, candles, visibleDaysRef.current)
    const last      = candles[candles.length - 1]
    const prev      = candles[candles.length - 2] ?? null
    const lastVol   = volume?.[volume.length - 1]?.value ?? null
    const change    = prev != null ? last.close - prev.close : null
    const changePct = prev != null ? (change / prev.close) * 100 : null
    const lastBar   = { ...last, volume: lastVol, change, changePct }
    lastBarRef.current = lastBar
    setHover(lastBar)
  }, [candles, volume])

  // ── Range zoom ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current || !candlesRef.current.length) return
    applyVisibleRange(chartRef.current, candlesRef.current, visibleDays)
  }, [visibleDays])

  // ── MA series ─────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = maSeriesMap.current
    const incoming = new Set(maConfigs.map(m => m.id))

    for (const [id, series] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(series)
        map.delete(id)
        delete maLastValsRef.current[id]
      }
    }

    for (const ma of maConfigs) {
      if (!map.has(ma.id)) {
        map.set(ma.id, chart.addLineSeries({
          color: ma.color, lineWidth: ma.width,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }))
      } else {
        map.get(ma.id).applyOptions({ color: ma.color, lineWidth: ma.width })
      }
      const data = maData[String(ma.period)] ?? []
      map.get(ma.id).setData(data)
      if (data.length) maLastValsRef.current[ma.id] = data[data.length - 1].value
    }

    for (const id of Object.keys(maLastValsRef.current))
      if (!incoming.has(id)) delete maLastValsRef.current[id]
    setMaLegend({ ...maLastValsRef.current })
  }, [maConfigs, maData])

  // ── MACD series ───────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = macdSeriesMap.current
    const incoming = new Set(macdConfigs.map(m => m.id))

    for (const [id, s] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(s.macd)
        chart.removeSeries(s.signal)
        chart.removeSeries(s.histogram)
        map.delete(id)
        delete macdLastRef.current[id]
        delete macdByTimeRef.current[id]
      }
    }
    if (macdConfigs.length === 0) macdScaleRef.current = null

    for (const cfg of macdConfigs) {
      if (!map.has(cfg.id)) {
        const histSeries = chart.addHistogramSeries({
          priceScaleId: 'macd',
          priceLineVisible: false, lastValueVisible: false,
        })
        const macdSeries = chart.addLineSeries({
          color: cfg.macdColor, lineWidth: 1,
          priceScaleId: 'macd',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        const signalSeries = chart.addLineSeries({
          color: cfg.signalColor, lineWidth: 1,
          priceScaleId: 'macd',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        map.set(cfg.id, { macd: macdSeries, signal: signalSeries, histogram: histSeries })
        if (!macdScaleRef.current) macdScaleRef.current = histSeries
        syncSubPaneMargins()
      } else {
        const s = map.get(cfg.id)
        s.macd.applyOptions({ color: cfg.macdColor })
        s.signal.applyOptions({ color: cfg.signalColor })
      }

      const key = `${cfg.fast},${cfg.slow},${cfg.signal}`
      const d   = macdData[key]
      if (!d) continue

      const macdLine   = d.macd_line   ?? []
      const signalLine = d.signal_line ?? []
      const rawHist    = d.histogram   ?? []

      const histogram = rawHist.map(p => ({
        ...p, color: p.value >= 0 ? '#26a69a' : '#ef5350',
      }))

      const s = map.get(cfg.id)
      s.histogram.setData(histogram)
      s.macd.setData(macdLine)
      s.signal.setData(signalLine)

      const byTime = new Map()
      for (let i = 0; i < signalLine.length; i++) {
        const mi = macdLine.length - signalLine.length + i
        byTime.set(signalLine[i].time, {
          macd:   macdLine[mi]?.value   ?? null,
          signal: signalLine[i].value,
          hist:   rawHist[rawHist.length - signalLine.length + i]?.value ?? null,
        })
      }
      macdByTimeRef.current[cfg.id] = byTime

      if (signalLine.length) {
        macdLastRef.current[cfg.id] = {
          macd:   macdLine[macdLine.length - 1]?.value   ?? null,
          signal: signalLine[signalLine.length - 1].value,
          hist:   rawHist[rawHist.length - 1]?.value     ?? null,
        }
      }
    }

    setMacdLegend({ ...macdLastRef.current })
  }, [macdConfigs, macdData, syncSubPaneMargins])

  // ── Guppy MMA series ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = guppySeriesMap.current
    const incoming = new Set(guppyConfigs.map(g => g.id))

    for (const [id, seriesByPeriod] of map) {
      if (!incoming.has(id)) {
        for (const s of seriesByPeriod.values()) chart.removeSeries(s)
        map.delete(id)
      }
    }

    for (const cfg of guppyConfigs) {
      if (!map.has(cfg.id)) {
        const seriesByPeriod = new Map()
        for (const p of GUPPY_SHORT) {
          seriesByPeriod.set(p, chart.addLineSeries({
            color: cfg.shortColor, lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          }))
        }
        for (const p of GUPPY_LONG) {
          seriesByPeriod.set(p, chart.addLineSeries({
            color: cfg.longColor, lineWidth: 1,
            priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
          }))
        }
        map.set(cfg.id, seriesByPeriod)
      } else {
        const seriesByPeriod = map.get(cfg.id)
        for (const p of GUPPY_SHORT) seriesByPeriod.get(p)?.applyOptions({ color: cfg.shortColor })
        for (const p of GUPPY_LONG)  seriesByPeriod.get(p)?.applyOptions({ color: cfg.longColor })
      }

      const seriesByPeriod = map.get(cfg.id)
      const shortData = guppyData?.short ?? {}
      const longData  = guppyData?.long  ?? {}
      for (const p of GUPPY_SHORT) seriesByPeriod.get(p)?.setData(shortData[String(p)] ?? [])
      for (const p of GUPPY_LONG)  seriesByPeriod.get(p)?.setData(longData[String(p)]  ?? [])
    }
  }, [guppyConfigs, guppyData])

  // ── RWB series ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = rwbSeriesMap.current
    const incoming = new Set(rwbConfigs.map(r => r.id))

    for (const [id, s] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(s.fastLine)
        chart.removeSeries(s.slowLine)
        chart.removeSeries(s.rwbHist)
        map.delete(id)
      }
    }
    if (rwbConfigs.length === 0) {
      rwbScaleRef.current = null
      syncSubPaneMargins()
      setRwbLegend(null)
      return
    }

    for (const cfg of rwbConfigs) {
      if (!map.has(cfg.id)) {
        // rwb (gray) histogram — anchors the scale
        const rwbHist = chart.addHistogramSeries({
          priceScaleId: 'rwb', color: '#787b86',
          priceLineVisible: false, lastValueVisible: false,
        })
        // slow_width line — per-point green/red from backend
        const slowLine = chart.addLineSeries({
          lineWidth: 1, priceScaleId: 'rwb',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        // fast_width line — red
        const fastLine = chart.addLineSeries({
          color: '#ef5350', lineWidth: 1, priceScaleId: 'rwb',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        map.set(cfg.id, { fastLine, slowLine, rwbHist })
        if (!rwbScaleRef.current) rwbScaleRef.current = rwbHist
        syncSubPaneMargins()
      }

      if (!rwbData) continue

      const fastData = rwbData.fast_width ?? []
      const slowData = rwbData.slow_width ?? []   // per-point color from backend
      const rwbArr   = rwbData.rwb        ?? []

      const s = map.get(cfg.id)
      s.fastLine.setData(fastData)
      s.slowLine.setData(slowData)
      s.rwbHist.setData(rwbArr)

      if (fastData.length) {
        setRwbLegend({
          fast: fastData[fastData.length - 1].value,
          slow: slowData.length ? slowData[slowData.length - 1].value : null,
          rwb:  rwbArr.length   ? rwbArr[rwbArr.length - 1].value     : null,
        })
      }
    }
  }, [rwbConfigs, rwbData, syncSubPaneMargins])

  // ── Squeeze series ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = sqzSeriesMap.current
    const incoming = new Set(squeezeConfigs.map(s => s.id))

    for (const [id, s] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(s.momHist)
        chart.removeSeries(s.sqzLine)
        map.delete(id)
      }
    }
    if (squeezeConfigs.length === 0) {
      sqzScaleRef.current = null
      syncSubPaneMargins()
      setSqzLegend(null)
      return
    }

    for (const cfg of squeezeConfigs) {
      if (!map.has(cfg.id)) {
        // Momentum histogram — per-bar color from backend; anchors the scale
        const momHist = chart.addHistogramSeries({
          priceScaleId: 'sqz',
          priceLineVisible: false, lastValueVisible: false,
        })
        // Squeeze-state line at y=0 — per-point color from backend, drawn thick
        const sqzLine = chart.addLineSeries({
          lineWidth: 4, priceScaleId: 'sqz',
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        map.set(cfg.id, { momHist, sqzLine })
        if (!sqzScaleRef.current) sqzScaleRef.current = momHist
        syncSubPaneMargins()
      }

      if (!squeezeData) continue

      const momData = squeezeData.mom ?? []
      const sqzData = squeezeData.sqz ?? []

      const s = map.get(cfg.id)
      s.momHist.setData(momData)
      s.sqzLine.setData(sqzData)

      if (momData.length) {
        const last = momData[momData.length - 1]
        setSqzLegend({
          mom:      last.value,
          momColor: last.color,
          sqzColor: sqzData.length ? sqzData[sqzData.length - 1].color : '#26a69a',
        })
      }
    }
  }, [squeezeConfigs, squeezeData, syncSubPaneMargins])

  // ── Render ────────────────────────────────────────────────────────────────

  const isUp = hover ? hover.close >= hover.open : true
  const clr  = isUp ? '#26a69a' : '#ef5350'

  // Active sub-panes in display order; drives separators and legend positions.
  const activeSubPanes = [
    hasMacd && 'macd',
    hasRwb  && 'rwb',
    hasSqz  && 'sqz',
  ].filter(Boolean)
  const totalSubPanes = activeSubPanes.length
  const H = totalSubPanes > 0 ? (1 - split) / totalSubPanes : 0

  // Fractional top of sub-pane at index k
  const paneTop = (k) => split + k * H

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%',
                  userSelect: isDragging ? 'none' : 'auto' }}>

      {/* OHLCV overlay */}
      <div style={{
        position: 'absolute', top: 8, left: 12, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: '16px',
        fontSize: '12px', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
      }}>
        {[['O', hover?.open], ['H', hover?.high], ['L', hover?.low], ['C', hover?.close]].map(([lbl, val]) => (
          <span key={lbl}>
            <span style={{ color: 'var(--text-muted)' }}>{lbl} </span>
            <span style={{ color: hover ? clr : 'var(--text-secondary)' }}>{fmtPrice(val)}</span>
          </span>
        ))}
        <span>
          <span style={{ color: 'var(--text-muted)' }}>V </span>
          <span style={{ color: hover ? clr : 'var(--text-secondary)' }}>{fmtVolume(hover?.volume ?? null)}</span>
        </span>
        {hover?.change != null && (
          <span style={{ color: hover.change >= 0 ? '#26a69a' : '#ef5350' }}>
            {hover.change >= 0 ? '+' : ''}{fmtPrice(hover.change)}
            {' '}({hover.changePct >= 0 ? '+' : ''}{hover.changePct.toFixed(2)}%)
          </span>
        )}
      </div>

      {/* MA legend */}
      {maConfigs.length > 0 && (
        <div style={{
          position: 'absolute', top: 30, left: 12, zIndex: 10,
          display: 'flex', flexWrap: 'wrap', gap: '12px',
          fontSize: '12px', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
        }}>
          {maConfigs.map(ma => (
            <span key={ma.id} style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{
                display: 'inline-block', width: '16px', height: '2px',
                background: ma.color, borderRadius: '1px', flexShrink: 0, marginBottom: '1px',
              }} />
              <span style={{ color: 'var(--text-muted)' }}>MA</span>
              <span style={{ color: ma.color }}>{ma.period}</span>
              {maLegend[ma.id] != null && (
                <span style={{ color: ma.color }}>{fmtPrice(maLegend[ma.id])}</span>
              )}
            </span>
          ))}
        </div>
      )}

      {/* Guppy legend */}
      {guppyConfigs.length > 0 && (
        <div style={{
          position: 'absolute', top: 30, left: 12, zIndex: 10,
          display: 'flex', flexWrap: 'wrap', gap: '12px',
          fontSize: '12px', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
          marginTop: maConfigs.length > 0 ? '18px' : '0',
        }}>
          {guppyConfigs.map(cfg => (
            <span key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: '5px' }}>
              <span style={{
                display: 'inline-block', width: '8px', height: '8px', borderRadius: '2px',
                background: `linear-gradient(to bottom, ${cfg.shortColor} 50%, ${cfg.longColor} 50%)`,
                flexShrink: 0,
              }} />
              <span style={{ color: 'var(--text-muted)' }}>GMMA</span>
              <span style={{ color: cfg.shortColor }}>S</span>
              <span style={{ color: 'var(--text-muted)' }}>/</span>
              <span style={{ color: cfg.longColor }}>L</span>
            </span>
          ))}
        </div>
      )}

      {/* Draggable separator — shown when any sub-pane is visible */}
      {totalSubPanes > 0 && (
        <div
          onMouseDown={e => {
            e.preventDefault()
            isDraggingRef.current = true
            setIsDragging(true)
          }}
          style={{
            position: 'absolute', zIndex: 20,
            top: `${split * 100}%`, left: 0, right: 0,
            height: '5px', transform: 'translateY(-2px)',
            cursor: 'row-resize',
            background: isDragging ? 'var(--blue, #2962ff)' : 'var(--border)',
            transition: isDragging ? 'none' : 'background 0.15s',
          }}
        />
      )}

      {/* Static dividers between sub-panes */}
      {activeSubPanes.slice(1).map((_, k) => (
        <div key={k} style={{
          position: 'absolute', zIndex: 15, pointerEvents: 'none',
          top: `${paneTop(k + 1) * 100}%`, left: 0, right: 0,
          height: '1px', background: 'var(--border)',
        }} />
      ))}

      {/* MACD legend */}
      {hasMacd && (
        <div style={{
          position: 'absolute', zIndex: 10, pointerEvents: 'none',
          top: `calc(${paneTop(activeSubPanes.indexOf('macd')) * 100}% + 8px)`, left: 12,
          display: 'flex', flexWrap: 'wrap', gap: '14px',
          fontSize: '11px', fontFamily: 'var(--font-mono)',
        }}>
          {macdConfigs.map(cfg => {
            const v = macdLegend[cfg.id]
            return (
              <span key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ color: 'var(--text-muted)' }}>
                  MACD ({cfg.fast},{cfg.slow},{cfg.signal})
                </span>
                <span style={{ color: cfg.macdColor }}>{fmtMacd(v?.macd ?? null)}</span>
                <span style={{ color: cfg.signalColor }}>{fmtMacd(v?.signal ?? null)}</span>
                {v?.hist != null && (
                  <span style={{ color: v.hist >= 0 ? '#26a69a' : '#ef5350' }}>{fmtMacd(v.hist)}</span>
                )}
              </span>
            )
          })}
        </div>
      )}

      {/* RWB legend */}
      {hasRwb && (
        <div style={{
          position: 'absolute', zIndex: 10, pointerEvents: 'none',
          top: `calc(${paneTop(activeSubPanes.indexOf('rwb')) * 100}% + 8px)`, left: 12,
          display: 'flex', gap: '14px',
          fontSize: '11px', fontFamily: 'var(--font-mono)',
        }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ color: 'var(--text-muted)' }}>RWB</span>
            {rwbLegend?.fast != null && (
              <span style={{ color: '#ef5350' }}>{fmtRwb(rwbLegend.fast)}</span>
            )}
            {rwbLegend?.slow != null && (
              <span style={{ color: '#26a69a' }}>{fmtRwb(rwbLegend.slow)}</span>
            )}
            {rwbLegend?.rwb != null && (
              <span style={{ color: '#787b86' }}>{fmtRwb(rwbLegend.rwb)}</span>
            )}
          </span>
        </div>
      )}

      {/* Squeeze legend */}
      {hasSqz && (
        <div style={{
          position: 'absolute', zIndex: 10, pointerEvents: 'none',
          top: `calc(${paneTop(activeSubPanes.indexOf('sqz')) * 100}% + 8px)`, left: 12,
          display: 'flex', gap: '10px', alignItems: 'center',
          fontSize: '11px', fontFamily: 'var(--font-mono)',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>SQZ</span>
          {/* Squeeze state dot */}
          {sqzLegend?.sqzColor && (
            <span style={{
              display: 'inline-block', width: '8px', height: '8px',
              borderRadius: '50%', background: sqzLegend.sqzColor, flexShrink: 0,
            }} />
          )}
          {/* Momentum value in its bar color */}
          {sqzLegend?.mom != null && (
            <span style={{ color: sqzLegend.momColor ?? 'var(--text-secondary)' }}>
              {fmtMacd(sqzLegend.mom)}
            </span>
          )}
        </div>
      )}

      {/* Chart canvas */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}
