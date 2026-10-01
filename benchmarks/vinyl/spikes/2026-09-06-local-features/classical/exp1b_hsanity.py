"""Does the H-plausibility gate remove the high-inlier FALSE pairs of exp1?

For each query take the true original and the single worst false candidate
(argmax inliers) and re-run the match, recording inliers + whether H is a sane
mapping of the query frame onto the candidate frame.
Usage: exp1b_hsanity.py <raw_native.json> <scale|native> <out.json>
"""
import cv2, json, sys
import numpy as np
sys.path.insert(0, __file__.rsplit('/', 1)[0])
from exp1_verify import load, BASE  # noqa: E402
from exp3c_hsanity import h_plausible, match  # noqa: E402

cv2.setNumThreads(1)
DETS = {'ORB500': (lambda: cv2.ORB_create(nfeatures=500), cv2.NORM_HAMMING),
        'ORB1500': (lambda: cv2.ORB_create(nfeatures=1500), cv2.NORM_HAMMING),
        'AKAZE': (cv2.AKAZE_create, cv2.NORM_HAMMING),
        'SIFT': (cv2.SIFT_create, cv2.NORM_L2)}


def main():
    raw = json.load(open(sys.argv[1]))
    scale = None if sys.argv[2] == 'native' else int(sys.argv[2])
    idx = json.load(open(BASE + 'index.json'))
    rows = idx['rows']
    out = {'scale': sys.argv[2], 'detectors': {}}
    for dname, det_data in raw['detectors'].items():
        factory, norm = DETS[dname]
        det = factory()
        bf = cv2.BFMatcher(norm)
        e = {}
        for var, vv in det_data['variants'].items():
            m = np.array(vv['inliers'])
            recs = []
            for i, r in enumerate(rows):
                off = m[i].copy(); off[i] = -1
                j = int(off.argmax())
                q = load(r[var], scale)
                for tag, k in (('true', i), ('false', j)):
                    c = load(rows[k]['original'], scale)
                    H, good, inl = match(det, bf, q, c)
                    ok, info = h_plausible(H, q.shape, c.shape)
                    recs.append({'query': r['name'], 'kind': tag, 'cand': rows[k]['name'],
                                 'good': good, 'inliers': inl, 'h_ok': bool(ok), **info})
            t = [x for x in recs if x['kind'] == 'true']
            f = [x for x in recs if x['kind'] == 'false']
            e[var] = {'records': recs,
                      'true_h_ok': int(sum(x['h_ok'] for x in t)), 'n': len(t),
                      'false_h_ok': int(sum(x['h_ok'] for x in f)),
                      'false_h_ok_and_ge8': int(sum(x['h_ok'] and x['inliers'] >= 8 for x in f)),
                      'false_max_inliers_h_ok': max([x['inliers'] for x in f if x['h_ok']] or [0]),
                      'true_min_inliers_h_ok': min([x['inliers'] for x in t if x['h_ok']] or [0])}
            print(f"{dname:8} {var:5} true H-ok {e[var]['true_h_ok']}/{e[var]['n']} | "
                  f"worst-false H-ok {e[var]['false_h_ok']}/{e[var]['n']} "
                  f"(and inl>=8: {e[var]['false_h_ok_and_ge8']}) | "
                  f"max false inl surviving = {e[var]['false_max_inliers_h_ok']} | "
                  f"min true inl surviving = {e[var]['true_min_inliers_h_ok']}", flush=True)
        out['detectors'][dname] = e
    json.dump(out, open(sys.argv[3], 'w'))


if __name__ == '__main__':
    main()
