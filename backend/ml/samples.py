"""
Example-based (similarity) screening — point and range (pattern) matching.

You hand-pick exemplars into a named *collection*:
  * a **point** exemplar is one bar's ATR-normalized chart-shape vector;
  * a **range** exemplar is the *sequence* of vectors between two dates (a shape).

Screening ranks a universe by distance to the nearest exemplar.  Features are
z-scored (population mean/std from the panel, cached in _feature_stats.json) so
all distances read in "avg std-devs per feature" units.

Point distance   : standardized Euclidean on the latest bar.
Range distance   : sequence distance between the template and a candidate window
    metric = "dtw"       (default) multivariate DTW — robust to time-warping;
             "euclidean" resample-to-template-length then Euclidean.
    scope  = "latest"    (default) the candidate's most recent L-bar window;
             "history"   slide over recent bars, keep the best-matching window.

CLI:
    python -m ml.samples stats
    python -m ml.samples add   <col> AAPL 2026-06-25
    python -m ml.samples add-range <col> AAPL 2026-01-05 2026-02-10
    python -m ml.samples list  <col>
    python -m ml.samples screen <col> --metric dtw --scope latest --threshold 0.75
"""
import argparse
import json
import logging
import sqlite3
import time
from bisect import bisect_left, bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd

from core.chart_shape import SHAPE_FIELDS, extract_chart_shape
from core.prices import get_daily_ohlc
from ml.dataset import watchlist_symbols

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")

_DB            = Path(__file__).parent.parent / "db" / "qd.db"
_STATS_PATH    = Path(__file__).parent / "collections" / "_feature_stats.json"
_DEFAULT_PANEL = Path(__file__).parent / "data" / "panel_h20.parquet"
HISTORY_LOOKBACK = 252   # bars scanned in scope="history" (≈ 1 year)


# ── DB access ─────────────────────────────────────────────────────────────────

def _con():
    con = sqlite3.connect(_DB)
    con.execute("PRAGMA busy_timeout=30000")
    return con


def _ensure_table(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS feature_samples ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, collection VARCHAR NOT NULL, "
        "symbol VARCHAR NOT NULL, date VARCHAR NOT NULL, kind VARCHAR NOT NULL DEFAULT 'point', "
        "normalize VARCHAR NOT NULL DEFAULT 'atr', vector JSON NOT NULL, "
        "created_at VARCHAR NOT NULL DEFAULT '', "
        "CONSTRAINT uq_feature_sample UNIQUE (collection, symbol, date))"
    )


# ── Standardization stats ─────────────────────────────────────────────────────

def build_stats(panel=_DEFAULT_PANEL) -> dict:
    df = pd.read_parquet(panel)
    feats = [c for c in SHAPE_FIELDS if c in df.columns]
    stats = {f: {"mean": float(df[f].mean()), "std": float(df[f].std() or 1.0)} for f in feats}
    _STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATS_PATH.write_text(json.dumps({"features": feats, "stats": stats}, indent=2))
    return {"features": feats, "stats": stats}


def load_stats():
    if not _STATS_PATH.exists():
        build_stats()
    d = json.loads(_STATS_PATH.read_text())
    feats = d["features"]
    mean = np.array([d["stats"][f]["mean"] for f in feats], dtype=np.float64)
    std  = np.array([d["stats"][f]["std"] or 1.0 for f in feats], dtype=np.float64)
    return feats, mean, std


# ── Feature vectors ───────────────────────────────────────────────────────────

def _shape_rows(symbol, normalize="atr"):
    df = get_daily_ohlc(symbol)
    if df.empty:
        return []
    return extract_chart_shape(
        df["Close"].to_numpy(np.float64), df["High"].to_numpy(np.float64),
        df["Low"].to_numpy(np.float64), list(df.index), normalize=normalize,
    )


def _row_vec(row):
    return {f: row[f] for f in SHAPE_FIELDS if f in row}


def vector_for(symbol, date, normalize="atr"):
    """Point: feature dict for (symbol, date), snapped to the last bar <= date."""
    rows = _shape_rows(symbol, normalize)
    if not rows:
        raise ValueError(f"No shape data for {symbol}")
    times = [r["time"] for r in rows]
    if date in times:
        row = rows[times.index(date)]
    else:
        i = bisect_right(times, date) - 1
        if i < 0:
            raise ValueError(f"{symbol}: no bar on/before {date} (earliest {times[0]})")
        row = rows[i]
    return row["time"], _row_vec(row)


