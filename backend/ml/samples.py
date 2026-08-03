"""
Example-based (similarity) screening.

You hand-pick exemplar bars into a named *collection*; each is stored as its
ATR-normalized chart-shape vector.  Screening then ranks a universe's latest
bars by distance to the nearest exemplar, in standardized (per-feature std)
units, and flags those under a threshold.

Distance:
    features are z-scored using population mean/std (from the panel, cached in
    _feature_stats.json), then Euclidean distance is taken and divided by
    sqrt(n_features) so it reads as "avg std-devs of difference per feature".
    Distance to a collection = the minimum over its samples (nearest exemplar).

CLI:
    python -m ml.samples stats
    python -m ml.samples add  <collection> AAPL 2026-06-25
    python -m ml.samples list <collection>
    python -m ml.samples remove <collection> AAPL 2026-06-25
    python -m ml.samples screen <collection> --universe "S&P 500" --threshold 0.75
"""
import argparse
import json
import logging
import sqlite3
import time
from bisect import bisect_right
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np
import pandas as pd

from core.chart_shape import SHAPE_FIELDS, extract_chart_shape
from core.prices import get_daily_ohlc
from ml.dataset import watchlist_symbols

logging.basicConfig(level=logging.WARNING, format="%(asctime)s %(levelname)s %(message)s")

_DB          = Path(__file__).parent.parent / "db" / "qd.db"
_STATS_PATH  = Path(__file__).parent / "collections" / "_feature_stats.json"
_DEFAULT_PANEL = Path(__file__).parent / "data" / "panel_h20.parquet"


# ── DB access (sync; mirrors the SQLAlchemy FeatureSample table) ───────────────

def _con():
    con = sqlite3.connect(_DB)
    con.execute("PRAGMA busy_timeout=30000")   # wait rather than error under load
    return con


def _ensure_table(con):
    con.execute(
        "CREATE TABLE IF NOT EXISTS feature_samples ("
        "id INTEGER PRIMARY KEY AUTOINCREMENT, collection VARCHAR NOT NULL, "
        "symbol VARCHAR NOT NULL, date VARCHAR NOT NULL, "
        "normalize VARCHAR NOT NULL DEFAULT 'atr', vector JSON NOT NULL, "
        "created_at VARCHAR NOT NULL DEFAULT '', "
        "CONSTRAINT uq_feature_sample UNIQUE (collection, symbol, date))"
    )


# ── Standardization stats ─────────────────────────────────────────────────────

def build_stats(panel=_DEFAULT_PANEL) -> dict:
    """Compute per-feature mean/std from the panel and cache to disk."""
    df = pd.read_parquet(panel)
    feats = [c for c in SHAPE_FIELDS if c in df.columns]
    stats = {f: {"mean": float(df[f].mean()), "std": float(df[f].std() or 1.0)} for f in feats}
    _STATS_PATH.parent.mkdir(parents=True, exist_ok=True)
    _STATS_PATH.write_text(json.dumps({"features": feats, "stats": stats}, indent=2))
    return {"features": feats, "stats": stats}


def load_stats():
    """Return (features, mean[np], std[np]); build from panel on first use."""
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


def vector_for(symbol, date, normalize="atr"):
    """Feature dict for (symbol, date). Snaps to the last bar on/before `date`.

    Returns (used_date, {feature: value}). Raises ValueError if unavailable.
    """
    rows = _shape_rows(symbol, normalize)
    if not rows:
        raise ValueError(f"No shape data for {symbol}")
    times = [r["time"] for r in rows]
    if date in times:
        row = rows[times.index(date)]
    else:
        i = bisect_right(times, date) - 1     # last bar <= date
        if i < 0:
            raise ValueError(f"{symbol}: no bar on/before {date} (earliest {times[0]})")
        row = rows[i]
    return row["time"], {f: row[f] for f in SHAPE_FIELDS if f in row}


def latest_vector(symbol, normalize="atr"):
    rows = _shape_rows(symbol, normalize)
    if not rows:
        return None
    last = rows[-1]
    return last["time"], {f: last[f] for f in SHAPE_FIELDS if f in last}


def _standardize(vec: dict, feats, mean, std) -> np.ndarray:
    return (np.array([vec.get(f, mean[i]) for i, f in enumerate(feats)]) - mean) / std


# ── CRUD ──────────────────────────────────────────────────────────────────────

def add_sample(collection, symbol, date, normalize="atr"):
    used_date, vec = vector_for(symbol.upper(), date, normalize)
    con = _con()
    try:
        _ensure_table(con)
        con.execute(
            "INSERT INTO feature_samples (collection, symbol, date, normalize, vector, created_at) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT(collection, symbol, date) DO UPDATE SET "
            "vector=excluded.vector, normalize=excluded.normalize, created_at=excluded.created_at",
            (collection, symbol.upper(), used_date, normalize, json.dumps(vec),
             time.strftime("%Y-%m-%d %H:%M:%S")),
        )
        con.commit()
    finally:
        con.close()
    return used_date, vec


