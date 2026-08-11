import { useEffect, useRef, useState } from 'react'

const PRESET_COLORS = ['#f59e0b', '#3b82f6', '#ec4899', '#10b981', '#8b5cf6', '#f97316']

const inputStyle = {
  height: '26px',
  background: 'var(--bg-raised)',
  border: '1px solid var(--border)',
  borderRadius: '4px',
  color: 'var(--text-primary)',
  fontSize: '12px',
  outline: 'none',
  padding: '0 6px',
}

const colorPickerStyle = {
  height: '26px', padding: '2px 3px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: '4px', cursor: 'pointer', flexShrink: 0,
}

const removeBtnStyle = {
  background: 'none', border: 'none', cursor: 'pointer',
  color: 'var(--text-muted)', fontSize: '16px', lineHeight: 1,
  padding: '0 2px', marginLeft: 'auto',
}

// ── Visibility toggle (eye) ─────────────────────────────────────────────────

function VisBtn({ hidden, onToggle }) {
  return (
    <button
      onClick={onToggle}
      title={hidden ? 'Show on chart' : 'Hide from chart'}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '0 1px', flexShrink: 0, display: 'flex', alignItems: 'center',
        color: hidden ? 'var(--text-muted)' : 'var(--text-secondary)',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z" />
        <circle cx="12" cy="12" r="3" />
        {hidden && <line x1="3" y1="3" x2="21" y2="21" />}
      </svg>
    </button>
  )
}

// ── Number input ──────────────────────────────────────────────────────────────

function NumInput({ value, onChange, width = '52px', title }) {
  return (
    <input
      type="number"
      value={value}
      min={1}
      max={999}
      title={title}
      onChange={e => onChange(Math.max(1, parseInt(e.target.value) || 1))}
      style={{ ...inputStyle, width }}
    />
  )
}

// ── MA row ────────────────────────────────────────────────────────────────────

function MARow({ ma, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: ma.hidden ? 0.45 : 1 }}>
      <VisBtn hidden={ma.hidden} onToggle={() => onUpdate({ hidden: !ma.hidden })} />
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px',
        background: ma.color, flexShrink: 0,
      }} />
      <NumInput value={ma.period} title="Period" onChange={v => onUpdate({ period: v })} />
      <input type="color" value={ma.color} title="Line color"
        onChange={e => onUpdate({ color: e.target.value })}
        style={{ ...colorPickerStyle, width: '28px' }} />
      <select
        value={ma.width}
        onChange={e => onUpdate({ width: parseInt(e.target.value) })}
        style={{ ...inputStyle, width: '76px', cursor: 'pointer' }}
      >
        <option value={1}>Thin</option>
        <option value={2}>Medium</option>
        <option value={3}>Thick</option>
      </select>
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── Guppy row ─────────────────────────────────────────────────────────────────

function GuppyRow({ guppy, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: guppy.hidden ? 0.45 : 1 }}>
      <VisBtn hidden={guppy.hidden} onToggle={() => onUpdate({ hidden: !guppy.hidden })} />
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px',
        background: `linear-gradient(to bottom, ${guppy.shortColor} 50%, ${guppy.longColor} 50%)`,
        flexShrink: 0,
      }} />
      <input type="color" value={guppy.shortColor} title="Short group color"
        onChange={e => onUpdate({ shortColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '28px' }} />
      <input type="color" value={guppy.longColor} title="Long group color"
        onChange={e => onUpdate({ longColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '28px' }} />
      <span style={{ fontSize: '10px', color: 'var(--text-muted)', flex: 1 }}>
        3–15 / 30–60
      </span>
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── RWB row ───────────────────────────────────────────────────────────────────

function RWBRow({ hidden, onToggle, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: hidden ? 0.45 : 1 }}>
      <VisBtn hidden={hidden} onToggle={onToggle} />
      {/* Mini colour preview: red / gray / green stripes */}
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0,
        background: 'linear-gradient(to bottom, #ef5350 33%, #787b86 33% 66%, #26a69a 66%)',
      }} />
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
        Fast 3–15 · Slow 30–60
      </span>
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── Squeeze row ───────────────────────────────────────────────────────────────

function SqueezeRow({ hidden, onToggle, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: hidden ? 0.45 : 1 }}>
      <VisBtn hidden={hidden} onToggle={onToggle} />
      {/* Mini colour preview: green/gray/red/orange squeeze states + aqua/blue mom */}
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0,
        background: 'linear-gradient(to right, #26a69a 25%, #434651 25% 50%, #ef5350 50% 75%, #ff9800 75%)',
      }} />
      <span style={{ fontSize: '11px', color: 'var(--text-muted)', flex: 1 }}>
        BB / KC · length 20
      </span>
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── Screen row ────────────────────────────────────────────────────────────────