def range_vector_for(symbol, start, end, normalize="atr"):
    """Range: the sequence of feature dicts for bars in [start, end] (inclusive)."""
    rows = _shape_rows(symbol, normalize)
    if not rows:
        raise ValueError(f"No shape data for {symbol}")
    times = [r["time"] for r in rows]
    lo = bisect_left(times, start)
    hi = bisect_right(times, end)
    seg = rows[lo:hi]
    if len(seg) < 2:
        raise ValueError(f"{symbol}: fewer than 2 bars in {start}..{end}")
    return seg[0]["time"], seg[-1]["time"], [_row_vec(r) for r in seg]


def latest_vector(symbol, normalize="atr"):
    rows = _shape_rows(symbol, normalize)
    if not rows:
        return None
    return rows[-1]["time"], _row_vec(rows[-1])


def _standardize(vec: dict, feats, mean, std) -> np.ndarray:
    return (np.array([vec.get(f, mean[i]) for i, f in enumerate(feats)]) - mean) / std


def _standardize_seq(seq: list, feats, mean, std) -> np.ndarray:
    return np.vstack([_standardize(v, feats, mean, std) for v in seq])


def _symbol_std_matrix(symbol, feats, mean, std, normalize="atr"):
    """Full standardized (n_bars, n_features) matrix + times for a symbol."""
    rows = _shape_rows(symbol, normalize)
    if not rows:
        return None, []
    Z = np.vstack([_standardize(_row_vec(r), feats, mean, std) for r in rows])
    return Z, [r["time"] for r in rows]


# ── Sequence distance ─────────────────────────────────────────────────────────

def _resample(seq: np.ndarray, M: int) -> np.ndarray:
    L = len(seq)
    if L == M:
        return seq
    xs, xt = np.linspace(0, 1, L), np.linspace(0, 1, M)
    return np.column_stack([np.interp(xt, xs, seq[:, f]) for f in range(seq.shape[1])])


def _euclid_seq(A: np.ndarray, B: np.ndarray) -> float:
    M, F = len(A), A.shape[1]
    Br = _resample(B, M)
    return float(np.linalg.norm((A - Br).ravel()) / np.sqrt(M * F))


def _dtw(A: np.ndarray, B: np.ndarray, band=None) -> float:
    """Multivariate DTW; result normalized to per-bar-per-feature std units."""
    n, m, F = len(A), len(B), A.shape[1]
    if band is None:
        band = max(n, m)
    D = np.full((n + 1, m + 1), np.inf)
    D[0, 0] = 0.0
    for i in range(1, n + 1):
        Ai = A[i - 1]
        for j in range(max(1, i - band), min(m, i + band) + 1):
            c = np.sqrt(np.sum((Ai - B[j - 1]) ** 2))
            D[i, j] = c + min(D[i - 1, j], D[i, j - 1], D[i - 1, j - 1])
    return float(D[n, m] / ((n + m) / 2.0) / np.sqrt(F))


def _seq_distance(A, B, metric, band):
    return _euclid_seq(A, B) if metric == "euclidean" else _dtw(A, B, band)


def _range_distance(tplZ, Zall, times, metric, scope, stride):
    """Distance from a template sequence to a symbol's window(s)."""
    L, n = len(tplZ), len(Zall)
    if n < L:
        return float("inf"), None
    band = max(2, round(0.25 * L))
    if scope == "latest":
        return _seq_distance(tplZ, Zall[n - L:n], metric, band), times[n - 1]
    # history: slide over the recent lookback
    start = max(L, n - HISTORY_LOOKBACK)
    best, best_end = float("inf"), None
    for e in range(start, n + 1, max(1, stride)):
        d = _seq_distance(tplZ, Zall[e - L:e], metric, band)
        if d < best:
            best, best_end = d, times[e - 1]
    return best, best_end


# ── CRUD ──────────────────────────────────────────────────────────────────────

