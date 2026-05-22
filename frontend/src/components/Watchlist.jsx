import { useRef, useState } from 'react'

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
          : hovered ? 'var(--bg-raised)' : 'transparent',
        cursor: 'pointer', transition: 'background 0.1s',
      }}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
          {symbol}
        </div>
        {name && name !== symbol && (
          <div style={{
            fontSize: '11px', color: 'var(--text-muted)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {name}
          </div>
        )}
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

// ── Icon helpers ──────────────────────────────────────────────────────────────

function IconUpload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
      <polyline points="17 8 12 3 7 8"/>
      <line x1="12" y1="3" x2="12" y2="15"/>
    </svg>
  )
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

export function Watchlist({
  width = 220,
  lists,
  activeListId,
  activeSymbol,
  loading = false,
  onSelectList,
  onCreateList,
  onImportList,  // async (name, symbols[], onProgress) → void
  onDeleteList,
  onSelectSymbol,
  onDeleteSymbol,
  onAddSymbol,   // async (listId, symbol) → { ok, error? }
}) {
  const [addInput,      setAddInput]      = useState('')
  const [addError,      setAddError]      = useState(null)
  const [adding,        setAdding]        = useState(false)
  const [creatingList,  setCreatingList]  = useState(false)
  const [listNameInput, setListNameInput] = useState('')

  // Import state
  const [importProgress, setImportProgress] = useState(null) // { done, total, failed } | null
  const fileInputRef = useRef(null)

  const activeList = lists.find(l => l.id === activeListId)

  // ── Add symbol ────────────────────────────────────────────────────────────

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

  // ── Create list ───────────────────────────────────────────────────────────

  const handleCreateList = (e) => {
    e.preventDefault()
    const name = listNameInput.trim()
    if (!name) return
    onCreateList(name)
    setListNameInput('')
    setCreatingList(false)
  }

  // ── Import from file ──────────────────────────────────────────────────────

  const handleFileChange = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Reset so selecting the same file again still fires onChange
    e.target.value = ''

    const text = await file.text()

    // Parse: one symbol per line; ignore blank lines and # comments
    const symbols = text
      .split('\n')
      .map(l => l.trim().toUpperCase())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('//'))

    if (!symbols.length) return

    // List name = file name without extension
    const listName = file.name.replace(/\.[^.]+$/, '')

    setImportProgress({ done: 0, total: symbols.length, failed: 0, err: null })

    try {
      await onImportList(listName, symbols, (done, total, failed) => {
        setImportProgress({ done, total, failed, err: null })
      })
    } catch (e) {
      setImportProgress(prev => ({ ...prev, err: e?.message ?? 'Import failed' }))
      setTimeout(() => setImportProgress(null), 4000)
      return
    }

    // Clear after a short pause so the user sees "done"
    setTimeout(() => setImportProgress(null), 2000)
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const importing = importProgress !== null

  return (
    <div style={{
      width: `${width}px`, flexShrink: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--bg-panel)',
      overflow: 'hidden',
    }}>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,text/plain"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {/* ── Header ── */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        {/* Dropdown row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: creatingList ? '8px' : 0 }}>
          <select
            value={activeListId ?? ''}
            onChange={e => onSelectList(e.target.value)}
            style={{
              flex: 1, height: '28px',
              background: 'var(--bg-raised)', border: '1px solid var(--border)',
              borderRadius: '4px', padding: '0 6px',
              color: 'var(--text-primary)', fontSize: '12px',
              cursor: 'pointer', outline: 'none',
            }}
          >
            {lists.map(list => (
              <option key={list.id} value={list.id}>{list.name}</option>
            ))}
          </select>

          {/* Delete active list */}
          {lists.length > 1 && (
            <button
              onClick={() => onDeleteList(activeListId)}
              title="Delete list"
              style={{
                background: 'none', border: 'none',
                color: 'var(--text-muted)', fontSize: '16px',
                cursor: 'pointer', padding: '0 3px', lineHeight: 1,
              }}
            >
              ×
            </button>
          )}

          {/* Import from file */}
          <button
            onClick={() => !importing && fileInputRef.current?.click()}
            title="Import list from .txt file"
            disabled={importing}
            style={{
              background: 'none', border: 'none',
              color: 'var(--text-muted)',
              cursor: importing ? 'not-allowed' : 'pointer',
              padding: '2px 3px', lineHeight: 1,
              display: 'flex', alignItems: 'center',
              opacity: importing ? 0.4 : 1,
            }}
          >
            <IconUpload />
          </button>

          {/* New list */}
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
          <form onSubmit={handleCreateList} style={{ display: 'flex', gap: '4px' }}>
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
      </div>

      {/* ── Symbol list ── */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {loading && (
          <div style={{ padding: '24px 12px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '12px' }}>
            Loading…
          </div>
        )}
        {!loading && activeList?.symbols.length === 0 && !importing && (
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

      {/* ── Import progress banner ── */}
      {importing && (
        <div style={{
          padding: '8px 12px',
          borderTop: '1px solid var(--border)',
          fontSize: '11px', color: 'var(--text-secondary)',
          display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0,
        }}>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          {importProgress.err ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="var(--red)" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
              <span style={{ color: 'var(--red)' }}>{importProgress.err}</span>
            </>
          ) : importProgress.done < importProgress.total ? (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="currentColor" strokeWidth="2.5"
                   style={{ animation: 'spin 0.9s linear infinite', flexShrink: 0 }}>
                <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round"/>
              </svg>
              Importing {importProgress.done} / {importProgress.total}…
            </>
          ) : (
            <>
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none"
                   stroke="var(--green)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              Done — {importProgress.total - importProgress.failed} added
              {importProgress.failed > 0 && (
                <span style={{ color: 'var(--red)' }}>· {importProgress.failed} failed</span>
              )}
            </>
          )}
        </div>
      )}

      {/* ── Add symbol input ── */}
      {!importing && (
        <div style={{ padding: '10px 12px', borderTop: '1px solid var(--border)', flexShrink: 0 }}>
          {addError && (
            <div style={{ fontSize: '11px', color: 'var(--red)', marginBottom: '6px', lineHeight: 1.4 }}>
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
      )}
    </div>
  )
}
