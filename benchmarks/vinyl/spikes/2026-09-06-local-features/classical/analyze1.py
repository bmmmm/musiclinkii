"""Turn a raw inlier matrix from exp1_verify.py into the reported metrics."""
import json, sys
import numpy as np

RNG = np.random.default_rng(0)
T = 8


def top5_random(mat, draws=200):
    """Recall@1 in a realistic top-5: true original + 4 random distractors."""
    n = mat.shape[0]
    hit = 0
    tot = 0
    for i in range(n):
        others = np.array([j for j in range(n) if j != i])
        for _ in range(draws):
            pick = RNG.choice(others, 4, replace=False)
            tot += 1
            if mat[i, i] > mat[i, pick].max():
                hit += 1
    return hit / tot


def analyze(mat):
    mat = np.asarray(mat)
    n = mat.shape[0]
    true = np.array([mat[i, i] for i in range(n)])
    false_best = np.array([np.max(np.delete(mat[i], i)) for i in range(n)])
    # hardest-4 top-5 == full recall@1 (the hardest 4 contain the max false)
    recall1 = float((mat.argmax(axis=1) == np.arange(n)).mean())
    strict = float((true > false_best).mean())
    return {
        'n': int(n),
        'recall1_full65': recall1,
        'recall1_strict_gt': strict,
        'recall1_top5_hardest4': strict,
        'recall1_top5_random4': top5_random(mat),
        'true_min': int(true.min()), 'true_p10': float(np.percentile(true, 10)),
        'true_median': float(np.median(true)), 'true_max': int(true.max()),
        'false_median': float(np.median(false_best)),
        'false_p90': float(np.percentile(false_best, 90)),
        'false_max': int(false_best.max()),
        'separation_min_true_minus_max_false': int(true.min() - false_best.max()),
        'per_query_margin_min': int((true - false_best).min()),
        'n_true_below_8': int((true < T).sum()),
        'n_false_best_ge_8': int((false_best >= T).sum()),
        'accept_correct_at_T8': int(((true >= T) & (true > false_best)).sum()),
        'true_inliers': true.tolist(),
        'false_best_inliers': false_best.tolist(),
    }


def main():
    raw = json.load(open(sys.argv[1]))
    out = {'scale': raw['scale'], 'detectors': {}}
    for d, v in raw['detectors'].items():
        e = {'kp_candidate_median': float(np.median(v['kp_candidates'])),
             'detect_ms_candidate': v['detect_ms_candidate'], 'variants': {}}
        for var, vv in v['variants'].items():
            a = analyze(vv['inliers'])
            a['kp_query_median'] = float(np.median(vv['kp_query']))
            a['detect_ms_query'] = vv['detect_ms_query']
            a['match_ransac_ms_pair'] = vv['match_ransac_ms_pair']
            e['variants'][var] = a
        out['detectors'][d] = e
    json.dump(out, open(sys.argv[2], 'w'), indent=1)
    # console table
    hdr = f"{'det':9} {'var':5} {'R@1/65':>7} {'R@1 t5rnd':>9} {'trueMin':>7} {'trueP10':>7} {'trueMed':>7} {'flsMed':>6} {'flsP90':>6} {'flsMax':>6} {'sep':>5} {'<8':>3} {'fls>=8':>6}"
    print(hdr)
    for d, e in out['detectors'].items():
        for var, a in e['variants'].items():
            print(f"{d:9} {var:5} {a['recall1_full65']:7.3f} {a['recall1_top5_random4']:9.4f} "
                  f"{a['true_min']:7d} {a['true_p10']:7.1f} {a['true_median']:7.1f} "
                  f"{a['false_median']:6.1f} {a['false_p90']:6.1f} {a['false_max']:6d} "
                  f"{a['separation_min_true_minus_max_false']:5d} {a['n_true_below_8']:3d} {a['n_false_best_ge_8']:6d}")


if __name__ == '__main__':
    main()
