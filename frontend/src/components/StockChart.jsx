import { useEffect, useRef, useState } from 'react'
import { createChart, CrosshairMode } from 'lightweight-charts'

// ── Chart option presets ──────────────────────────────────────────────────────

const BASE_OPTS = {
  layout: {
    background: { color: '#131722' },
    textColor: '#9598a1',
  },
  grid: {
    vertLines: { color: '#1e222d' },
    horzLines: { color: '#1e222d' },
  },
  crosshair: { mode: CrosshairMode.Normal },
  timeScale: {
    borderColor: '#2a2e39',
    timeVisible: true,
    secondsVisible: false,
  },
}

const CHART_OPTS = {
  ...BASE_OPTS,
  rightPriceScale: {
    borderColor: '#2a2e39',
    scaleMargins: { top: 0.1, bottom: 0.3 },
  },
}

const MACD_CHART_OPTS = {
  ...BASE_OPTS,
  rightPriceScale: {
    borderColor: '#2a2e39',
    scaleMargins: { top: 0.15, bottom: 0.1 },
  },
}

// ── Formatters ────────────────────────────────────────────────────────────────

function fmtPrice(n)  { return n == null ? '—' : n.toFixed(2) }
function fmtMacd(n)   { return n == null ? '—' : n.toFixed(4) }

