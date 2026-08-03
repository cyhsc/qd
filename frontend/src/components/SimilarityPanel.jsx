import { useCallback, useEffect, useState } from 'react'

// Example-based (similarity) screening: curate exemplar bars into a named
// collection, then rank a universe's latest bars by distance to the nearest
// exemplar (standardized per-feature std units).

const API = '/api/samples'

export function SimilarityPanel({ watchlists = [], active, onOpenChart }) {
  const [collections, setCollections] = useState([])
  const [collection,  setCollection]  = useState('')
  const [samples,     setSamples]     = useState([])

  const [addSymbol, setAddSymbol] = useState('')
  const [addDate,   setAddDate]   = useState('')
  const [msg,       setMsg]       = useState(null)

  const [universe,  setUniverse]  = useState('')
  const [threshold, setThreshold] = useState('0.75')
  const [topN,      setTopN]      = useState('50')
  const [results,   setResults]   = useState(null)
  const [meta,      setMeta]      = useState(null)
  const [screening, setScreening] = useState(false)

  // Default universe once watchlists arrive
  useEffect(() => {
    if (!universe && watchlists.length) {
      const sp = watchlists.find(w => w.name === 'S&P 500')
      setUniverse(sp ? sp.name : watchlists[0].name)
    }
  }, [watchlists, universe])

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

  const addSample = async () => {
    const name = collection.trim(); const sym = addSymbol.trim().toUpperCase(); const date = addDate.trim()
    if (!name || !sym || !date) { setMsg({ err: true, text: 'Collection, symbol and date are all required.' }); return }
    try {
      const res = await fetch(`${API}/${encodeURIComponent(name)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym, date }),
      })
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail || `HTTP ${res.status}`) }
      const d = await res.json()
      setMsg({ err: false, text: `Added ${d.symbol} @ ${d.date}` })
      setAddSymbol('')
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
      const params = new URLSearchParams({ universe, top: topN || '50' })
      if (threshold.trim() !== '') params.set('threshold', threshold)
      const res = await fetch(`${API}/${encodeURIComponent(collection)}/screen?${params}`)
      if (!res.ok) { const b = await res.json().catch(() => ({})); throw new Error(b.detail || `HTTP ${res.status}`) }
      const d = await res.json()
      setResults(d.results ?? [])
      setMeta({ exemplars: d.exemplars, threshold: d.threshold })
    } catch (e) { setMsg({ err: true, text: e.message }) }
    finally { setScreening(false) }
  }

  const thr = threshold.trim() === '' ? null : parseFloat(threshold)

  return (
    <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
      {/* ── Left: collection management ── */}
      <div style={{
        width: '320px', flexShrink: 0, borderRight: '1px solid var(--border)',
        display: 'flex', flexDirection: 'column', overflow: 'auto', padding: '16px',
      }}>
        <Label>Collection</Label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '4px' }}>
          <input
            list="collection-list" value={collection}
            onChange={e => setCollection(e.target.value)}
            placeholder="name (pick or type new)"
            style={inp}
          />
          <datalist id="collection-list">
            {collections.map(c => <option key={c.collection} value={c.collection}>{`${c.n} samples`}</option>)}
          </datalist>
        </div>
        {collections.length > 0 && (
          <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginBottom: '16px' }}>
            {collections.map(c => (
              <span key={c.collection}
                onClick={() => setCollection(c.collection)}
                style={{ cursor: 'pointer', marginRight: '10px',
                         color: c.collection === collection ? 'var(--blue)' : 'var(--text-muted)' }}>
                {c.collection} ({c.n})
              </span>
            ))}
          </div>
        )}

        <Label>Add sample</Label>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <input value={addSymbol} onChange={e => setAddSymbol(e.target.value)}
                 placeholder="Symbol" style={{ ...inp, flex: 1 }} />
          <input type="date" value={addDate} onChange={e => setAddDate(e.target.value)}
                 style={{ ...inp, flex: 1 }} />
        </div>
        <button onClick={addSample} style={btnPrimary}>+ Add to collection</button>
        {msg && (
          <div style={{ fontSize: '11px', marginTop: '8px', color: msg.err ? 'var(--red)' : 'var(--green)' }}>
            {msg.text}
          </div>
        )}

        <Label style={{ marginTop: '20px' }}>Samples ({samples.length})</Label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {samples.length === 0 && <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>No samples yet.</div>}
          {samples.map(s => (
            <div key={`${s.symbol}-${s.date}`} style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '5px 8px', borderRadius: '5px', background: 'var(--bg-raised)', fontSize: '12px',
            }}>
              <span><b style={{ cursor: 'pointer' }} onClick={() => onOpenChart?.(s.symbol)}>{s.symbol}</b> <span style={{ color: 'var(--text-muted)' }}>{s.date}</span></span>
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
            <select value={universe} onChange={e => setUniverse(e.target.value)} style={{ ...inp, minWidth: '180px' }}>
              {watchlists.map(w => <option key={w.id} value={w.name}>{w.name}</option>)}
            </select>
          </div>
          <div><Label>Max distance</Label>
            <input value={threshold} onChange={e => setThreshold(e.target.value)}
                   placeholder="(none)" style={{ ...inp, width: '90px' }} />
          </div>
          <div><Label>Top N</Label>
            <input value={topN} onChange={e => setTopN(e.target.value)} style={{ ...inp, width: '70px' }} />
          </div>
          <button onClick={runScreen} disabled={screening} style={{ ...btnPrimary, opacity: screening ? 0.5 : 1 }}>
            {screening ? 'Screening…' : 'Run similarity screen'}
          </button>
          {meta && (
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              {meta.exemplars} exemplars · distance in per-feature std units
            </span>
          )}
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '0 20px 24px' }}>
          {results == null ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              Curate a collection, then run the screen to rank the universe by similarity.
            </div>
          ) : results.length === 0 ? (
            <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
              No results.
            </div>
          ) : (
            <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: '640px', marginTop: '12px' }}>
              <thead>
                <tr style={{ borderBottom: '2px solid var(--border)' }}>
                  {['Symbol', 'Bar', 'Distance', 'Nearest exemplar'].map((h, i) => (
                    <th key={h} style={{ textAlign: i === 0 ? 'left' : i === 2 ? 'right' : 'left',
                                         padding: '6px 14px 10px', fontSize: '11px', fontWeight: 600, color: 'var(--text-muted)' }}>{h}</th>
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
                      <td style={{ padding: '7px 14px', fontSize: '12px', color: 'var(--text-muted)' }}>{r.match_symbol} {r.match_date}</td>
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

const inp = {
  height: '30px', padding: '0 8px', fontSize: '12px',
  background: 'var(--bg-raised)', border: '1px solid var(--border)',
  borderRadius: '5px', color: 'var(--text-primary)', outline: 'none',
}
const btnPrimary = {
  height: '30px', padding: '0 14px', fontSize: '12px', fontWeight: 600,
  background: 'var(--blue)', border: 'none', borderRadius: '5px',
  color: '#fff', cursor: 'pointer',
}
function Label({ children, style }) {
  return <div style={{ fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                       letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: '6px', ...style }}>{children}</div>
}