def _insert(collection, symbol, date, kind, normalize, vector):
    con = _con()
    try:
        _ensure_table(con)
        con.execute(
            "INSERT INTO feature_samples (collection, symbol, date, kind, normalize, vector, created_at) "
            "VALUES (?,?,?,?,?,?,?) ON CONFLICT(collection, symbol, date) DO UPDATE SET "
            "kind=excluded.kind, vector=excluded.vector, normalize=excluded.normalize, created_at=excluded.created_at",
            (collection, symbol.upper(), date, kind, normalize, json.dumps(vector),
             time.strftime("%Y-%m-%d %H:%M:%S")),
        )
        con.commit()
    finally:
        con.close()


def add_sample(collection, symbol, date, normalize="atr"):
    used_date, vec = vector_for(symbol.upper(), date, normalize)
    _insert(collection, symbol, used_date, "point", normalize, vec)
    return used_date, vec


def add_range_sample(collection, symbol, start, end, normalize="atr"):
    s_used, e_used, seq = range_vector_for(symbol.upper(), start, end, normalize)
    vec = {"start": s_used, "end": e_used, "seq": seq}
    _insert(collection, symbol, e_used, "range", normalize, vec)   # keyed by END date
    return s_used, e_used, len(seq)


def list_samples(collection):
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT symbol, date, kind, normalize, vector, created_at FROM feature_samples "
            "WHERE collection=? ORDER BY created_at", (collection,)).fetchall()
    finally:
        con.close()
    out = []
    for sym, dt, kind, norm, vec_json, created in rows:
        item = {"symbol": sym, "date": dt, "kind": kind, "normalize": norm, "created_at": created}
        if kind == "range":
            v = json.loads(vec_json)
            item["start"], item["end"], item["length"] = v.get("start"), v.get("end"), len(v.get("seq", []))
        out.append(item)
    return out


def remove_sample(collection, symbol, date):
    con = _con()
    try:
        _ensure_table(con)
        cur = con.execute("DELETE FROM feature_samples WHERE collection=? AND symbol=? AND date=?",
                          (collection, symbol.upper(), date))
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def delete_collection(collection):
    con = _con()
    try:
        _ensure_table(con)
        cur = con.execute("DELETE FROM feature_samples WHERE collection=?", (collection,))
        con.commit()
        return cur.rowcount
    finally:
        con.close()


def list_collections():
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT collection, COUNT(*), SUM(kind='range') FROM feature_samples GROUP BY collection ORDER BY collection"
        ).fetchall()
    finally:
        con.close()
    return [{"collection": r[0], "n": r[1], "ranges": r[2] or 0} for r in rows]


def _load_samples(collection, feats, mean, std):
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT symbol, date, kind, vector FROM feature_samples WHERE collection=?",
            (collection,)).fetchall()
    finally:
        con.close()
    points, ranges = [], []
    for sym, dt, kind, vec_json in rows:
        v = json.loads(vec_json)
        if kind == "range":
            ranges.append({"symbol": sym, "start": v.get("start"), "end": v.get("end"),
                           "Z": _standardize_seq(v["seq"], feats, mean, std),
                           "label": f"{sym} {v.get('start')}→{v.get('end')}"})
        else:
            points.append({"symbol": sym, "date": dt,
                           "z": _standardize(v, feats, mean, std), "label": f"{sym} {dt}"})
    return points, ranges


# ── Screen ────────────────────────────────────────────────────────────────────

def screen(collection, universe="S&P 500", threshold=None, top=50, normalize="atr",
           metric="dtw", scope="latest", stride=5, workers=8):
    feats, mean, std = load_stats()
    points, ranges = _load_samples(collection, feats, mean, std)
    if not points and not ranges:
        raise ValueError(f"Collection {collection!r} is empty.")
    sqrtF = np.sqrt(len(feats))
    syms = watchlist_symbols(universe)
    need_matrix = bool(ranges)

    def _one(sym):
        best = None
        try:
            if need_matrix:
                Z, times = _symbol_std_matrix(sym, feats, mean, std, normalize)
                if Z is None:
                    return None
                for r in ranges:
                    d, end_t = _range_distance(r["Z"], Z, times, metric, scope, stride)
                    if best is None or d < best["distance"]:
                        best = {"distance": d, "match": r["label"], "time": end_t}
                latest_t, latest_vec = times[-1], None
                if points:
                    z = Z[-1]
                    for p in points:
                        d = float(np.linalg.norm(z - p["z"]) / sqrtF)
                        if best is None or d < best["distance"]:
                            best = {"distance": d, "match": p["label"], "time": times[-1]}
            else:
                lv = latest_vector(sym, normalize)
                if lv is None:
                    return None
                used_date, vec = lv
                z = _standardize(vec, feats, mean, std)
                for p in points:
                    d = float(np.linalg.norm(z - p["z"]) / sqrtF)
                    if best is None or d < best["distance"]:
                        best = {"distance": d, "match": p["label"], "time": used_date}
        except Exception:
            return None
        if best is None or not np.isfinite(best["distance"]):
            return None
        best["symbol"] = sym
        return best

    recs = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_one, s): s for s in syms}
        for fut in as_completed(futs):
            r = fut.result()
            if r is not None:
                recs.append(r)
    recs.sort(key=lambda r: r["distance"])
    return recs, {"points": len(points), "ranges": len(ranges), "metric": metric, "scope": scope}