function fmtVolume(n) {
  if (n == null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return String(n)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function applyVisibleRange(chart, candles, visibleDays) {
  if (!candles?.length) return
  if (!isFinite(visibleDays)) { chart.timeScale().fitContent(); return }
  const last = candles[candles.length - 1]
  try {
    if (typeof last.time === 'number') {
      chart.timeScale().setVisibleRange({ from: last.time - visibleDays * 86400, to: last.time + 3600 })
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

// ── SMA ───────────────────────────────────────────────────────────────────────

function calcMA(candles, period) {
  const result = []
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += candles[j].close
    result.push({ time: candles[i].time, value: sum / period })
  }
  return result
}

// ── MACD ──────────────────────────────────────────────────────────────────────

function calcEMA(values, period) {
  if (values.length < period) return values.map(() => null)
  const k = 2 / (period + 1)
  const result = new Array(period - 1).fill(null)
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period
  result.push(ema)
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k)
    result.push(ema)
  }
  return result
}

function calcMACD(candles, fast, slow, signal) {
  const closes  = candles.map(c => c.close)
  const fastEMA = calcEMA(closes, fast)
  const slowEMA = calcEMA(closes, slow)

  const macdVals = [], macdTimes = []
  for (let i = slow - 1; i < candles.length; i++) {
    macdVals.push(fastEMA[i] - slowEMA[i])
    macdTimes.push(candles[i].time)
  }

  const signalEMA = calcEMA(macdVals, signal)
  const macdLine = [], signalLine = [], histogram = []
  for (let i = 0; i < macdVals.length; i++) {
    macdLine.push({ time: macdTimes[i], value: macdVals[i] })
    if (signalEMA[i] != null) {
      signalLine.push({ time: macdTimes[i], value: signalEMA[i] })
      const hist = macdVals[i] - signalEMA[i]
      histogram.push({ time: macdTimes[i], value: hist,
                       color: hist >= 0 ? '#26a69a' : '#ef5350' })
    }
  }

  // Time-keyed lookup for crosshair legend
  const byTime = new Map()
  for (let i = 0; i < signalLine.length; i++) {
    const mi = macdLine.length - signalLine.length + i
    byTime.set(signalLine[i].time, {
      macd: macdLine[mi].value, signal: signalLine[i].value, hist: histogram[i].value,
    })
  }
  return { macdLine, signalLine, histogram, byTime }
}

// ── Component ─────────────────────────────────────────────────────────────────

export function StockChart({
  candles, volume,
  visibleDays = Infinity,
  maConfigs   = [],
  macdConfigs = [],
}) {
  // Main chart
  const containerRef   = useRef(null)
  const chartRef       = useRef(null)
  const candleRef      = useRef(null)
  const volumeRef      = useRef(null)
  const candlesRef     = useRef([])
  const lastBarRef     = useRef(null)
  const visibleDaysRef = useRef(visibleDays)

  // MA
  const maSeriesMap   = useRef(new Map())
  const maLastValsRef = useRef({})

  // MACD
  const macdContainerRef = useRef(null)
  const macdChartRef     = useRef(null)
  const macdSeriesMap    = useRef(new Map())
  const macdLastRef      = useRef({})
  const macdByTimeRef    = useRef({})

  // Timescale sync guard
  const syncingTSRef = useRef(false)

  const [hover,      setHover]      = useState(null)
  const [maLegend,   setMaLegend]   = useState({})
  const [macdLegend, setMacdLegend] = useState({})

  const hasMacd = macdConfigs.length > 0

  useEffect(() => { visibleDaysRef.current = visibleDays }, [visibleDays])

  // ── Create main chart (once) ────────────────────────────────────────────────

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
      priceFormat: { type: 'volume' }, priceScaleId: 'volume',
    })
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } })

    // Timescale: main → MACD
    chart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncingTSRef.current || !range || !macdChartRef.current) return
      syncingTSRef.current = true
      macdChartRef.current.timeScale().setVisibleLogicalRange(range)
      syncingTSRef.current = false
    })

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
        setHover({ open: candle.open, high: candle.high, low: candle.low,
                   close: candle.close, volume: vol?.value ?? null, change, changePct })

        // MACD legend from time-keyed lookup
        const macdVals = {}
        for (const [id, byTime] of Object.entries(macdByTimeRef.current)) {
          macdVals[id] = byTime.get(candle.time) ?? macdLastRef.current[id] ?? null
        }
        setMacdLegend(macdVals)
      }

      // MA legend from series data
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
      maSeriesMap.current.clear()
      chart.remove()
    }
  }, [])

  // ── Create / destroy MACD chart ─────────────────────────────────────────────

  useEffect(() => {
    if (!hasMacd) {
      if (macdChartRef.current) {
        macdChartRef.current.remove()
        macdChartRef.current = null
        macdSeriesMap.current.clear()
      }
      return
    }

    if (!macdContainerRef.current || macdChartRef.current) return

    const macdChart = createChart(macdContainerRef.current, {
      ...MACD_CHART_OPTS,
      width:  macdContainerRef.current.clientWidth,
      height: macdContainerRef.current.clientHeight,
    })
    macdChartRef.current = macdChart

    // Timescale: MACD → main
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
      if (syncingTSRef.current || !range || !chartRef.current) return
      syncingTSRef.current = true
      chartRef.current.timeScale().setVisibleLogicalRange(range)
      syncingTSRef.current = false
    })

    macdChart.subscribeCrosshairMove(param => {
      const vals = {}
      for (const [id, series] of macdSeriesMap.current) {
        const macdPt = param.seriesData?.get(series.macd)
        const sigPt  = param.seriesData?.get(series.signal)
        const histPt = param.seriesData?.get(series.histogram)
        vals[id] = {
          macd:   macdPt?.value ?? macdLastRef.current[id]?.macd   ?? null,
          signal: sigPt?.value  ?? macdLastRef.current[id]?.signal ?? null,
          hist:   histPt?.value ?? macdLastRef.current[id]?.hist   ?? null,
        }
      }
      setMacdLegend(vals)

      if (param.logical == null || !param.seriesData?.size) {
        setHover(lastBarRef.current)
        setMaLegend({ ...maLastValsRef.current })
      }
    })

    // Seed MACD timescale from main chart's current visible range
    const range = chartRef.current?.timeScale().getVisibleLogicalRange()
    if (range) macdChart.timeScale().setVisibleLogicalRange(range)

    const ro = new ResizeObserver(() => {
      if (macdContainerRef.current)
        macdChart.resize(macdContainerRef.current.clientWidth, macdContainerRef.current.clientHeight)
    })
    ro.observe(macdContainerRef.current)

    return () => {
      ro.disconnect()
      macdChart.remove()
      macdChartRef.current = null
      macdSeriesMap.current.clear()
    }
  }, [hasMacd])

  // ── Load candle data ────────────────────────────────────────────────────────

  useEffect(() => {
    if (!candleRef.current || !candles?.length) return
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

  // ── Range zoom ───────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current || !candlesRef.current.length) return
    applyVisibleRange(chartRef.current, candlesRef.current, visibleDays)
  }, [visibleDays])

  // ── MA series ────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current) return
    const chart    = chartRef.current
    const candles  = candlesRef.current
    const map      = maSeriesMap.current
    const incoming = new Set(maConfigs.map(m => m.id))

    for (const [id, series] of map)
      if (!incoming.has(id)) { chart.removeSeries(series); map.delete(id) }

    for (const ma of maConfigs) {
      if (!map.has(ma.id)) {
        map.set(ma.id, chart.addLineSeries({
          color: ma.color, lineWidth: ma.width,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }))
      } else {
        map.get(ma.id).applyOptions({ color: ma.color, lineWidth: ma.width })
      }
      const data = candles.length >= ma.period ? calcMA(candles, ma.period) : []
      map.get(ma.id).setData(data)
      if (data.length > 0) maLastValsRef.current[ma.id] = data[data.length - 1].value
    }

    for (const id of Object.keys(maLastValsRef.current))
      if (!incoming.has(id)) delete maLastValsRef.current[id]

    setMaLegend({ ...maLastValsRef.current })
  }, [maConfigs, candles])

  // ── MACD series ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!macdChartRef.current || !candlesRef.current.length) return
    const chart    = macdChartRef.current
    const candles  = candlesRef.current
    const map      = macdSeriesMap.current
    const incoming = new Set(macdConfigs.map(m => m.id))

    for (const [id, s] of map) {
      if (!incoming.has(id)) {
        chart.removeSeries(s.macd); chart.removeSeries(s.signal); chart.removeSeries(s.histogram)
        map.delete(id)
        delete macdLastRef.current[id]; delete macdByTimeRef.current[id]
      }
    }

    for (const cfg of macdConfigs) {
      if (!map.has(cfg.id)) {
        const histSeries   = chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false })
        const macdSeries   = chart.addLineSeries({
          color: cfg.macdColor, lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        const signalSeries = chart.addLineSeries({
          color: cfg.signalColor, lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        })
        map.set(cfg.id, { macd: macdSeries, signal: signalSeries, histogram: histSeries })
      } else {
        const s = map.get(cfg.id)
        s.macd.applyOptions({ color: cfg.macdColor })
        s.signal.applyOptions({ color: cfg.signalColor })
      }

      const { macdLine, signalLine, histogram, byTime } = calcMACD(candles, cfg.fast, cfg.slow, cfg.signal)
      const s = map.get(cfg.id)
      s.histogram.setData(histogram)
      s.macd.setData(macdLine)
      s.signal.setData(signalLine)
      macdByTimeRef.current[cfg.id] = byTime

      if (signalLine.length > 0) {
        macdLastRef.current[cfg.id] = {
          macd:   macdLine[macdLine.length - 1].value,
          signal: signalLine[signalLine.length - 1].value,
          hist:   histogram[histogram.length - 1]?.value ?? null,
        }
      }
    }

    setMacdLegend({ ...macdLastRef.current })
  }, [macdConfigs, candles])

  // ── Render ────────────────────────────────────────────────────────────────────

  const isUp = hover ? hover.close >= hover.open : true
  const clr  = isUp ? '#26a69a' : '#ef5350'

  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>

      {/* ── Main chart pane ── */}
      <div style={{ flex: hasMacd ? '0 0 65%' : 1, position: 'relative', minHeight: 0 }}>

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

        <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {/* ── MACD pane ── */}
      {hasMacd && (
        <div style={{ flex: 1, position: 'relative', minHeight: 0, borderTop: '1px solid var(--border)' }}>

          {/* MACD legend */}
          <div style={{
            position: 'absolute', top: 6, left: 12, zIndex: 10,
            display: 'flex', flexWrap: 'wrap', gap: '14px',
            fontSize: '11px', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
          }}>
            {macdConfigs.map(cfg => {
              const v = macdLegend[cfg.id]
              return (
                <span key={cfg.id} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ color: 'var(--text-muted)' }}>MACD ({cfg.fast},{cfg.slow},{cfg.signal})</span>
                  <span style={{ color: cfg.macdColor }}>{fmtMacd(v?.macd ?? null)}</span>
                  <span style={{ color: cfg.signalColor }}>{fmtMacd(v?.signal ?? null)}</span>
                  {v?.hist != null && (
                    <span style={{ color: v.hist >= 0 ? '#26a69a' : '#ef5350' }}>{fmtMacd(v.hist)}</span>
                  )}
                </span>
              )
            })}
          </div>

          <div ref={macdContainerRef} style={{ width: '100%', height: '100%' }} />
        </div>
      )}
    </div>
  )
}
