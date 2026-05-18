import { useEffect, useRef, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'

// ── Layout constants ──────────────────────────────────────────────────────────
//
// Single chart instance — scaleMargins controls which vertical slice each
// price scale occupies.  Time axis is shared; no sync code needed.

const SPLIT = 0.65   // fraction of canvas height for the price pane

const MARGINS = {
  main: {
    solo:     { top: 0.05, bottom: 0.22 },
    withMacd: { top: 0.03, bottom: 0.38 },
  },
  vol: {
    solo:     { top: 0.80, bottom: 0.00 },
    withMacd: { top: 0.55, bottom: 0.36 },
  },
  macd: { top: SPLIT + 0.03, bottom: 0.02 },
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
    scaleMargins: MARGINS.main.solo,
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
  maData       = {},   // { "20": [{time,value}, ...] }
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

  const [hover,      setHover]      = useState(null)
  const [maLegend,   setMaLegend]   = useState({})
  const [macdLegend, setMacdLegend] = useState({})

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
    chart.priceScale('vol').applyOptions({ scaleMargins: MARGINS.vol.solo })

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
      // Clear series maps so the StrictMode double-mount (or any remount) starts
      // fresh — stale series references from a destroyed chart silently fail.
      maSeriesMap.current.clear()
      macdSeriesMap.current.clear()
      maLastValsRef.current  = {}
      macdLastRef.current    = {}
      macdByTimeRef.current  = {}
    }
  }, [])

  // ── Adjust scale margins when MACD pane appears / disappears ─────────────

  useEffect(() => {
    if (!chartRef.current) return
    chartRef.current.priceScale('right').applyOptions({
      scaleMargins: hasMacd ? MARGINS.main.withMacd : MARGINS.main.solo,
    })
    chartRef.current.priceScale('vol').applyOptions({
      scaleMargins: hasMacd ? MARGINS.vol.withMacd : MARGINS.vol.solo,
    })
  }, [hasMacd])

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

  // ── MA series (data from backend) ─────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = maSeriesMap.current
    const incoming = new Set(maConfigs.map(m => m.id))

    // Remove stale series
    for (const [id, series] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(series)
        map.delete(id)
        delete maLastValsRef.current[id]
      }
    }

    for (const ma of maConfigs) {
      // Create series if new
      if (!map.has(ma.id)) {
        map.set(ma.id, chart.addLineSeries({
          color: ma.color, lineWidth: ma.width,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }))
      } else {
        map.get(ma.id).applyOptions({ color: ma.color, lineWidth: ma.width })
      }

      // Set data from backend payload; key is the period as a string
      const data = maData[String(ma.period)] ?? []
      map.get(ma.id).setData(data)
      if (data.length) maLastValsRef.current[ma.id] = data[data.length - 1].value
    }

    // Purge last-vals for removed configs
    for (const id of Object.keys(maLastValsRef.current))
      if (!incoming.has(id)) delete maLastValsRef.current[id]
    setMaLegend({ ...maLastValsRef.current })
  }, [maConfigs, maData])

  // ── MACD series (data from backend) ──────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const map      = macdSeriesMap.current
    const incoming = new Set(macdConfigs.map(m => m.id))

    // Remove stale series
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

    for (const cfg of macdConfigs) {
      if (!map.has(cfg.id)) {
        // ── Create the three MACD series ──────────────────────────────────
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

        // Apply scale margins via the series instance — more reliable than
        // chart.priceScale('macd') for custom overlay scales in v4
        histSeries.priceScale().applyOptions({ scaleMargins: MARGINS.macd })
      } else {
        const s = map.get(cfg.id)
        s.macd.applyOptions({ color: cfg.macdColor })
        s.signal.applyOptions({ color: cfg.signalColor })
      }

      // ── Populate from backend payload ─────────────────────────────────
      const key = `${cfg.fast},${cfg.slow},${cfg.signal}`
      const d   = macdData[key]
      if (!d) continue   // not yet fetched — leave series empty for now

      const macdLine   = d.macd_line   ?? []
      const signalLine = d.signal_line ?? []
      const rawHist    = d.histogram   ?? []

      // Add bar colours (backend sends plain {time, value})
      const histogram = rawHist.map(p => ({
        ...p, color: p.value >= 0 ? '#26a69a' : '#ef5350',
      }))

      const s = map.get(cfg.id)
      s.histogram.setData(histogram)
      s.macd.setData(macdLine)
      s.signal.setData(signalLine)

      // Build time-keyed lookup for crosshair legend
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

  // ── Render ────────────────────────────────────────────────────────────────

  const isUp = hover ? hover.close >= hover.open : true
  const clr  = isUp ? '#26a69a' : '#ef5350'

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>

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

      {/* Separator */}
      {hasMacd && (
        <div style={{
          position: 'absolute', zIndex: 2, pointerEvents: 'none',
          top: `${SPLIT * 100}%`, left: 0, right: 0, height: '1px',
          background: 'var(--border)',
        }} />
      )}

      {/* MACD legend */}
      {hasMacd && (
        <div style={{
          position: 'absolute', zIndex: 10, pointerEvents: 'none',
          top: `calc(${SPLIT * 100}% + 6px)`, left: 12,
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

      {/* Single chart canvas */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0 }} />
    </div>
  )
}
