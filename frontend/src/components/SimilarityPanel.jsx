import { useCallback, useEffect, useState } from 'react'

// Example-based (similarity) screening: curate exemplar bars (points) or ranges
// (patterns) into a named collection, then rank a universe by distance to the
// nearest exemplar. Points use standardized Euclidean on the latest bar; ranges
// use sequence distance (DTW or resample-Euclidean) over a candidate window.

const API = '/api/samples'

export function SimilarityPanel({ watchlists = [], active, onOpenChart, pendingRange, onConsumeRange }) {
  const [collections, setCollections] = useState([])
  const [collection,  setCollection]  = useState('')
  const [samples,     setSamples]     = useState([])
  const [creatingNew, setCreatingNew] = useState(false)
  const [newName,     setNewName]     = useState('')
  const [confirmDel,  setConfirmDel]  = useState(false)

  const [sampleKind, setSampleKind] = useState('point')   // 'point' | 'range'
  const [addSymbol, setAddSymbol] = useState('')
  const [addStart,  setAddStart]  = useState('')
  const [addDate,   setAddDate]   = useState('')
  const [msg,       setMsg]       = useState(null)

  const [universe,  setUniverse]  = useState('')
  const [metric,    setMetric]    = useState('dtw')
  const [scope,     setScope]     = useState('latest')
  const [threshold, setThreshold] = useState('0.9')
  const [topN,      setTopN]      = useState('50')
  const [results,   setResults]   = useState(null)
  const [meta,      setMeta]      = useState(null)
  const [screening, setScreening] = useState(false)

  useEffect(() => {
    if (!universe && watchlists.length) {
      const sp = watchlists.find(w => w.name === 'S&P 500')
      setUniverse(sp ? sp.name : watchlists[0].name)
    }
  }, [watchlists, universe])

  // A range dragged in from the chart pre-fills the add form.
  useEffect(() => {
    if (pendingRange) {
      setSampleKind('range')
      setAddSymbol(pendingRange.symbol || '')
      setAddStart(pendingRange.start || '')
      setAddDate(pendingRange.end || '')
      onConsumeRange?.()
    }
  }, [pendingRange, onConsumeRange])

  const loadCollections = useCallback(() => {
    fetch(`${API}/collections`).then(r => r.json()).then(list => {
      setCollections(list ?? [])
      setCollection(prev => prev || (list?.[0]?.collection ?? ''))
    }).catch(() => {})
  }, [])

  const loadSamples = useCallback((name) => {
    if (!name) { setSamples([]); return }
    fetch(`${API}/${encodeURIComponent(name)}`).then(r => r.json())
      .then(d => setSamples(d.samples ?? [])).catch(() => setSamples([]))
  }, [])

  useEffect(() => { if (active) loadCollections() }, [active, loadCollections])
  useEffect(() => { loadSamples(collection) }, [collection, loadSamples])

  const isRange = sampleKind === 'range'

  const addSample = async () => {
    const name = collection.trim(); const sym = addSymbol.trim().toUpperCase()
    if (!name || !sym) { setMsg({ err: true, text: 'Collection and symbol are required.' }); return }
    if (isRange && (!addStart.trim() || !addDate.trim())) { setMsg({ err: true, text: 'Range needs both a start and end date.' }); return }
    if (!isRange && !addDate.trim()) { setMsg({ err: true, text: 'Point needs a date.' }); return }
    const body = isRange ? { symbol: sym, start: addStart, end: addDate } : { symbol: sym, date: addDate }
    try {
      const res = await fetch(`${API}/${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail || `HTTP ${res.status}`) }
      const d = await res.json()
      setMsg({ err: false, text: d.kind === 'range' ? `Added range ${d.symbol} ${d.start}→${d.end} (${d.length} bars)` : `Added point ${d.symbol} @ ${d.date}` })
      setAddSymbol(''); setAddStart('')
      loadSamples(name); loadCollections()
    } catch (e) { setMsg({ err: true, text: e.message }) }
  }

  const removeSample = async (sym, date) => {
    await fetch(`${API}/${encodeURIComponent(collection)}/${encodeURIComponent(sym)}/${encodeURIComponent(date)}`,
      { method: 'DELETE' }).catch(() => {})
    loadSamples(collection); loadCollections()
  }

  const runScreen = async () => {
    if (!collection || !samples.length) { setMsg({ err: true, text: 'Add at least one sample first.' }); return }
    setScreening(true); setResults(null); setMeta(null)
    try {
      const params = new URLSearchParams({ universe, top: topN || '50', metric, scope })
      if (threshold.trim() !== '') params.set('threshold', threshold)
      const res = await fetch(`${API}/${encodeURIComponent(collection)}/screen?${params}`)
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail || `HTTP ${res.status}`) }
      const d = await res.json()
      setResults(d.results ?? [])
      setMeta(d.meta ?? null)
    } catch (e) { setMsg({ err: true, text: e.message }) }
    finally { setScreening(false) }
  }

  const createCollection = () => {
    const nm = newName.trim()
    if (!nm) return
    setCollection(nm)          // becomes active; persists once its first sample is added
    setSamples([])
    setResults(null); setMeta(null)
    setCreatingNew(false); setNewName('')
    setMsg({ err: false, text: `New collection "${nm}" — add a sample to save it.` })
  }

  const deleteCollection = async () => {
    const name = collection
    await fetch(`${API}/${encodeURIComponent(name)}`, { method: 'DELETE' }).catch(() => {})
    setConfirmDel(false)
    const list = await fetch(`${API}/collections`).then(r => r.json()).catch(() => [])
    setCollections(list ?? [])
    setCollection((list && list[0]?.collection) || '')
    setSamples([]); setResults(null); setMeta(null)
    setMsg({ err: false, text: `Deleted collection "${name}"` })
  }

  // Dropdown options: saved collections + the current one if it's a fresh, unsaved name.
  const names = collections.map(c => c.collection)
  const options = collection && !names.includes(collection) ? [...names, collection] : names
  const labelFor = (name) => {
    const c = collections.find(x => x.collection === name)
    return c ? `${name} (${c.n})` : `${name} (new)`
  }

  const thr = threshold.trim() === '' ? null : parseFloat(threshold)

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* ── Left: collection management ── */}
      <div style={{ width: '340px', flexShrink: 0, borderRight: '1px solid var(--border)',
                    display: 'flex', flexDirection: 'column', overflow: 'auto', padding: '16px' }}>
        <Label>Collection</Label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: (creatingNew || confirmDel) ? '6px' : '16px' }}>
          <select value={collection} onChange={e => { setCollection(e.target.value); setConfirmDel(false) }} style={{ ...inp, flex: 1 }}>
            {options.length === 0 && <option value="">(no collections yet)</option>}
            {options.map(name => <option key={name} value={name}>{labelFor(name)}</option>)}
          </select>
          <button onClick={() => { setCreatingNew(true); setConfirmDel(false); setNewName('') }} style={btnGhost} title="Create a new collection">+ New</button>
          {names.includes(collection) && (
            <button onClick={() => { setConfirmDel(true); setCreatingNew(false) }} style={btnGhost} title="Delete this collection">🗑</button>
          )}
        </div>
        {confirmDel && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '16px',
                        fontSize: '12px', color: 'var(--text-secondary)' }}>
            <span>Delete <b>{collection}</b>?</span>
            <button onClick={deleteCollection} style={{ ...btnPrimary, background: 'var(--red)' }}>Delete</button>
            <button onClick={() => setConfirmDel(false)} style={btnGhost}>Cancel</button>
          </div>
        )}
        {creatingNew && (
          <div style={{ display: 'flex', gap: '6px', marginBottom: '16px' }}>
            <input autoFocus value={newName} onChange={e => setNewName(e.target.value)}
                   placeholder="New collection name"
                   onKeyDown={e => { if (e.key === 'Enter') createCollection(); if (e.key === 'Escape') setCreatingNew(false) }}
                   style={{ ...inp, flex: 1 }} />
            <button onClick={createCollection} style={btnPrimary}>Create</button>
            <button onClick={() => setCreatingNew(false)} style={btnGhost}>Cancel</button>
          </div>
        )}

        <Label>Add sample</Label>
        <div style={{ display: 'flex', marginBottom: '6px' }}>
          <button onClick={() => setSampleKind('point')}
                  style={{ ...toggleBtn, ...(sampleKind === 'point' ? toggleOn : {}), borderRadius: '5px 0 0 5px' }}>Point</button>
          <button onClick={() => setSampleKind('range')}
                  style={{ ...toggleBtn, ...(sampleKind === 'range' ? toggleOn : {}), borderRadius: '0 5px 5px 0', borderLeft: 'none' }}>Range</button>
        </div>
        <input value={addSymbol} onChange={e => setAddSymbol(e.target.value)}
               placeholder="Symbol" style={{ ...inp, marginBottom: '6px' }} />
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          {isRange && (
            <div style={{ flex: 1 }}>
              <div style={miniLabel}>Start</div>
              <input type="date" value={addStart} onChange={e => setAddStart(e.target.value)} style={{ ...inp, width: '100%' }} />
            </div>
          )}
          <div style={{ flex: 1 }}>
            <div style={miniLabel}>{isRange ? 'End' : 'Date'}</div>
            <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)} style={{ ...inp, width: '100%' }} />
          </div>
        </div>
        <button onClick={addSample} style={btnPrimary}>Add to {collection || '…'}</button>
        <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '4px' }}>
          Tip: drag-select a range on the Chart to fill a pattern automatically.
        </div>
        {msg && <div style={{ fontSize: '11px', marginTop: '8px', color: msg.err ? 'var(--red)' : 'var(--green)' }}>{msg.text}</div>}

        <Label style={{ marginTop: '20px' }}>Samples ({samples.length})</Label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {samples.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No samples yet.</div>}
          {samples.map(s => (
            <div key={`${s.symbol}-${s.date}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                 padding: '5px 8px', borderRadius: '5px', background: 'var(--bg-raised)', fontSize: '12px' }}>
              <span>
                <b style={{ cursor: 'pointer' }} onClick={() => onOpenChart?.(s.symbol)}>{s.symbol}</b>{' '}
                {s.kind === 'range'
                  ? <span style={{ color: 'var(--text-muted)' }}>{s.start}→{s.end} <span style={{ opacity: 0.7 }}>({s.length})</span></span>
                  : <span style={{ color: 'var(--text-muted)' }}>{s.date}</span>}
              </span>
              <span onClick={() => removeSample(s.symbol, s.date)}
                    style={{ cursor: 'pointer', color: 'var(--text-muted)', fontSize: '14px' }}>×</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Right: screen ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px', padding: '16px 20px',
                      borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap' }}>
          <div><Label>Universe</Label>
            <select value={universe} onChange={e => setUniverse(e.target.value)} style={{ ...inp, minWidth: '170px' }}>
              {watchlists.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
            </select>
          </div>
          <div><Label>Metric</Label>
            <select value={metric} onChange={e => setMetric(e.target.value)} style={inp}>
              <option value="dtw">DTW</option>
              <option value="euclidean">Euclidean</option>
            </select>
          </div>
          <div><Label>Scope</Label>
            <select value={scope} onChange={e => setScope(e.target.value)} style={inp}>
              <option value="latest">Latest window</option>
              <option value="history">Scan history</option>
            </select>
          </div>
          <div><Label>Max distance</Label>
            <input value={threshold} onChange={e => setThreshold(e.target.value)} placeholder="(none)" style={{ ...inp, width: '80px' }} />
          </div>
          <div><Label>Top N</Label>
            <input value={topN} onChange={e => setTopN(e.target.value)} style={{ ...inp, width: '64px' }} />
          </div>
          <button onClick={runScreen} disabled={screening} style={{ ...btnPrimary, opacity: screening ? 0.5 : 1 }}>
            {screening ? 'Screening…' : 'Run similarity screen'}
          </button>
          {meta && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {meta.points}pt / {meta.ranges} range · {meta.metric}/{meta.scope} · per-feature std units
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 24px' }}>
          {results == null ? (
            <Center>Curate a collection, then run the screen to rank the universe by similarity.</Center>
          ) : results.length === 0 ? (
            <Center>No results.</Center>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: '680px', marginTop: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  {['Symbol', 'Matched bar', 'Distance', 'Nearest exemplar'].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 2 ? 'right' : 'left', padding: '6px 14px 10px',
                                         fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map(r => {
                  const under = thr != null && r.distance < thr
                  return (
                    <tr key={r.symbol} style={{ borderBottom: '1px solid var(--border)',
                                                background: under ? 'rgba(38,166,154,0.07)' : 'transparent' }}>
                      <td style={{ padding: '7px 14px', fontSize: '13px', fontWeight: 600 }}>
                        <span style={{ cursor: 'pointer', color: 'var(--blue)' }} onClick={() => onOpenChart?.(r.symbol)}>{r.symbol}</span>
                      </td>
                      <td style={{ padding: '7px 14px', fontSize: '12px', color: 'var(--text-secondary)' }}>{r.time}</td>
                      <td style={{ padding: '7px 14px', fontSize: '13px', fontFamily: 'var(--font-mono)', fontWeight: 600, textAlign: 'right',
                                   color: under ? 'var(--green)' : 'var(--text-primary)' }}>{r.distance.toFixed(3)}</td>
                      <td style={{ padding: '7px 14px', fontSize: '12px', color: 'var(--text-muted)' }}>{r.match}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}

const inp = { height: '30px', padding: '0 8px', fontSize: '12px', background: 'var(--bg-raised)',
              border: '1px solid var(--border)', borderRadius: '5px', color: 'var(--text-primary)', outline: 'none' }
const btnPrimary = { height: '30px', padding: '0 14px', fontSize: '12px', fontWeight: 600,
                     background: 'var(--blue)', border: 'none', borderRadius: '5px', color: '#fff', cursor: 'pointer' }
const btnGhost = { height: '30px', padding: '0 10px', fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap',
                   background: 'var(--bg-raised)', border: '1px solid var(--border)', borderRadius: '5px',
                   color: 'var(--text-secondary)', cursor: 'pointer' }
const toggleBtn = { flex: 1, height: '28px', fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                    background: 'var(--bg-raised)', border: '1px solid var(--border)', color: 'var(--text-secondary)' }
const toggleOn = { background: 'var(--blue)', color: '#fff' }
const miniLabel = { fontSize: '9px', color: 'var(--text-muted)', marginBottom: '2px' }
function Label({ children, style }) {
  return <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em',
                       color: 'var(--text-muted)', marginBottom: '6px', ...style }}>{children}</div>
}
function Center({ children }) {
  return <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>{children}</div>
}
