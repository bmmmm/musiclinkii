"""Analyze the pressing residual maps: is there a threshold that flags overlays
(catno / sticker) without flagging honest mild/hard photo variants?"""
import json, sys
import numpy as np


def frac_above(m, t):
    v = np.array([x for row in m for x in row if x is not None])
    return float((v >= t).mean()), v


def main():
    raw = json.load(open(sys.argv[1]))
    rows = raw['rows']
    labels = ['catno_vs_orig', 'sticker_vs_orig', 'mild_vs_orig', 'hard_vs_orig',
              'hard_vs_catno', 'hard_vs_sticker']
    out = {'detector': raw['detector'], 'per_case': {}, 'threshold_sweep': {}, 'per_row': []}
    maxes = {l: [] for l in labels}
    inl = {l: [] for l in labels}
    reg = {l: [] for l in labels}
    for r in rows:
        rec = {'name': r['name']}
        for l in labels:
            c = r['cases'][l]
            if not c.get('aligned'):
                rec[l] = None
                continue
            maxes[l].append(c['max'])
            inl[l].append(c['inliers'])
            if 'max_in_region' in c:
                reg[l].append((c['max_in_region'], c['max_out_region'], c['p95_out_region']))
            rec[l] = {'max': c['max'], 'p95': c['p95'], 'median': c['median'],
                      'in_region': c.get('max_in_region'), 'out_region': c.get('max_out_region')}
        out['per_row'].append(rec)

    for l in labels:
        a = np.array(maxes[l])
        e = {'n': len(a), 'max_block_residual': {'min': float(a.min()), 'median': float(np.median(a)),
             'p90': float(np.percentile(a, 90)), 'max': float(a.max())},
             'align_inliers_median': float(np.median(inl[l]))}
        if reg[l]:
            g = np.array(reg[l])
            e['max_in_overlay_region'] = {'min': float(g[:, 0].min()), 'median': float(np.median(g[:, 0]))}
            e['max_outside_region'] = {'median': float(np.median(g[:, 1])), 'max': float(g[:, 1].max())}
            e['n_region_beats_outside'] = int((g[:, 0] > g[:, 1]).sum())
        out['per_case'][l] = e

    # threshold sweep on the max block residual: positives = catno/sticker vs orig,
    # negatives = mild/hard vs orig
    pos = np.array(maxes['catno_vs_orig'] + maxes['sticker_vs_orig'])
    neg = np.array(maxes['mild_vs_orig'] + maxes['hard_vs_orig'])
    cands = np.unique(np.concatenate([pos, neg]))
    best = None
    sweep = []
    for t in np.linspace(cands.min(), cands.max(), 400):
        tp = int((pos >= t).sum()); fn = len(pos) - tp
        fp = int((neg >= t).sum()); tn = len(neg) - fp
        acc = (tp + tn) / (len(pos) + len(neg))
        sweep.append({'t': float(t), 'tp': tp, 'fn': fn, 'fp': fp, 'tn': tn, 'acc': acc})
        if best is None or (acc > best['acc']) or (acc == best['acc'] and fp < best['fp']):
            best = sweep[-1]
    out['threshold_sweep'] = {'best': best,
                              'pos_min': float(pos.min()), 'pos_median': float(np.median(pos)),
                              'neg_max': float(neg.max()), 'neg_median': float(np.median(neg)),
                              'separable': bool(pos.min() > neg.max())}

    # frac-of-blocks-above variant at a fixed residual threshold
    for t in (0.5, 0.7, 0.9, 1.1, 1.3):
        fr = {}
        for l in labels:
            vals = []
            for r in rows:
                c = r['cases'][l]
                if c.get('aligned'):
                    f, _ = frac_above(c['map'], t)
                    vals.append(f)
            fr[l] = {'median': float(np.median(vals)), 'p90': float(np.percentile(vals, 90)),
                     'max': float(np.max(vals))}
        out.setdefault('frac_above', {})[str(t)] = fr

    # hard version: does the overlay still stand out inside a hard-variant comparison?
    hv = {}
    for l in ('hard_vs_catno', 'hard_vs_sticker'):
        wins = 0; margins = []; base = []
        for r in rows:
            c = r['cases'][l]; b = r['cases']['hard_vs_orig']
            if not (c.get('aligned') and b.get('aligned')):
                continue
            m_in = c['max_in_region']; m_out = c['max_out_region']
            wins += int(m_in > m_out)
            margins.append(m_in - m_out)
            base.append(b['max'])
        hv[l] = {'n': len(margins), 'overlay_beats_own_noise': wins,
                 'margin_median': float(np.median(margins)), 'margin_min': float(np.min(margins)),
                 'baseline_hard_vs_orig_max_median': float(np.median(base))}
    out['hard_overlay'] = hv
    json.dump(out, open(sys.argv[2], 'w'), indent=1)

    print(f"{'case':18} {'n':>3} {'maxRes min':>10} {'med':>6} {'p90':>6} {'max':>6} {'alignInl':>8}")
    for l in labels:
        e = out['per_case'][l]; m = e['max_block_residual']
        print(f"{l:18} {e['n']:3d} {m['min']:10.3f} {m['median']:6.3f} {m['p90']:6.3f} {m['max']:6.3f} {e['align_inliers_median']:8.0f}")
    print()
    print('best threshold on max block residual:', json.dumps(out['threshold_sweep'], indent=1))
    print('hard overlay:', json.dumps(hv, indent=1))


if __name__ == '__main__':
    main()