def list_samples(collection):
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT symbol, date, normalize, created_at FROM feature_samples "
            "WHERE collection=? ORDER BY created_at", (collection,)).fetchall()
    finally:
        con.close()
    return [{"symbol": r[0], "date": r[1], "normalize": r[2], "created_at": r[3]} for r in rows]


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


def list_collections():
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT collection, COUNT(*) FROM feature_samples GROUP BY collection ORDER BY collection"
        ).fetchall()
    finally:
        con.close()
    return [{"collection": r[0], "n": r[1]} for r in rows]


def _collection_matrix(collection, feats, mean, std):
    con = _con()
    try:
        _ensure_table(con)
        rows = con.execute(
            "SELECT symbol, date, vector FROM feature_samples WHERE collection=?",
            (collection,)).fetchall()
    finally:
        con.close()
    if not rows:
        return None, []
    Z, meta = [], []
    for sym, dt, vec_json in rows:
        Z.append(_standardize(json.loads(vec_json), feats, mean, std))
        meta.append((sym, dt))
    return np.vstack(Z), meta


# ── Similarity screen ─────────────────────────────────────────────────────────

def screen(collection, universe="S&P 500", threshold=None, top=30,
           normalize="atr", workers=8):
    feats, mean, std = load_stats()
    Z, meta = _collection_matrix(collection, feats, mean, std)
    if Z is None:
        raise ValueError(f"Collection {collection!r} is empty.")
    sqrtF = np.sqrt(len(feats))
    syms = watchlist_symbols(universe)

    def _one(sym):
        try:
            lv = latest_vector(sym, normalize)
        except Exception:
            return None
        if lv is None:
            return None
        used_date, vec = lv
        z = _standardize(vec, feats, mean, std)
        d = np.linalg.norm(Z - z, axis=1) / sqrtF     # per-sample distances
        j = int(np.argmin(d))
        return {"symbol": sym, "time": used_date, "distance": float(d[j]),
                "match_symbol": meta[j][0], "match_date": meta[j][1]}

    recs = []
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = {pool.submit(_one, s): s for s in syms}
        for fut in as_completed(futs):
            r = fut.result()
            if r is not None:
                recs.append(r)
    recs.sort(key=lambda r: r["distance"])
    return recs, len(Z)


# ── CLI ───────────────────────────────────────────────────────────────────────

def _cli():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("stats")
    sub.add_parser("collections")
    pa = sub.add_parser("add");    pa.add_argument("collection"); pa.add_argument("symbol"); pa.add_argument("date")
    pl = sub.add_parser("list");   pl.add_argument("collection")
    pr = sub.add_parser("remove"); pr.add_argument("collection"); pr.add_argument("symbol"); pr.add_argument("date")
    ps = sub.add_parser("screen")
    ps.add_argument("collection")
    ps.add_argument("--universe", default="S&P 500")
    ps.add_argument("--threshold", type=float, default=None)
    ps.add_argument("--top", type=int, default=30)
    ps.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    if a.cmd == "stats":
        d = build_stats()
        print(f"Built stats for {len(d['features'])} features -> {_STATS_PATH}")
    elif a.cmd == "collections":
        for c in list_collections():
            print(f"  {c['collection']:30} {c['n']} samples")
    elif a.cmd == "add":
        used, vec = add_sample(a.collection, a.symbol, a.date)
        print(f"Added {a.symbol.upper()} @ {used} to '{a.collection}'")
        print("  " + "  ".join(f"{k}={v:+.3f}" for k, v in vec.items()))
    elif a.cmd == "list":
        rows = list_samples(a.collection)
        print(f"'{a.collection}' — {len(rows)} samples")
        for r in rows:
            print(f"  {r['symbol']:6} {r['date']}  ({r['normalize']})")
    elif a.cmd == "remove":
        n = remove_sample(a.collection, a.symbol, a.date)
        print(f"Removed {n} row(s).")
    elif a.cmd == "screen":
        recs, k = screen(a.collection, a.universe, a.threshold, a.top, workers=a.workers)
        ds = np.array([r["distance"] for r in recs])
        print(f"\n'{a.collection}' ({k} exemplars) vs {a.universe} — {len(recs)} scored")
        print(f"distance dist: min={ds.min():.3f}  p10={np.percentile(ds,10):.3f}  "
              f"p25={np.percentile(ds,25):.3f}  median={np.percentile(ds,50):.3f}")
        if a.threshold is not None:
            n_under = int((ds < a.threshold).sum())
            print(f"under threshold {a.threshold}: {n_under}")
        print(f"\n{'symbol':7} {'bar':11} {'distance':>9}  nearest exemplar")
        for r in recs[:a.top]:
            flag = " *" if (a.threshold is not None and r["distance"] < a.threshold) else ""
            print(f"{r['symbol']:7} {r['time']:11} {r['distance']:9.3f}  "
                  f"{r['match_symbol']} {r['match_date']}{flag}")


if __name__ == "__main__":
    _cli()
