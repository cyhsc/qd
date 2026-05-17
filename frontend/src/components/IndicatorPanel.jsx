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
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
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

// ── MACD row ──────────────────────────────────────────────────────────────────

function MACDRow({ macd, onUpdate, onRemove }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
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

// ── Indicator type section ────────────────────────────────────────────────────

function IndicatorSection({ label, count, addLabel, onAdd, colHeaders, colHeaderIndent = '16px', children }) {
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

export function IndicatorPanel({ maConfigs, onMaChange, macdConfigs, onMacdChange }) {
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

  // MACD handlers
  const addMACD  = () => onMacdChange([
    ...macdConfigs,
    { id: Date.now().toString(), fast: 12, slow: 26, signal: 9,
      macdColor: '#2962ff', signalColor: '#ff6d00' },
  ])
  const removeMACD  = id     => onMacdChange(macdConfigs.filter(m => m.id !== id))
  const updateMACD  = (id, up) => onMacdChange(macdConfigs.map(m => m.id === id ? { ...m, ...up } : m))

  const totalCount = maConfigs.length + macdConfigs.length
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
        </div>
      )}
    </div>
  )
}
