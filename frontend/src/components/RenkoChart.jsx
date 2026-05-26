import { useEffect, useRef, useState } from 'react'

// ── Constants ─────────────────────────────────────────────────────────────────

const UP_COLOR   = '#26a69a'
const DOWN_COLOR = '#ef5350'
const PAD_RIGHT  = 70   // price axis
const PAD_TOP    = 10
const PAD_BOT    = 26   // date axis

const THEME = {
  light: { bg: '#ffffff', grid: '#f0f3fa', axis: '#e0e3eb', label: '#6b7280', dim: '#d1d5db' },
  dark:  { bg: '#131722', grid: '#1e222d', axis: '#2a2e39', label: '#9598a1', dim: '#374151' },
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function niceStep(range, targetTicks) {
  if (targetTicks <= 0 || range <= 0) return 1
  const raw  = range / targetTicks
  const mag  = Math.pow(10, Math.floor(Math.log10(raw)))
  const n    = raw / mag
  const nice = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10
  return nice * mag
}

function fmtPrice(n) {
  if (n == null) return '—'
  if (n >= 1000) return n.toFixed(2)
  if (n >= 100)  return n.toFixed(2)
  if (n >= 1)    return n.toFixed(3)
  return n.toFixed(4)
}

// ── Component ─────────────────────────────────────────────────────────────────

export function RenkoChart({ symbol, theme = 'light' }) {
  const containerRef   = useRef(null)
  const canvasRef      = useRef(null)
  const dataRef        = useRef(null)   // { bricks: [], brick_size: number }
  const viewRef        = useRef({ offset: 0, zoom: 80 })
  const themeRef       = useRef(theme)
  const hoverIdxRef    = useRef(null)   // global brick index currently hovered
  const mousePosRef    = useRef(null)   // { x, y } in CSS pixels relative to canvas
  const drawRef        = useRef(null)   // always points to the latest draw()
  const isDraggingRef  = useRef(false)
  const dragStartRef   = useRef({ x: 0, offset: 0 })

  const [hover,  setHover]  = useState(null)   // hovered brick data
  const [status, setStatus] = useState({ loading: false, error: null })

  // Keep themeRef in sync so draw() always reads the current theme
  useEffect(() => { themeRef.current = theme }, [theme])

  // ── Draw ────────────────────────────────────────────────────────────────────

  function draw() {
    const canvas = canvasRef.current
    const data   = dataRef.current
    if (!canvas || !data) return

    const dpr = window.devicePixelRatio || 1
    const W   = canvas.offsetWidth
    const H   = canvas.offsetHeight
    if (W <= 0 || H <= 0) return

    // Resize backing store to match physical pixels
    canvas.width  = W * dpr
    canvas.height = H * dpr
    const ctx = canvas.getContext('2d')
    ctx.scale(dpr, dpr)

    const t = THEME[themeRef.current] ?? THEME.light
    const { bricks, brick_size } = data
    const { offset, zoom }       = viewRef.current

    const start   = Math.max(0, Math.min(offset, bricks.length - 1))
    const count   = Math.min(zoom, bricks.length - start)
    const visible = bricks.slice(start, start + count)

    const plotW = W - PAD_RIGHT
    const plotH = H - PAD_TOP - PAD_BOT
    if (!visible.length || plotW <= 0 || plotH <= 0) return

    // Price range with padding
    const minP  = Math.min(...visible.map(b => b.low))
    const maxP  = Math.max(...visible.map(b => b.high))
    const pad   = brick_size * 1.5
    const lo    = minP - pad
    const hi    = maxP + pad
    const range = hi - lo

    const RIGHT_BRICK_PAD = 5
    const bW  = plotW / (zoom + RIGHT_BRICK_PAD)   // constant width regardless of how many bricks are visible
    const bH  = plotH * brick_size / range

    const toX = i => i * bW
    const toY = p => PAD_TOP + plotH * (1 - (p - lo) / range)

    // ── Background ────────────────────────────────────────────────────────────
    ctx.fillStyle = t.bg
    ctx.fillRect(0, 0, W, H)

    // ── Horizontal grid lines + price labels ──────────────────────────────────
    const tickCount = Math.max(2, Math.floor(plotH / 45))
    const step      = niceStep(range, tickCount)
    ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
    ctx.textAlign = 'left'

    let gridP = Math.ceil(lo / step) * step
    while (gridP <= hi) {
      const y = Math.round(toY(gridP)) + 0.5
      ctx.strokeStyle = t.grid
      ctx.lineWidth   = 1
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke()
      ctx.fillStyle   = t.label
      ctx.fillText(fmtPrice(gridP), plotW + 6, y + 3.5)
      // Avoid floating-point drift in the while condition
      gridP = Math.round((gridP + step) * 1e10) / 1e10
    }

    // ── Bricks ────────────────────────────────────────────────────────────────
    const hiIdx = hoverIdxRef.current
    visible.forEach((b, i) => {
      const globalIdx = start + i
      const x = Math.round(toX(i)) + 0.5
      const y = Math.round(toY(b.high)) + 0.5
      const w = Math.max(1, Math.round(bW) - 1)
      const h = Math.max(1, Math.round(bH) - 1)

      ctx.fillStyle = b.uptrend ? UP_COLOR : DOWN_COLOR
      ctx.fillRect(x, y, w, h)

      // Highlight border on hover
      if (globalIdx === hiIdx) {
        ctx.strokeStyle = themeRef.current === 'dark' ? '#ffffff' : '#000000'
        ctx.lineWidth   = 1.5
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
      }
    })

    // ── Axis separator ────────────────────────────────────────────────────────
    ctx.strokeStyle = t.axis
    ctx.lineWidth   = 1
    ctx.beginPath(); ctx.moveTo(plotW + 0.5, 0); ctx.lineTo(plotW + 0.5, H); ctx.stroke()

    // ── Date labels (bottom) ──────────────────────────────────────────────────
    ctx.fillStyle = t.label
    ctx.textAlign = 'center'
    const labelStep = Math.max(1, Math.floor(count / 7))
    for (let i = 0; i < count; i += labelStep) {
      const b = visible[i]
      if (!b) continue
      // Format: MM-DD-YYYY
      const [yyyy, mm, dd] = b.date.split('-')
      const label = `${mm}-${dd}-${yyyy}`
      ctx.fillText(label, toX(i) + bW / 2, H - 6)
    }

    // ── Crosshair ─────────────────────────────────────────────────────────────
    const hiIdx2  = hoverIdxRef.current
    const mousePos = mousePosRef.current
    if (hiIdx2 != null && mousePos) {
      const localI = hiIdx2 - start
      const cx     = Math.round(toX(localI) + bW / 2) + 0.5
      const my     = mousePos.y

      ctx.save()
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = t.label
      ctx.lineWidth   = 1
      ctx.globalAlpha = 0.6

      // Vertical line
      ctx.beginPath(); ctx.moveTo(cx, PAD_TOP); ctx.lineTo(cx, H - PAD_BOT); ctx.stroke()
      // Horizontal line
      ctx.beginPath(); ctx.moveTo(0, my); ctx.lineTo(plotW, my); ctx.stroke()

      ctx.restore()

      // Price label on right axis
      const hoverPrice = lo + range * (1 - (my - PAD_TOP) / plotH)
      const labelH     = 14
      const labelY     = Math.max(PAD_TOP + labelH / 2, Math.min(H - PAD_BOT - labelH / 2, my))
      ctx.fillStyle = themeRef.current === 'dark' ? '#4b5563' : '#e5e7eb'
      ctx.fillRect(plotW + 1, labelY - labelH / 2, PAD_RIGHT - 2, labelH)
      ctx.fillStyle = themeRef.current === 'dark' ? '#d1d5db' : '#1f2937'
      ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
      ctx.textAlign = 'left'
      ctx.fillText(fmtPrice(hoverPrice), plotW + 5, labelY + 3.5)
    }

    // ── Brick-size watermark ──────────────────────────────────────────────────
    ctx.fillStyle = t.dim
    ctx.textAlign = 'right'
    ctx.font      = `10px var(--font-mono, 'Courier New', monospace)`
    ctx.fillText(`brick ${fmtPrice(brick_size)}`, plotW - 4, H - 6)
  }

  // Always keep drawRef pointing to the latest draw closure (captures themeRef etc.)
  drawRef.current = draw

  // ── Fetch ───────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!symbol) return
    setStatus({ loading: true, error: null })
    dataRef.current   = null
    hoverIdxRef.current = null
    setHover(null)

    fetch(`/api/stocks/${symbol}/renko`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() })
      .then(d => {
        dataRef.current = d
        const n = d.bricks.length
        viewRef.current = { offset: Math.max(0, n - 80), zoom: Math.min(80, n) }
        setStatus({ loading: false, error: null })
        drawRef.current?.()
      })
      .catch(e => setStatus({ loading: false, error: e.message }))
  }, [symbol])

  // Redraw whenever theme changes
  useEffect(() => { drawRef.current?.() }, [theme])

  // ── ResizeObserver ──────────────────────────────────────────────────────────

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => drawRef.current?.())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // ── Event helpers ───────────────────────────────────────────────────────────

  function brickAtX(clientX) {
    const canvas = canvasRef.current
    const data   = dataRef.current
    if (!canvas || !data) return null
    const rect   = canvas.getBoundingClientRect()
    const x      = clientX - rect.left
    const { bricks } = data
    const { offset, zoom } = viewRef.current
    const count  = Math.min(zoom, bricks.length - offset)
    const plotW  = rect.width - PAD_RIGHT
    if (x < 0 || x > plotW || count === 0) return null
    const bW = plotW / (zoom + 5)   // must match draw()
    const i  = Math.floor(x / bW)
    return i >= 0 && i < count ? { localIdx: i, globalIdx: offset + i } : null
  }

  // ── Mouse wheel zoom ────────────────────────────────────────────────────────

  function handleWheel(e) {
    e.preventDefault()
    const data = dataRef.current
    if (!data) return
    const { offset, zoom } = viewRef.current
    const n       = data.bricks.length
    const factor  = e.deltaY > 0 ? 1.15 : 1 / 1.15
    const newZoom = Math.round(Math.max(5, Math.min(n, zoom * factor)))
    // Keep the rightmost visible brick pinned while zooming
    const newOffset = Math.max(0, Math.min(n - 1, offset + Math.round((zoom - newZoom) / 2)))
    viewRef.current = { offset: newOffset, zoom: newZoom }
    drawRef.current?.()
  }

  // ── Drag to pan ─────────────────────────────────────────────────────────────

  function handleMouseDown(e) {
    isDraggingRef.current = true
    dragStartRef.current  = { x: e.clientX, offset: viewRef.current.offset }
  }

  function handleMouseMove(e) {
    const data = dataRef.current
    if (!data) return

    // Pan while dragging
    if (isDraggingRef.current) {
      mousePosRef.current = null
      const canvas = canvasRef.current
      if (!canvas) return
      const rect    = canvas.getBoundingClientRect()
      const { bricks } = data
      const { zoom }   = viewRef.current
      const plotW   = rect.width - PAD_RIGHT
      const bW      = plotW / (zoom + 5)   // must match draw()
      const dx      = e.clientX - dragStartRef.current.x
      const dBricks = -Math.round(dx / bW)
      const newOffset = Math.max(
        0,
        Math.min(bricks.length - 1, dragStartRef.current.offset + dBricks),
      )
      if (newOffset !== viewRef.current.offset) {
        viewRef.current = { ...viewRef.current, offset: newOffset }
        drawRef.current?.()
      }
      return
    }

    // Hover highlight + crosshair
    const canvas = canvasRef.current
    const rect   = canvas ? canvas.getBoundingClientRect() : null
    const mouseY = rect ? e.clientY - rect.top : null

    const hit = brickAtX(e.clientX)
    if (!hit) {
      const changed = hoverIdxRef.current != null
      hoverIdxRef.current = null
      mousePosRef.current = null
      if (changed) { setHover(null); drawRef.current?.() }
      return
    }
    const { globalIdx } = hit
    const newPos = mouseY != null ? { x: e.clientX - (rect?.left ?? 0), y: mouseY } : mousePosRef.current
    const posChanged = !mousePosRef.current || mousePosRef.current.y !== newPos?.y
    mousePosRef.current = newPos
    if (hoverIdxRef.current !== globalIdx || posChanged) {
      hoverIdxRef.current = globalIdx
      setHover(data.bricks[globalIdx])
      drawRef.current?.()
    }
  }

  function handleMouseUp() {
    isDraggingRef.current = false
  }

  function handleMouseLeave() {
    isDraggingRef.current = false
    if (hoverIdxRef.current != null || mousePosRef.current != null) {
      hoverIdxRef.current = null
      mousePosRef.current = null
      setHover(null)
      drawRef.current?.()
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  const clr      = hover ? (hover.uptrend ? UP_COLOR : DOWN_COLOR) : 'var(--text-secondary)'
  const brickCnt = dataRef.current?.bricks.length

  return (
    <div
      ref={containerRef}
      style={{ position: 'absolute', inset: 0, overflow: 'hidden',
               cursor: isDraggingRef.current ? 'grabbing' : 'crosshair' }}
    >
      {/* ── OHLCV / info overlay ── */}
      <div style={{
        position: 'absolute', top: 8, left: 12, zIndex: 10,
        display: 'flex', alignItems: 'center', gap: '16px',
        fontSize: '12px', fontFamily: 'var(--font-mono)', pointerEvents: 'none',
      }}>
        {hover ? (
          <>
            {[['O', hover.open], ['H', hover.high], ['L', hover.low], ['C', hover.close]].map(([lbl, val]) => (
              <span key={lbl}>
                <span style={{ color: 'var(--text-muted)' }}>{lbl} </span>
                <span style={{ color: clr }}>{fmtPrice(val)}</span>
              </span>
            ))}
            <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{hover.date}</span>
            <span style={{
              padding: '1px 5px', borderRadius: '3px', fontSize: '10px',
              background: hover.uptrend ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)',
              color: clr,
            }}>
              {hover.uptrend ? '▲' : '▼'}
            </span>
          </>
        ) : brickCnt != null ? (
          <span style={{ color: 'var(--text-muted)', fontSize: '11px' }}>
            {brickCnt} bricks · scroll to zoom · drag to pan
          </span>
        ) : null}
      </div>

      {/* ── Loading ── */}
      {status.loading && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-secondary)', fontSize: '13px',
        }}>
          Loading Renko…
        </div>
      )}

      {/* ── Error ── */}
      {status.error && !status.loading && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            padding: '12px 20px', borderRadius: '8px',
            background: 'rgba(239,83,80,0.1)', border: '1px solid var(--red)',
            color: 'var(--red)', fontSize: '13px',
          }}>
            {status.error}
          </div>
        </div>
      )}

      {/* ── Canvas ── */}
      <canvas
        ref={canvasRef}
        style={{ display: 'block', width: '100%', height: '100%' }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
      />
    </div>
  )
}
