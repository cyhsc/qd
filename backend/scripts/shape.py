#!/usr/bin/env python
"""
View the chart-shape signature for a symbol.

Usage (from the backend/ dir, venv active):

    python scripts/shape.py TFX              # last 15 daily bars, table
    python scripts/shape.py TFX -n 40        # last 40 bars
    python scripts/shape.py TFX --all        # every bar
    python scripts/shape.py TFX --csv > tfx_shape.csv

All fields are dimensionless, so signatures are comparable across symbols.
"""
import argparse
import csv
import sys
from pathlib import Path

# Allow running as `python scripts/shape.py` from backend/.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import numpy as np  # noqa: E402

from core.prices import get_daily_ohlc          # noqa: E402
from core.chart_shape import extract_chart_shape, SHAPE_FIELDS  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Print the chart-shape signature for a symbol.")
    ap.add_argument("symbol")
    ap.add_argument("-n", type=int, default=15, help="number of trailing bars (default 15)")
    ap.add_argument("--all", action="store_true", help="print every bar")
    ap.add_argument("--csv", action="store_true", help="emit CSV to stdout")
    ap.add_argument("--lookback", type=int, default=5, help="slope/curvature lookback (default 5)")
    ap.add_argument("--atr", action="store_true",
                    help="scale price-relative fields by ATR instead of price "
                         "(comparable across volatility regimes)")
    args = ap.parse_args()

    df = get_daily_ohlc(args.symbol)
    rows = extract_chart_shape(
        df["Close"].to_numpy(np.float64),
        df["High"].to_numpy(np.float64),
        df["Low"].to_numpy(np.float64),
        list(df.index),
        lookback=args.lookback,
        normalize="atr" if args.atr else "price",
    )
    if not rows:
        print(f"No shape data for {args.symbol.upper()} (not enough bars).", file=sys.stderr)
        return 1

    if not args.all:
        rows = rows[-args.n:]

    if args.csv:
        w = csv.DictWriter(sys.stdout, fieldnames=["time", *SHAPE_FIELDS])
        w.writeheader()
        w.writerows(rows)
        return 0

    # Aligned table
    cols = ["time", *SHAPE_FIELDS]
    widths = {c: max(len(c), 10) for c in cols}
    header = "  ".join(c.rjust(widths[c]) for c in cols)
    print(f"{args.symbol.upper()}  —  chart-shape signature  ({len(rows)} bars)\n")
    print(header)
    print("-" * len(header))
    for r in rows:
        line = "  ".join(
            (str(r[c]) if c == "time" else f"{r[c]:+.4f}").rjust(widths[c])
            for c in cols
        )
        print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
