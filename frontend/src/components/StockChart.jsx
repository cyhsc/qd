import { useEffect, useRef, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'

// ── Guppy period groups ───────────────────────────────────────────────────────

const GUPPY_SHORT = [3, 5, 8, 13, 21, 34]
const GUPPY_LONG  = [55, 89, 144, 233, 377, 610]

// ── Layout constants ──────────────────────────────────────────────────────────

const SPLIT_DEFAULT = 0.65
const SPLIT_MIN     = 0.20
const SPLIT_MAX     = 0.85

// Static margins used when no MACD pane is visible
const MARGINS_SOLO = {
  main: { top: 0.05, bottom: 0.22 },
  vol:  { top: 0.80, bottom: 0.00 },
}

// Dynamic margins computed from the current split position
function splitMargins(split) {
  return {
    main: { top: 0.03, bottom: (1 - split) + 0.03 },
    vol:  { top: split - 0.10, bottom: (1 - split) + 0.01 },
    macd: { top: split + 0.03, bottom: 0.02 },
  }
}

// ── Chart options ─────────────────────────────────────────────────────────────

const CHART_OPTS = {
  layout: {
    background: { color: '#131722' },
    textColor:  '#9598a1',
  },
  grid: {
    vertLines: { color: '#1e222d' },
    horzLines: { color: '#1e222d' },
  },
  crosshair: { mode: CrosshairMode.Normal },
  timeScale: {
    borderColor:    '#2a2e39',
    timeVisible:    true,
    secondsVisible: false,
  },
  rightPriceScale: {
    borderColor:  '#2a2e39',
    scaleMargins: MARGINS_SOLO.main,
  },
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPrice(n)  { return n == null ? '—' : n.toFixed(2) }
function fmtMacd(n)   { return n == null ? '—' : n.toFixed(4) }

function fmtVolume(n) {
  if (n == null) return '—'
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3)  return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// ── Visible-range helper ──────────────────────────────────────────────────────

function applyVisibleRange(chart, candles, visibleDays) {
  if (!candles?.length) return
  if (!isFinite(visibleDays)) { chart.timeScale().fitContent(); return }
  const last = candles[candles.length - 1]
  try {
    if (typeof last.time === 'number') {
      chart.timeScale().setVisibleRange({
        from: last.time - visibleDays * 86400,
        to:   last.time + 3600,
      })
    } else {
      const to = new Date(), from = new Date(to)
      from.setDate(from.getDate() - Math.ceil(visibleDays))
      chart.timeScale().setVisibleRange({
        from: from.toISOString().slice(0, 10),
        to:   to.toISOString().slice(0, 10),
      })
    }
  } catch { chart.timeScale().fitContent() }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StockChart({
  candles, volume,
  visibleDays  = Infinity,
  maConfigs    = [],
  macdConfigs  = [],
  guppyConfigs = [],
  maData       = {},   // { "20": [{time,value}, ...] }
  emaData      = {},   // { "3": [{time,value}, ...], "55": [...], ... }
  macdData     = {},   // { "12,26,9": { macd_line, signal_line, histogram } }
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
  const macdScaleRef  = useRef(null)

  // guppySeriesMap: id → Map<period, series>
  const guppySeriesMap = useRef(new Map())

  const [hover,      setHover]      = useState(null)
  const [maLegend,   setMaLegend]   = useState({})
  const [macdLegend, setMacdLegend] = useState({})

  // ── Draggable split ───────────────────────────────────────────────────────
  const [split,       setSplit]       = useState(SPLIT_DEFAULT)
  const [isDragging,  setIsDragging]  = useState(false)
  const splitRef      = useRef(SPLIT_DEFAULT)   // always in sync with split state
  const isDraggingRef = useRef(false)

  // Keep ref in sync (used by effects whose deps don't include split)
  useEffect(() => { splitRef.current = split }, [split])

  // Attach global drag handlers once; use refs to stay out of the dep array
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

  const hasMacd = macdConfigs.length > 0

  useEffect(() => { visibleDaysRef.current = visibleDays }, [visibleDays])

  // ── Create chart (once) ───────────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return

    const chart = createChart(containerRef.current, {
      ...CHART_OPTS,
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
      maSeriesMap.current.clear()
      macdSeriesMap.current.clear()
      guppySeriesMap.current.clear()
      maLastValsRef.current  = {}
      macdLastRef.current    = {}
      macdByTimeRef.current  = {}
    }
  }, [])

  // ── Update scale margins whenever split or MACD visibility changes ────────

  useEffect(() => {
    if (!chartRef.current) return
    if (hasMacd) {
      const m = splitMargins(split)
      chartRef.current.priceScale('right').applyOptions({ scaleMargins: m.main })
      chartRef.current.priceScale('vol').applyOptions({   scaleMargins: m.vol  })
      macdScaleRef.current?.priceScale().applyOptions({   scaleMargins: m.macd })
    } else {
      chartRef.current.priceScale('right').applyOptions({ scaleMargins: MARGINS_SOLO.main })
      chartRef.current.priceScale('vol').applyOptions({   scaleMargins: MARGINS_SOLO.vol  })
    }
  }, [split, hasMacd])

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

        // Use splitRef so we get the live split without adding split to deps
        histSeries.priceScale().applyOptions({
          scaleMargins: splitMargins(splitRef.current).macd,
        })
        // Keep a ref to this series for future scale-margin updates
        if (!macdScaleRef.current) macdScaleRef.current = histSeries
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
  }, [macdConfigs, macdData])

  // ── Guppy MMA series ──────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = guppySeriesMap.current
    const incoming = new Set(guppyConfigs.map(g => g.id))

    // Remove stale configs
    for (const [id, seriesByPeriod] of map) {
      if (!incoming.has(id)) {
        for (const s of seriesByPeriod.values()) chart.removeSeries(s)
        map.delete(id)
      }
    }

    for (const cfg of guppyConfigs) {
      if (!map.has(cfg.id)) {
        // Create 12 line series — 6 short (red group) + 6 long (blue group)
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
        // Update colors if changed
        const seriesByPeriod = map.get(cfg.id)
        for (const p of GUPPY_SHORT) seriesByPeriod.get(p)?.applyOptions({ color: cfg.shortColor })
        for (const p of GUPPY_LONG)  seriesByPeriod.get(p)?.applyOptions({ color: cfg.longColor })
      }

      // Set data for each period from emaData
      const seriesByPeriod = map.get(cfg.id)
      for (const [period, series] of seriesByPeriod) {
        series.setData(emaData[String(period)] ?? [])
      }
    }
  }, [guppyConfigs, emaData])

  // ── Render ────────────────────────────────────────────────────────────────

  const isUp = hover ? hover.close >= hover.open : true
  const clr  = isUp ? '#26a69a' : '#ef5350'

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
          // offset below MA legend if both are present
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
              <span style={{ color: 'var(--text-muted)'}}>/</span>
              <span style={{ color: cfg.longColor }}>L</span>
            </span>
          ))}
        </div>
      )}

      {/* Draggable separator — only shown when MACD pane is visible */}
      {hasMacd && (
        <div
          onMouseDown={e => {
            e.preventDefault()
            isDraggingRef.current = true
            setIsDragging(true)
          }}
          style={{
            position: 'absolute', zIndex: 20,
            top: `${split * 100}%`, left: 0, right: 0,
            height: '5px',
            transform: 'translateY(-2px)',
            cursor: 'row-resize',
            background: isDragging ? 'var(--blue, #2962ff)' : 'var(--border)',
            transition: isDragging ? 'none' : 'background 0.15s',
          }}
        />
      )}

      {/* MACD legend */}
      {hasMacd && (
        <div style={{
          position: 'absolute', zIndex: 10, pointerEvents: 'none',
          top: `calc(${split * 100}% + 8px)`, left: 12,
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

      {/* Chart canvas */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}
