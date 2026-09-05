"""Re-analysis of exp3 residual maps with localization statistics.

An overlay (catno strip, PROMO sticker) is a CONCENTRATED patch of high residual
on an otherwise flat field; phone-variant noise (glare/resample/JPEG) is spread
over the whole map. So the discriminative statistic is the max relative to the
field, not the absolute max.
"""
import json, sys
import numpy as np

LABELS = ['catno_vs_orig', 'sticker_vs_orig', 'mild_vs_orig', 'hard_vs_orig',
          'hard_vs_catno', 'hard_vs_sticker']


def mapstats(m):
    a = np.array([[np.nan if x is None else x for x in row] for row in m], float)
    v = a[~np.isnan(a)]
    med = float(np.median(v))
    mad = float(np.median(np.abs(v - med)))
    return {
        'max': float(v.max()), 'p95': float(np.percentile(v, 95)),
        'p90': float(np.percentile(v, 90)), 'median': med, 'mad': mad,
        'excess_max_minus_median': float(v.max() - med),
        'z_robust': float((v.max() - med) / (mad + 0.02)),
        'ratio_max_over_median': float(v.max() / (med + 0.02)),
        'n_above_med_plus_0.5': int((v >= med + 0.5).sum()),
        'frac_above_med_plus_0.5': float((v >= med + 0.5).mean()),
        'n_valid': int(v.size),
    }


def sweep(pos, neg, higher_is_positive=True):
    cands = np.unique(np.concatenate([pos, neg]))
    best = None
    for t in np.concatenate([cands, (cands[:-1] + cands[1:]) / 2]) if len(cands) > 1 else cands:
        tp = int((pos >= t).sum()); fp = int((neg >= t).sum())
        fn = len(pos) - tp; tn = len(neg) - fp
        acc = (tp + tn) / (len(pos) + len(neg))
        if best is None or acc > best['acc'] or (acc == best['acc'] and fp < best['fp']):
            best = {'t': float(t), 'tp': tp, 'fn': fn, 'fp': fp, 'tn': tn, 'acc': acc}
    return best


def main():
    raw = json.load(open(sys.argv[1]))
    rows = raw['rows']
    per = {l: [] for l in LABELS}
    for r in rows:
        for l in LABELS:
            c = r['cases'][l]
            if c.get('aligned'):
                s = mapstats(c['map'])
                s['inliers'] = c['inliers']
                s['name'] = r['name']
                per[l].append(s)
    keys = ['max', 'median', 'excess_max_minus_median', 'z_robust',
            'ratio_max_over_median', 'n_above_med_plus_0.5']
    out = {'per_case': {}}
    for l in LABELS:
        e = {'n': len(per[l])}
        for k in keys:
            a = np.array([s[k] for s in per[l]], float)
            e[k] = {'min': float(a.min()), 'median': float(np.median(a)),
                    'p90': float(np.percentile(a, 90)), 'max': float(a.max())}
        e['inliers_median'] = float(np.median([s['inliers'] for s in per[l]]))
        out['per_case'][l] = e

    out['sweeps'] = {}
    for k in keys:
        pos = np.array([s[k] for s in per['catno_vs_orig']] + [s[k] for s in per['sticker_vs_orig']])
        neg = np.array([s[k] for s in per['mild_vs_orig']] + [s[k] for s in per['hard_vs_orig']])
        b = sweep(pos, neg)
        b.update({'pos_min': float(pos.min()), 'pos_median': float(np.median(pos)),
                  'neg_max': float(neg.max()), 'neg_median': float(np.median(neg)),
                  'separable': bool(pos.min() > neg.max())})
        out['sweeps'][k] = b
    json.dump(out, open(sys.argv[2], 'w'), indent=1)

    print(f"{'case':17} {'n':>2} | " + ' '.join(f'{k[:13]:>13}' for k in keys) + '   inl')
    for l in LABELS:
        e = out['per_case'][l]
        print(f"{l:17} {e['n']:2d} | " + ' '.join(f"{e[k]['median']:13.3f}" for k in keys)
              + f"  {e['inliers_median']:5.0f}")
    print('\n(medians above; sweeps below: positives = catno+sticker overlays, negatives = mild+hard photo variants)')
    print(f"{'statistic':26} {'best t':>8} {'tp':>3} {'fn':>3} {'fp':>3} {'tn':>3} {'acc':>6} {'posMin':>7} {'negMax':>7} sep")
    for k in keys:
        b = out['sweeps'][k]
        print(f"{k:26} {b['t']:8.3f} {b['tp']:3d} {b['fn']:3d} {b['fp']:3d} {b['tn']:3d} "
              f"{b['acc']:6.3f} {b['pos_min']:7.3f} {b['neg_max']:7.3f} {b['separable']}")


if __name__ == '__main__':
    main()
