"""
Triple-barrier labeling for supervised stock screening.

For each bar ``t`` we place three barriers relative to the entry (close of t):

    upper (target) = close(t) + Tu * ATR14(t)
    lower (stop)   = close(t) - Td * ATR14(t)
    vertical       = t + H bars

Walking forward bar by bar, the first barrier touched decides the label:

    label 1  -> the target was hit first          ("win")
    label 0  -> the stop was hit first, OR neither was hit within H bars
                ("stop" / "timeout")

So the binary label answers exactly the screening question: "does this setup
reach +Tu·ATR before -Td·ATR within H days?"  Barrier touches use each bar's
high/low.  If a single bar touches both, we resolve pessimistically (stop),
since in a real fill you can't know which came first intrabar.

Bars without a full H-bar forward window (or without a valid ATR) are left
undefined (label -1) so they can be dropped from training — they are exactly
the trailing bars used later for live screening.
"""
import numpy as np


def triple_barrier(close, high, low, atr, Tu=1.5, Td=1.0, H=5):
    """Return (label, outcome, days, ret) arrays aligned to the input bars.

    label   : int8   1 win / 0 not-win / -1 undefined
    outcome : object 'win' | 'stop' | 'timeout' | None(undefined)
    days    : int16  bars until the resolving barrier (0 when undefined)
    ret     : float  realized return to the exit (barrier level for win/stop,
              close(t+H) for timeout); NaN when undefined
    """
    close = np.asarray(close, dtype=np.float64)
    high  = np.asarray(high,  dtype=np.float64)
    low   = np.asarray(low,   dtype=np.float64)
    atr   = np.asarray(atr,   dtype=np.float64)
    n = len(close)

    label   = np.full(n, -1, dtype=np.int8)
    outcome = np.full(n, None, dtype=object)
    days    = np.zeros(n, dtype=np.int16)
    ret     = np.full(n, np.nan, dtype=np.float64)

    for t in range(n):
        a = atr[t]
        entry = close[t]
        if t + H >= n or not np.isfinite(a) or a <= 0 or not np.isfinite(entry):
            continue

        up = entry + Tu * a
        dn = entry - Td * a
        res, d, lab, exit_px = "timeout", H, 0, None

        for k in range(1, H + 1):
            hi, lo = high[t + k], low[t + k]
            hit_up = np.isfinite(hi) and hi >= up
            hit_dn = np.isfinite(lo) and lo <= dn
            if hit_dn:                      # stop first (also the both-touched case)
                res, d, lab, exit_px = "stop", k, 0, dn
                break
            if hit_up:
                res, d, lab, exit_px = "win", k, 1, up
                break

        if exit_px is None:                 # timeout: mark to close at the horizon
            exit_px = close[t + H]

        label[t]   = lab
        outcome[t] = res
        days[t]    = d
        ret[t]     = exit_px / entry - 1.0

    return label, outcome, days, ret
