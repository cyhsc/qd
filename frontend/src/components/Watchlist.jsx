import { useState } from 'react'

// ── SymbolRow ─────────────────────────────────────────────────────────────────

function SymbolRow({ symbol, name, active, onClick, onDelete }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center',
        padding: '7px 10px 7px 12px',
        borderLeft: `2px solid ${active ? 'var(--blue)' : 'transparent'}`,
        background: active
          ? 'rgba(41,98,255,0.08)'
          : hovered ? 'rgba(255,255,255,0.03)' : 'transparent',
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {symbol}
        </div>
        <div style={{
          fontSize: '11px', color: 'var(--text-muted)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {name}
        </div>
      </div>
      {(hovered || active) && (
        <button
          onClick={e => { e.stopPropagation(); onDelete() }}
          style={{
            background: 'none', border: 'none', flexShrink: 0,
            color: 'var(--text-muted)', fontSize: '14px',
            cursor: 'pointer', padding: '0 2px', lineHeight: 1,
          }}
        >
          ×
        </button>
      )}
    </div>
  )
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export function Watchlist({
  lists,
  activeListId,
  activeSymbol,
  loading = false,
  onSelectList,
  onCreateList,
  onDeleteList,
  onSelectSymbol,
  onDeleteSymbol,
  onAddSymbol,       // async (listId, symbol) → { ok, error? }
}) {
  const [addInput,       setAddInput]       = useState('')
  const [addError,       setAddError]       = useState(null)
  const [adding,         setAdding]         = useState(false)
  const [creatingList,   setCreatingList]   = useState(false)
  const [listNameInput,  setListNameInput]  = useState('')

  const activeList = lists.find(l => l.id === activeListId)

  // ── add symbol ──
  const handleAdd = async (e) => {
    e.preventDefault()
    const sym = addInput.trim().toUpperCase()
    if (!sym) return
    setAdding(true)
    setAddError(null)
    const result = await onAddSymbol(activeListId, sym)
    setAdding(false)
    if (result.ok) {
      setAddInput('')
    } else {
      setAddError(result.error)
    }
  }

  // ── create list ──
  const handleCreateList = (e) => {
    e.preventDefault()
    const name = listNameInput.trim()
    if (!name) return
    onCreateList(name)
    setListNameInput('')
    setCreatingList(false)
  }

  return (
    <div style={{
      width: '220px', flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)',
      borderRight: '1px solid var(--border)',
      overflow: 'hidden',
    }}>

      {/* ── List tabs header ── */}
      <div style={{ padding: '10px 12px 0', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <span style={{
            fontSize: '10px', color: 'var(--text-muted)',
            textTransform: 'uppercase', letterSpacing: '0.08em', fontWeight: 600,
          }}>
            Watchlists
          </span>
          <button
            onClick={() => { setCreatingList(v => !v); setListNameInput('') }}
            title="New list"
            style={{
              background: 'none', border: 'none',
              color: creatingList ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: '18px', lineHeight: 1, cursor: 'pointer', padding: '0 2px',
            }}
          >
            +
          </button>
        </div>

        {/* New list name input */}
        {creatingList && (
          <form onSubmit={handleCreateList} style={{ marginBottom: '8px', display: 'flex', gap: '4px' }}>
            <input
              autoFocus
              value={listNameInput}
              onChange={e => setListNameInput(e.target.value)}
              placeholder="List name…"
              onKeyDown={e => e.key === 'Escape' && setCreatingList(false)}
              style={{
                flex: 1, height: '26px',
                background: 'var(--bg-raised)', border: '1px solid var(--border)',
                borderRadius: '4px', padding: '0 6px',
                color: 'var(--text-primary)', fontSize: '12px', outline: 'none',
              }}
            />
            <button type="submit" style={{
              height: '26px', padding: '0 8px',
              background: 'var(--blue)', border: 'none',
              borderRadius: '4px', color: '#fff', fontSize: '11px', cursor: 'pointer',
            }}>
              OK
            </button>
          </form>
        )}

        {/* Tab row */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', paddingBottom: '8px' }}>
          {lists.map(list => (
            <div key={list.id} style={{ display: 'flex', alignItems: 'center', gap: '1px' }}>
              <button
                onClick={() => onSelectList(list.id)}
                style={{
                  height: '22px', padding: '0 8px',
                  border: 'none', borderRadius: '4px',
                  fontSize: '11px', fontWeight: 500, cursor: 'pointer',
                  background: list.id === activeListId ? 'var(--bg-raised)' : 'transparent',
                  color: list.id === activeListId ? 'var(--text-primary)' : 'var(--text-muted)',
                }}
              >
                {list.name}
              </button>
              {lists.length > 1 && (
                <button
                  onClick={() => onDeleteList(list.id)}
                  title="Delete list"
                  style={{
                    background: 'none', border: 'none',
                    color: 'var(--text-muted)', fontSize: '12px',
                    cursor: 'pointer', padding: '0 1px', lineHeight: 1,
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* ── Symbol list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            Loading…
          </div>
        )}
        {!loading && activeList?.symbols.length === 0 && (
          <div style={{
            padding: '24px 12px', textAlign: 'center',
            color: 'var(--text-muted)', fontSize: '12px',
          }}>
            Add symbols below
          </div>
        )}
        {!loading && activeList?.symbols.map(({ symbol, name }) => (
          <SymbolRow
            key={symbol}
            symbol={symbol}
            name={name}
            active={symbol === activeSymbol}
            onClick={() => onSelectSymbol(symbol)}
            onDelete={() => onDeleteSymbol(activeListId, symbol)}
          />
        ))}
      </div>

      {/* ── Add symbol input ── */}
      <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
        {addError && (
          <div style={{
            fontSize: '11px', color: 'var(--red)',
            marginBottom: '6px', lineHeight: 1.4,
          }}>
            {addError}
          </div>
        )}
        <form onSubmit={handleAdd} style={{ display: 'flex', gap: '4px' }}>
          <input
            value={addInput}
            onChange={e => { setAddInput(e.target.value); setAddError(null) }}
            placeholder="Add symbol…"
            disabled={adding}
            style={{
              flex: 1, height: '28px',
              background: 'var(--bg-raised)',
              border: `1px solid ${addError ? 'var(--red)' : 'var(--border)'}`,
              borderRadius: '4px', padding: '0 8px',
              color: 'var(--text-primary)', fontSize: '12px', outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={adding || !addInput.trim()}
            style={{
              height: '28px', padding: '0 10px',
              background: 'var(--blue)', border: 'none',
              borderRadius: '4px', color: '#fff',
              fontSize: '13px', fontWeight: 600,
              cursor: (adding || !addInput.trim()) ? 'not-allowed' : 'pointer',
              opacity: (adding || !addInput.trim()) ? 0.5 : 1,
            }}
          >
            {adding ? '…' : '+'}
          </button>
        </form>
      </div>
    </div>
  )
}
