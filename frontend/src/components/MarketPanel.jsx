import { useEffect, useRef, useState } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────

const PAD_RIGHT  = 60   // value axis
const PAD_TOP    = 16
const PAD_BOT    = 20   // date axis (single row: month or year)

const COL_LINE   = '#2962FF'
const COL_OB     = 'rgba(239,83,80,0.18)'   // overbought fill — red tint
const COL_OS     = 'rgba(38,166,154,0.18)'  // oversold fill  — green tint
const OB_LEVEL   =  70
const OS_LEVEL   = -70

const THEME = {
  light: { bg: '#ffffff', grid: '#f0f3fa', axis: '#e0e3eb', label: '#6b7280', dim: '#d1d5db', zero: '#9ca3af' },
  dark:  { bg: '#131722', grid: '#1e222d', axis: '#2a2e39', label: '#9598a1', dim: '#374151', zero: '#4b5563' },
}

// ── Indicator chart (canvas) ──────────────────────────────────────────────────

function IndicatorChart({ title, symbol, years = 3, theme = 'light', fixedMin, fixedMax, bandHigh, bandLow, syncDate, onSyncDate }) {
  const containerRef  = useRef(null)
  const canvasRef     = useRef(null)
  const dataRef       = useRef([])          // [{date, value}]
  const viewRef       = useRef({ offset: 0, zoom: 120 })
  const themeRef      = useRef(theme)
  const fixedRangeRef = useRef({ fixedMin, fixedMax })
  const bandRef       = useRef({ bandHigh, bandLow })
  const syncDateRef   = useRef(syncDate)
  const onSyncDateRef = useRef(onSyncDate)
  const hoverRef      = useRef(null)        // {idx}
  const drawRef       = useRef(null)
  const isDragging    = useRef(false)
  const dragStart     = useRef({ x: 0, offset: 0 })
  const mousePosRef   = useRef(null)        // {x, y} in canvas CSS px

  const [hover,     setHover]     = useState(null)
  const [syncHover, setSyncHover] = useState(null)
  const [status,    setStatus]    = useState({ loading: false, error: null })

  useEffect(() => { themeRef.current = theme }, [theme])
  useEffect(() => { fixedRangeRef.current = { fixedMin, fixedMax } }, [fixedMin, fixedMax])
  useEffect(() => { bandRef.current = { bandHigh, bandLow } }, [bandHigh, bandLow])
  useEffect(() => { onSyncDateRef.current = onSyncDate }, [onSyncDate])
  useEffect(() => {
    syncDateRef.current = syncDate
    if (hoverRef.current == null) {
      const d = syncDate ? (dataRef.current.find(p => p.date === syncDate) ?? null) : null
      setSyncHover(d)
      drawRef.current?.()
    }
  }, [syncDate])

  // ── Draw ────────────────────────────────────────────────────────────────────

  function draw() {
    const canvas = canvasRef.current
    const data   = dataRef.current
    if (!canvas || !data.length) return

    const dpr = window.devicePixelRatio || 1
    const W   = canvas.offsetWidth
    const H   = canvas.offsetHeight
    if (W <= 0 || H <= 0) return

    canvas.width  = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    const t = THEME[themeRef.current] ?? THEME.light
    const { offset, zoom } = viewRef.current

    const start   = Math.max(0, Math.min(offset, data.length - 1))
    const count   = Math.min(zoom, data.length - start)
    const visible = data.slice(start, start + count)

    const plotW = W - PAD_RIGHT
    const plotH = H - PAD_TOP - PAD_BOT
    if (!visible.length || plotW <= 0 || plotH <= 0) return

    const { fixedMin: fMin, fixedMax: fMax } = fixedRangeRef.current
    const hasFixed = fMin != null && fMax != null
    let lo, hi
    if (hasFixed) {
      lo = fMin
      hi = fMax
    } else {
      const minV = Math.min(...visible.map(d => d.value), OS_LEVEL - 10)
      const maxV = Math.max(...visible.map(d => d.value), OB_LEVEL + 10)
      const pad  = (maxV - minV) * 0.05
      lo = minV - pad
      hi = maxV + pad
    }
    const range = hi - lo

    const bW  = plotW / (zoom + 5)
    const toX = i => i * bW
    const toY = v => PAD_TOP + plotH * (1 - (v - lo) / range)

    // Background
    ctx.fillStyle = t.bg
    ctx.fillRect(0, 0, W, H)

    // Overbought / oversold bands
    const { bandHigh: bHigh, bandLow: bLow } = bandRef.current
    const hasBands = bHigh != null && bLow != null
    if (!hasFixed && !hasBands) {
      // NYMO default bands
      const obY = toY(OB_LEVEL), osY = toY(OS_LEVEL)
      ctx.fillStyle = COL_OB
      ctx.fillRect(0, PAD_TOP, plotW, Math.max(0, obY - PAD_TOP))
      ctx.fillStyle = COL_OS
      ctx.fillRect(0, osY, plotW, Math.max(0, H - PAD_BOT - osY))
    } else if (hasBands) {
      const obY = toY(bHigh), osY = toY(bLow)
      ctx.fillStyle = COL_OB
      ctx.fillRect(0, PAD_TOP, plotW, Math.max(0, obY - PAD_TOP))
      ctx.fillStyle = COL_OS
      ctx.fillRect(0, osY, plotW, Math.max(0, H - PAD_BOT - osY))
    }

    // Reference lines
    const obLevel = hasBands ? bHigh : OB_LEVEL
    const osLevel = hasBands ? bLow  : OS_LEVEL
    const refLines = hasFixed
      ? [
          { v: fMax,               label: String(fMax) },
          { v: (fMin + fMax) / 2,  label: String((fMin + fMax) / 2) },
          { v: fMin,               label: String(fMin) },
        ]
      : [
          { v: obLevel, label: String(obLevel) },
          { v: 0,       label: '0' },
          { v: osLevel, label: String(osLevel) },
        ]
    const midRef = hasFixed ? (fMin + fMax) / 2 : 0
    ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
    ctx.textAlign = 'left'
    for (const { v, label } of refLines) {
      const isMid = v === midRef
      const y = Math.round(toY(v)) + 0.5
      ctx.strokeStyle = isMid ? t.zero : t.axis
      ctx.lineWidth   = isMid ? 1.5 : 1
      ctx.setLineDash(isMid ? [] : [4, 4])
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = t.label
      ctx.fillText(label, plotW + 5, y + 3.5)
    }

    // Line graph
    ctx.lineWidth   = 1.5
    ctx.lineJoin    = 'round'
    ctx.setLineDash([])

    // Draw line in two segments: positive (teal) and negative (red), or just one color
    // Use a single blue/purple line for NYMO (common in charting tools)
    ctx.strokeStyle = COL_LINE
    ctx.beginPath()
    visible.forEach((d, i) => {
      const x = toX(i) + bW / 2
      const y = toY(d.value)
      if (i === 0) ctx.moveTo(x, y)
      else         ctx.lineTo(x, y)
    })
    ctx.stroke()

    // Axis separator
    ctx.strokeStyle = t.axis
    ctx.lineWidth   = 1
    ctx.setLineDash([])
    ctx.beginPath(); ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, H); ctx.stroke()

    // ── Crosshair (synced across charts) ────────────────────────────────────────
    // Resolve which bar to highlight: own hover takes precedence, else syncDate
    const mp      = mousePosRef.current
    const hovered = hoverRef.current
    const isDark  = themeRef.current === 'dark'

    let crosshairLocalI = null
    let crosshairDate   = null
    if (hovered != null) {
      const localI = hovered.idx - start
      if (localI >= 0 && localI < count) {
        crosshairLocalI = localI
        crosshairDate   = data[hovered.idx]?.date ?? null
      }
    } else {
      const sd = syncDateRef.current
      if (sd) {
        const gi = data.findIndex(d => d.date === sd)
        if (gi >= 0) {
          const localI = gi - start
          if (localI >= 0 && localI < count) {
            crosshairLocalI = localI
            crosshairDate   = sd
          }
        }
      }
    }

    if (crosshairLocalI != null) {
      const cx = Math.round(toX(crosshairLocalI) + bW / 2) + 0.5
      const d  = visible[crosshairLocalI]

      // Dot on the line
      if (d) {
        const x = toX(crosshairLocalI) + bW / 2
        const y = toY(d.value)
        ctx.fillStyle   = COL_LINE
        ctx.beginPath()
        ctx.arc(x, y, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.strokeStyle = isDark ? '#131722' : '#ffffff'
        ctx.lineWidth   = 1.5
        ctx.stroke()
      }

      // Crosshair lines
      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = t.label
      ctx.lineWidth   = 1
      ctx.globalAlpha = 0.6
      ctx.beginPath(); ctx.moveTo(cx, PAD_TOP); ctx.lineTo(cx, H - PAD_BOT); ctx.stroke()
      if (mp && hovered != null) {
        ctx.beginPath(); ctx.moveTo(0, mp.y); ctx.lineTo(plotW, mp.y); ctx.stroke()
      }
      ctx.restore()

      // Price label on value axis — shown on all charts at the bar's actual value
      if (d) {
        const labelH = 14
        const labelY = Math.round(toY(d.value))
        const clampedY = Math.max(PAD_TOP + labelH / 2, Math.min(H - PAD_BOT - labelH / 2, labelY))
        ctx.fillStyle = isDark ? '#4b5563' : '#e5e7eb'
        ctx.fillRect(plotW + 1, clampedY - labelH / 2, PAD_RIGHT - 2, labelH)
        ctx.fillStyle = isDark ? '#d1d5db' : '#1f2937'
        ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
        ctx.textAlign = 'left'
        ctx.fillText(d.value.toFixed(2), plotW + 4, clampedY + 3.5)
      }

      // Date label on bottom axis (all charts)
      if (crosshairDate) {
        const [yyyy, mm, dd] = crosshairDate.split('-')
        const dateLabel = `${mm}-${dd}-${yyyy}`
        ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
        ctx.textAlign = 'center'
        const dlW = ctx.measureText(dateLabel).width + 10
        const dlX = Math.max(0, Math.min(plotW - dlW, cx - dlW / 2))
        ctx.fillStyle = isDark ? '#4b5563' : '#e5e7eb'
        ctx.fillRect(dlX, H - PAD_BOT, dlW, PAD_BOT - 1)
        ctx.fillStyle = isDark ? '#d1d5db' : '#1f2937'
        ctx.fillText(dateLabel, dlX + dlW / 2, H - 6)
      }
    }

    // Date labels — one label at the first bar of each month
    // Jan → show year, other months → show 3-letter abbreviation
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
    ctx.textAlign = 'center'
    ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
    ctx.fillStyle = t.label
    let lastMonth = null
    for (let i = 0; i < count; i++) {
      const d = visible[i]
      if (!d) continue
      const yyyy = d.date.slice(0, 4)
      const mm   = d.date.slice(5, 7)
      const key  = `${yyyy}-${mm}`
      if (key === lastMonth) continue
      lastMonth = key
      const cx2   = toX(i) + bW / 2
      const label = mm === '01' ? yyyy : MONTHS[parseInt(mm, 10) - 1]
      ctx.fillText(label, cx2, H - 6)
    }
  }

  drawRef.current = draw

  // ── Fetch ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    setStatus({ loading: true, error: null })
    fetch(`/api/market/indicator?symbol=${encodeURIComponent(symbol)}&years=${years}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => {
        dataRef.current = d.data
        const n = d.data.length
        viewRef.current = { offset: 0, zoom: n }
        setStatus({ loading: false, error: null })
        drawRef.current?.()
      })
      .catch(e => setStatus({ loading: false, error: e.message }))
  }, [symbol, years])

  useEffect(() => { drawRef.current?.() }, [theme])

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => drawRef.current?.())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function barAtX(clientX) {
    const canvas = canvasRef.current
    if (!canvas || !dataRef.current.length) return null
    const rect  = canvas.getBoundingClientRect()
    const x     = clientX - rect.left
    const { offset, zoom } = viewRef.current
    const plotW = rect.width - PAD_RIGHT
    if (x < 0 || x > plotW) return null
    const bW    = plotW / (zoom + 5)
    const i     = Math.floor(x / bW)
    const count = Math.min(zoom, dataRef.current.length - offset)
    return i >= 0 && i < count ? { localIdx: i, globalIdx: offset + i } : null
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  function handleWheel(e) {
    e.preventDefault()
    if (!dataRef.current.length) return
    const { offset, zoom } = viewRef.current
    const n      = dataRef.current.length
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
    const newZoom   = Math.round(Math.max(5, Math.min(n, zoom * factor)))
    const newOffset = Math.max(0, Math.min(n - 1, offset + Math.round((zoom - newZoom) / 2)))
    viewRef.current = { offset: newOffset, zoom: newZoom }
    drawRef.current?.()
  }

  function handleMouseDown(e) {
    isDragging.current = true
    dragStart.current  = { x: e.clientX, offset: viewRef.current.offset }
  }

  function handleMouseMove(e) {
    const canvas = canvasRef.current
    const data   = dataRef.current
    if (!canvas || !data.length) return

    if (isDragging.current) {
      mousePosRef.current = null
      const rect   = canvas.getBoundingClientRect()
      const { zoom } = viewRef.current
      const bW     = (rect.width - PAD_RIGHT) / (zoom + 5)
      const dBricks = -Math.round((e.clientX - dragStart.current.x) / bW)
      const newOffset = Math.max(0, Math.min(data.length - 1, dragStart.current.offset + dBricks))
      if (newOffset !== viewRef.current.offset) {
        viewRef.current = { ...viewRef.current, offset: newOffset }
        drawRef.current?.()
      }
      return
    }

    const rect   = canvas.getBoundingClientRect()
    const mouseY = e.clientY - rect.top
    const hit    = barAtX(e.clientX)

    if (!hit) {
      if (hoverRef.current != null || mousePosRef.current != null) {
        hoverRef.current    = null
        mousePosRef.current = null
        setHover(null)
        drawRef.current?.()
      }
      return
    }

    const newPos    = { x: e.clientX - rect.left, y: mouseY }
    const posChanged = !mousePosRef.current || mousePosRef.current.y !== newPos.y
    mousePosRef.current = newPos

    if (hoverRef.current?.idx !== hit.globalIdx || posChanged) {
      hoverRef.current = { idx: hit.globalIdx }
      const d = data[hit.globalIdx]
      setHover(d)
      onSyncDateRef.current?.(d.date)
      drawRef.current?.()
    }
  }

  function handleMouseUp()    { isDragging.current = false }
  function handleMouseLeave() {
    isDragging.current  = false
    // Clear local hover but keep syncDate so crosshair persists on all charts
    if (hoverRef.current != null || mousePosRef.current != null) {
      hoverRef.current    = null
      mousePosRef.current = null
      setHover(null)
      drawRef.current?.()
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const displayHover = hover ?? syncHover
  const valColor     = hover ? COL_LINE : 'var(--text-secondary)'

  return (
    <div ref={containerRef} style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden', position: 'relative' }}>
      {/* Header */}
      <div style={{
        padding: '6px 14px', flexShrink: 0,
        background: 'var(--bg-panel)', borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: '16px',
        fontSize: '12px', fontFamily: 'var(--font-mono)',
      }}>
        <span style={{ fontWeight: 700, color: 'var(--text-primary)' }}>{title}</span>
        {displayHover ? (
          <>
            <span style={{ color: valColor, fontWeight: 600 }}>{displayHover.value.toFixed(2)}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{displayHover.date}</span>
          </>
        ) : (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>scroll to zoom · drag to pan</span>
        )}
      </div>

      {/* Loading / error */}
      {status.loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-secondary)', fontSize: '13px', pointerEvents: 'none' }}>
          Loading…
        </div>
      )}
      {status.error && !status.loading && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ padding: '12px 20px', borderRadius: '8px', background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)', color: 'var(--red)', fontSize: '13px' }}>
            {status.error}
          </div>
        </div>
      )}

      {/* Canvas */}
      <canvas
        ref={canvasRef}
        style={{ display: 'block', flex: 1, width: '100%', minHeight: 0 }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  )
}

// ── Market panel ──────────────────────────────────────────────────────────────

export function MarketPanel({ theme = 'light' }) {
  const [syncDate, setSyncDate] = useState(null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Upper half — reserved, empty */}
      <div style={{ flex: 1 }} />

      {/* Lower half — three indicator charts side by side */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', borderTop: '1px solid var(--border)' }}>
        <IndicatorChart
          title="$NYMO — McClellan Oscillator"
          symbol="$NYMO"
          years={2}
          theme={theme}
          syncDate={syncDate}
          onSyncDate={setSyncDate}
        />
        <div style={{ width: '1px', background: 'var(--border)', flexShrink: 0 }} />
        <IndicatorChart
          title="$BPNYA — NYSE Bullish Percent"
          symbol="$BPNYA"
          years={2}
          theme={theme}
          fixedMin={0}
          fixedMax={100}
          bandHigh={80}
          bandLow={20}
          syncDate={syncDate}
          onSyncDate={setSyncDate}
        />
        <div style={{ width: '1px', background: 'var(--border)', flexShrink: 0 }} />
        <IndicatorChart
          title="$NYA50R — NYSE % Above 50-day MA"
          symbol="$NYA50R"
          years={2}
          theme={theme}
          fixedMin={0}
          fixedMax={100}
          bandHigh={80}
          bandLow={20}
          syncDate={syncDate}
          onSyncDate={setSyncDate}
        />
      </div>
    </div>
  )
}