# ── CLI ───────────────────────────────────────────────────────────────────────

def _cli():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats"); sub.add_parser("collections")
    pd_ = sub.add_parser("delete-collection"); pd_.add_argument("collection")
    pa = sub.add_parser("add");    pa.add_argument("collection"); pa.add_argument("symbol"); pa.add_argument("date")
    pg = sub.add_parser("add-range"); pg.add_argument("collection"); pg.add_argument("symbol"); pg.add_argument("start"); pg.add_argument("end")
    pl = sub.add_parser("list");   pl.add_argument("collection")
    pr = sub.add_parser("remove"); pr.add_argument("collection"); pr.add_argument("symbol"); pr.add_argument("date")
    ps = sub.add_parser("screen")
    ps.add_argument("collection")
    ps.add_argument("--universe", default="S&P 500")
    ps.add_argument("--metric", choices=["dtw", "euclidean"], default="dtw")
    ps.add_argument("--scope", choices=["latest", "history"], default="latest")
    ps.add_argument("--stride", type=int, default=5)
    ps.add_argument("--threshold", type=float, default=None)
    ps.add_argument("--top", type=int, default=30)
    ps.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    if a.cmd == "stats":
        d = build_stats(); print(f"Built stats for {len(d['features'])} features -> {_STATS_PATH}")
    elif a.cmd == "collections":
        for c in list_collections():
            print(f"  {c['collection']:30} {c['n']} samples ({c['ranges']} range)")
    elif a.cmd == "add":
        used, vec = add_sample(a.collection, a.symbol, a.date)
        print(f"Added point {a.symbol.upper()} @ {used} to '{a.collection}'")
    elif a.cmd == "add-range":
        s, e, L = add_range_sample(a.collection, a.symbol, a.start, a.end)
        print(f"Added range {a.symbol.upper()} {s}→{e} ({L} bars) to '{a.collection}'")
    elif a.cmd == "list":
        for r in list_samples(a.collection):
            if r["kind"] == "range":
                print(f"  {r['symbol']:6} RANGE {r['start']}→{r['end']} ({r['length']} bars)")
            else:
                print(f"  {r['symbol']:6} POINT {r['date']}")
    elif a.cmd == "remove":
        print(f"Removed {remove_sample(a.collection, a.symbol, a.date)} row(s).")
    elif a.cmd == "delete-collection":
        print(f"Deleted collection '{a.collection}' ({delete_collection(a.collection)} samples).")
    elif a.cmd == "screen":
        recs, meta = screen(a.collection, a.universe, a.threshold, a.top,
                            metric=a.metric, scope=a.scope, stride=a.stride, workers=a.workers)
        ds = np.array([r["distance"] for r in recs])
        print(f"\n'{a.collection}' [{meta['points']}pt/{meta['ranges']}range, {meta['metric']}/{meta['scope']}] "
              f"vs {a.universe} — {len(recs)} scored")
        print(f"distance: min={ds.min():.3f} p10={np.percentile(ds,10):.3f} p25={np.percentile(ds,25):.3f} median={np.percentile(ds,50):.3f}")
        print(f"\n{'symbol':7} {'bar':11} {'distance':>9}  nearest exemplar")
        for r in recs[:a.top]:
            flag = " *" if (a.threshold is not None and r["distance"] < a.threshold) else ""
            print(f"{r['symbol']:7} {str(r['time']):11} {r['distance']:9.3f}  {r['match']}{flag}")


if __name__ == "__main__":
    _cli()