const SCREEN_COLORS = ['#2962ff', '#f59e0b', '#ab47bc', '#26a69a']

function ScreenRow({ cfg, colorIdx, screeners, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: cfg.hidden ? 0.45 : 1 }}>
      <VisBtn hidden={cfg.hidden} onToggle={() => onUpdate({ hidden: !cfg.hidden })} />
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px', flexShrink: 0,
        background: SCREEN_COLORS[colorIdx % SCREEN_COLORS.length],
      }} />
      <select
        value={cfg.configId ?? ''}
        onChange={e => onUpdate({ configId: Number(e.target.value) })}
        style={{ ...inputStyle, flex: 1, cursor: 'pointer' }}
      >
        {cfg.configId == null && <option value="">— pick screener —</option>}
        {screeners.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── MACD row ──────────────────────────────────────────────────────────────────

function MACDRow({ macd, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: macd.hidden ? 0.45 : 1 }}>
      <VisBtn hidden={macd.hidden} onToggle={() => onUpdate({ hidden: !macd.hidden })} />
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px',
        background: macd.macdColor, flexShrink: 0,
      }} />
      <NumInput value={macd.fast}   title="Fast period"   width="42px" onChange={v => onUpdate({ fast: v })} />
      <NumInput value={macd.slow}   title="Slow period"   width="42px" onChange={v => onUpdate({ slow: v })} />
      <NumInput value={macd.signal} title="Signal period" width="42px" onChange={v => onUpdate({ signal: v })} />
      <input type="color" value={macd.macdColor} title="MACD line color"
        onChange={e => onUpdate({ macdColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '24px' }} />
      <input type="color" value={macd.signalColor} title="Signal line color"
        onChange={e => onUpdate({ signalColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '24px' }} />
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── Stochastic RSI row ────────────────────────────────────────────────────────

function StochRSIRow({ sr, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px', opacity: sr.hidden ? 0.45 : 1 }}>
      <VisBtn hidden={sr.hidden} onToggle={() => onUpdate({ hidden: !sr.hidden })} />
      <div style={{
        width: '10px', height: '10px', borderRadius: '2px',
        background: `linear-gradient(to bottom, ${sr.kColor} 50%, ${sr.dColor} 50%)`, flexShrink: 0,
      }} />
      <NumInput value={sr.rsi}   title="RSI period"       width="38px" onChange={v => onUpdate({ rsi: v })} />
      <NumInput value={sr.stoch} title="Stochastic period" width="38px" onChange={v => onUpdate({ stoch: v })} />
      <NumInput value={sr.k}     title="%K smoothing"      width="38px" onChange={v => onUpdate({ k: v })} />
      <NumInput value={sr.d}     title="%D smoothing"      width="38px" onChange={v => onUpdate({ d: v })} />
      <input type="color" value={sr.kColor} title="%K line color"
        onChange={e => onUpdate({ kColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '24px' }} />
      <input type="color" value={sr.dColor} title="%D line color"
        onChange={e => onUpdate({ dColor: e.target.value })}
        style={{ ...colorPickerStyle, width: '24px' }} />
      <button onClick={onRemove} title="Remove" style={removeBtnStyle}>×</button>
    </div>
  )
}

// ── Indicator type section ────────────────────────────────────────────────────

function IndicatorSection({ label, count, addLabel, onAdd, colHeaders, colHeaderIndent = '36px', children }) {
  return (
    <div>
      {/* Section header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: count > 0 ? '6px' : '8px',
      }}>
        <span style={{
          fontSize: '10px', fontWeight: 700, color: 'var(--text-secondary)',
          textTransform: 'uppercase', letterSpacing: '0.06em',
        }}>
          {label}
        </span>
        {count > 0 && (
          <span style={{
            fontSize: '10px', color: 'var(--text-muted)',
            background: 'var(--bg-raised)', borderRadius: '10px', padding: '1px 6px',
          }}>
            {count}
          </span>
        )}
      </div>

      {/* Column headers */}
      {count > 0 && colHeaders && (
        <div style={{
          display: 'flex', gap: '6px', marginBottom: '4px',
          fontSize: '10px', color: 'var(--text-muted)',
          paddingLeft: colHeaderIndent,
        }}>
          {colHeaders.map(({ label: h, width: w }) => (
            <span key={h} style={{ width: w, flexShrink: 0 }}>{h}</span>
          ))}
        </div>
      )}

      {children}

      {/* Add button */}
      <button
        onClick={onAdd}
        style={{
          marginTop: count ? '4px' : 0,
          width: '100%', height: '26px',
          background: 'transparent', border: '1px dashed var(--border)',
          borderRadius: '5px', color: 'var(--text-muted)',
          fontSize: '11px', cursor: 'pointer', transition: 'all 0.15s',
        }}
      >
        + {addLabel}
      </button>
    </div>
  )
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export function IndicatorPanel({ maConfigs, onMaChange, macdConfigs, onMacdChange, stochrsiConfigs = [], onStochrsiChange, guppyConfigs, onGuppyChange, rwbConfigs, onRwbChange, squeezeConfigs, onSqueezeChange, screenIndConfigs = [], onScreenIndChange, screenerConfigs = [] }) {
  const [open, setOpen] = useState(false)
  const panelRef        = useRef(null)
  const btnRef          = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = e => {
      if (!panelRef.current?.contains(e.target) && !btnRef.current?.contains(e.target))
        setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // MA handlers
  const addMA    = () => {
    const color = PRESET_COLORS[maConfigs.length % PRESET_COLORS.length]
    onMaChange([...maConfigs, { id: Date.now().toString(), period: 20, color, width: 1 }])
  }
  const removeMA  = id     => onMaChange(maConfigs.filter(m => m.id !== id))
  const updateMA  = (id, up) => onMaChange(maConfigs.map(m => m.id === id ? { ...m, ...up } : m))

  // StochRSI handlers
  const addStochRSI    = () => onStochrsiChange([
    ...stochrsiConfigs,
    { id: Date.now().toString(), rsi: 14, stoch: 14, k: 3, d: 3,
      kColor: '#2962ff', dColor: '#ff6d00' },
  ])
  const removeStochRSI  = id     => onStochrsiChange(stochrsiConfigs.filter(s => s.id !== id))
  const updateStochRSI  = (id, up) => onStochrsiChange(stochrsiConfigs.map(s => s.id === id ? { ...s, ...up } : s))

  // Guppy handlers
  const addGuppy    = () => onGuppyChange([
    ...guppyConfigs,
    { id: Date.now().toString(), shortColor: '#ef5350', longColor: '#2962ff' },
  ])
  const removeGuppy = id     => onGuppyChange(guppyConfigs.filter(g => g.id !== id))
  const updateGuppy = (id, up) => onGuppyChange(guppyConfigs.map(g => g.id === id ? { ...g, ...up } : g))

  // Squeeze handlers
  const addSqueeze    = () => {
    if (squeezeConfigs.length > 0) return   // only one squeeze makes sense
    onSqueezeChange([...squeezeConfigs, { id: Date.now().toString() }])
  }
  const removeSqueeze = id => onSqueezeChange(squeezeConfigs.filter(s => s.id !== id))
  const toggleSqueeze = id => onSqueezeChange(squeezeConfigs.map(s => s.id === id ? { ...s, hidden: !s.hidden } : s))

  // RWB handlers
  const addRWB    = () => {
    if (rwbConfigs.length > 0) return   // only one RWB makes sense
    onRwbChange([...rwbConfigs, { id: Date.now().toString() }])
  }
  const removeRWB = id => onRwbChange(rwbConfigs.filter(r => r.id !== id))
  const toggleRWB = id => onRwbChange(rwbConfigs.map(r => r.id === id ? { ...r, hidden: !r.hidden } : r))

  // MACD handlers
  const addMACD  = () => onMacdChange([
    ...macdConfigs,
    { id: Date.now().toString(), fast: 12, slow: 26, signal: 9,
      macdColor: '#2962ff', signalColor: '#ff6d00' },
  ])
  const removeMACD  = id     => onMacdChange(macdConfigs.filter(m => m.id !== id))
  const updateMACD  = (id, up) => onMacdChange(macdConfigs.map(m => m.id === id ? { ...m, ...up } : m))

  // Screen handlers
  const addScreen    = () => onScreenIndChange([
    ...screenIndConfigs,
    { id: Date.now().toString(), configId: screenerConfigs[0]?.id ?? null },
  ])
  const removeScreen = id       => onScreenIndChange(screenIndConfigs.filter(s => s.id !== id))
  const updateScreen = (id, up) => onScreenIndChange(screenIndConfigs.map(s => s.id === id ? { ...s, ...up } : s))

  const totalCount = maConfigs.length + macdConfigs.length + stochrsiConfigs.length + guppyConfigs.length + rwbConfigs.length + squeezeConfigs.length + screenIndConfigs.length
  const btnLabel   = totalCount > 0 ? `Indicators (${totalCount})` : 'Indicators'

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={btnRef}
        onClick={() => setOpen(v => !v)}
        style={{
          height: '28px', padding: '0 10px', border: 'none',
          borderRadius: '5px', fontSize: '11px', fontWeight: 500,
          background: open || totalCount > 0 ? 'var(--bg-raised)' : 'transparent',
          color: open || totalCount > 0 ? 'var(--text-primary)' : 'var(--text-secondary)',
          cursor: 'pointer', transition: 'all 0.15s',
        }}
      >
        {btnLabel}
      </button>

      {open && (
        <div
          ref={panelRef}
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
            background: 'var(--bg-panel)', border: '1px solid var(--border)',
            borderRadius: '8px', padding: '12px 14px', minWidth: '290px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          {/* Panel title */}
          <div style={{
            fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)',
            marginBottom: '12px', paddingBottom: '8px',
            borderBottom: '1px solid var(--border)',
          }}>
            Indicators
          </div>

          {/* ── Moving Average ── */}
          <IndicatorSection
            label="Moving Average"
            count={maConfigs.length}
            addLabel="Add MA"
            onAdd={addMA}
            colHeaders={[
              { label: 'Period', width: '52px' },
              { label: 'Color',  width: '28px' },
              { label: 'Width',  width: '76px' },
            ]}
          >
            {maConfigs.map(ma => (
              <MARow key={ma.id} ma={ma}
                onUpdate={up => updateMA(ma.id, up)}
                onRemove={() => removeMA(ma.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── Guppy MMA ── */}
          <IndicatorSection
            label="Guppy MMA"
            count={guppyConfigs.length}
            addLabel="Add Guppy"
            onAdd={addGuppy}
            colHeaders={guppyConfigs.length > 0 ? [
              { label: 'Short', width: '28px' },
              { label: 'Long',  width: '28px' },
            ] : null}
            colHeaderIndent="36px"
          >
            {guppyConfigs.map(g => (
              <GuppyRow key={g.id} guppy={g}
                onUpdate={up => updateGuppy(g.id, up)}
                onRemove={() => removeGuppy(g.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── MACD ── */}
          <IndicatorSection
            label="MACD"
            count={macdConfigs.length}
            addLabel="Add MACD"
            onAdd={addMACD}
            colHeaders={[
              { label: 'Fast',   width: '42px' },
              { label: 'Slow',   width: '42px' },
              { label: 'Signal', width: '42px' },
              { label: 'Colors', width: '54px' },
            ]}
          >
            {macdConfigs.map(macd => (
              <MACDRow key={macd.id} macd={macd}
                onUpdate={up => updateMACD(macd.id, up)}
                onRemove={() => removeMACD(macd.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── Stochastic RSI ── */}
          <IndicatorSection
            label="Stochastic RSI"
            count={stochrsiConfigs.length}
            addLabel="Add StochRSI"
            onAdd={addStochRSI}
            colHeaders={[
              { label: 'RSI',    width: '38px' },
              { label: 'Stoch',  width: '38px' },
              { label: '%K',     width: '38px' },
              { label: '%D',     width: '38px' },
              { label: 'Colors', width: '54px' },
            ]}
            colHeaderIndent="36px"
          >
            {stochrsiConfigs.map(sr => (
              <StochRSIRow key={sr.id} sr={sr}
                onUpdate={up => updateStochRSI(sr.id, up)}
                onRemove={() => removeStochRSI(sr.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── Squeeze ── */}
          <IndicatorSection
            label="Squeeze"
            count={squeezeConfigs.length}
            addLabel="Add Squeeze"
            onAdd={addSqueeze}
          >
            {squeezeConfigs.map(s => (
              <SqueezeRow key={s.id} hidden={s.hidden}
                onToggle={() => toggleSqueeze(s.id)}
                onRemove={() => removeSqueeze(s.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── RWB ── */}
          <IndicatorSection
            label="RWB"
            count={rwbConfigs.length}
            addLabel="Add RWB"
            onAdd={addRWB}
          >
            {rwbConfigs.map(r => (
              <RWBRow key={r.id} hidden={r.hidden}
                onToggle={() => toggleRWB(r.id)}
                onRemove={() => removeRWB(r.id)} />
            ))}
          </IndicatorSection>

          {/* ── Divider ── */}
          <div style={{ borderTop: '1px solid var(--border)', margin: '10px 0' }} />

          {/* ── Screen ── */}
          <IndicatorSection
            label="Screen"
            count={screenIndConfigs.length}
            addLabel="Add Screen"
            onAdd={addScreen}
          >
            {screenIndConfigs.map((s, i) => (
              <ScreenRow key={s.id} cfg={s} colorIdx={i}
                screeners={screenerConfigs}
                onUpdate={up => updateScreen(s.id, up)}
                onRemove={() => removeScreen(s.id)} />
            ))}
          </IndicatorSection>
        </div>
      )}
    </div>
  )
}
