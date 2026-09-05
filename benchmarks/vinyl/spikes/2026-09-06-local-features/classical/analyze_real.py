"""Analyze real Cover Art Archive pressing pairs (exp 3b) against the exp3 controls."""
import json, sys
import numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from analyze3b import mapstats, sweep  # noqa: E402


def main():
    real = json.load(open(sys.argv[1]))
    synth = json.load(open(sys.argv[2]))
    out = {'per_album': {}, 'failures': [], 'cross_album': {}, 'sweeps': {}}
    keys = ['max', 'median', 'excess_max_minus_median', 'z_robust', 'ratio_max_over_median']

    aligned = [r for r in real['within'] if r.get('aligned')]
    failed = [r for r in real['within'] if not r.get('aligned')]
    out['n_within'] = len(real['within'])
    out['n_aligned'] = len(aligned)
    out['failures'] = [{'album': r['album'], 'a': r['a'], 'b': r['b'], 'inliers': r['inliers']}
                       for r in failed]

    by_album = {}
    for r in real['within']:
        by_album.setdefault(r['album'], []).append(r)
    for a, rs in by_album.items():
        al = [r for r in rs if r.get('aligned')]
        e = {'n_pairs': len(rs), 'n_aligned': len(al),
             'inliers': {'min': min(r['inliers'] for r in rs),
                         'median': float(np.median([r['inliers'] for r in rs])),
                         'max': max(r['inliers'] for r in rs)}}
        for k in ('max', 'p95', 'median'):
            v = np.array([r['residual'][k] for r in al])
            e['residual_' + k] = {'min': float(v.min()), 'median': float(np.median(v)),
                                  'p90': float(np.percentile(v, 90)), 'max': float(v.max())}
        for st in ('excess', 'z_robust', 'ratio'):
            pass
        out['per_album'][a] = e

    # derived localization stats from the aggregate stats we stored
    def loc(r):
        s = r['residual']
        med = s['median']
        return {'max': s['max'], 'median': med, 'p95': s['p95'],
                'excess_max_minus_median': s['max'] - med,
                'ratio_max_over_median': s['max'] / (med + 0.02),
                'frac_ge_0.9': s['frac_ge']['0.9'], 'frac_ge_1.1': s['frac_ge']['1.1']}

    L = [loc(r) for r in aligned]
    out['real_pressing_pairs'] = {k: {'min': float(np.min([x[k] for x in L])),
                                      'median': float(np.median([x[k] for x in L])),
                                      'p90': float(np.percentile([x[k] for x in L], 90)),
                                      'max': float(np.max([x[k] for x in L]))}
                                  for k in L[0]}

    # controls from exp3: mild_vs_orig and hard_vs_orig
    ctrl = {'mild_vs_orig': [], 'hard_vs_orig': []}
    for r in synth['rows']:
        for l in ctrl:
            c = r['cases'][l]
            if c.get('aligned'):
                s = mapstats(c['map'])
                ctrl[l].append(s)
    out['controls'] = {l: {k: {'min': float(np.min([s[k] for s in v])),
                               'median': float(np.median([s[k] for s in v])),
                               'p90': float(np.percentile([s[k] for s in v], 90)),
                               'max': float(np.max([s[k] for s in v]))}
                           for k in ('max', 'median', 'excess_max_minus_median',
                                     'ratio_max_over_median')}
                       for l, v in ctrl.items()}

    # sweeps: positives = real different-pressing pairs, negatives = mild+hard controls
    for k in ('max', 'median', 'p95', 'excess_max_minus_median', 'ratio_max_over_median'):
        if k == 'p95':
            pos = np.array([x['p95'] for x in L])
            neg = np.array([np.percentile(np.array([[np.nan if y is None else y for y in row]
                                                    for row in r['cases'][l]['map']], float)[
                lambda a: ~np.isnan(a)], 95) for l in ctrl for r in []]) if False else None
            continue
        pos = np.array([x[k] for x in L])
        neg = np.array([s[k] for l in ctrl for s in ctrl[l]])
        b = sweep(pos, neg)
        b.update({'pos_min': float(pos.min()), 'pos_median': float(np.median(pos)),
                  'neg_max': float(neg.max()), 'neg_median': float(np.median(neg)),
                  'separable': bool(pos.min() > neg.max())})
        out['sweeps'][k] = b

    ca = real['cross']
    out['cross_album'] = {'n': len(ca), 'n_aligned_ge8': int(sum(1 for r in ca if r['aligned'])),
                          'inliers_median': float(np.median([r['inliers'] for r in ca])),
                          'inliers_max': int(max(r['inliers'] for r in ca)),
                          'inliers_p99': float(np.percentile([r['inliers'] for r in ca], 99))}
    json.dump(out, open(sys.argv[3], 'w'), indent=1)

    print('within-album pairs:', out['n_within'], 'aligned(inl>=8):', out['n_aligned'])
    print(f"\n{'album':28} {'pairs':>5} {'algn':>4} {'inlMin':>6} {'inlMed':>7} {'inlMax':>7} "
          f"{'resMaxMed':>9} {'resMedMed':>9}")
    for a, e in out['per_album'].items():
        print(f"{a:28} {e['n_pairs']:5d} {e['n_aligned']:4d} {e['inliers']['min']:6d} "
              f"{e['inliers']['median']:7.0f} {e['inliers']['max']:7d} "
              f"{e['residual_max']['median']:9.3f} {e['residual_median']['median']:9.3f}")
    print('\nfailures (inliers < 8):')
    for f in out['failures']:
        print(' ', f['album'], f['a'][:8], f['b'][:8], 'inl=', f['inliers'])
    print('\nreal different-pressing pairs, aggregate:')
    print(json.dumps(out['real_pressing_pairs'], indent=1))
    print('\ncontrols (exp3 mild/hard vs orig):')
    print(json.dumps(out['controls'], indent=1))
    print(f"\n{'statistic':26} {'best t':>8} {'tp':>3} {'fn':>3} {'fp':>3} {'tn':>3} {'acc':>6} "
          f"{'posMin':>8} {'negMax':>8} sep")
    for k, b in out['sweeps'].items():
        print(f"{k:26} {b['t']:8.3f} {b['tp']:3d} {b['fn']:3d} {b['fp']:3d} {b['tn']:3d} "
              f"{b['acc']:6.3f} {b['pos_min']:8.3f} {b['neg_max']:8.3f} {b['separable']}")
    print('\ncross-album control:', json.dumps(out['cross_album']))


if __name__ == '__main__':
    main()
