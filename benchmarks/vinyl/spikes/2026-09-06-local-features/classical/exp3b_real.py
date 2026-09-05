"""Experiment 3b: REAL Cover Art Archive pressings.

24 covers, 8 official 12" vinyl pressings each of three albums. For every
within-album pair (28 per album) align with SIFT+RANSAC and build the same
16x16 block residual map as exp3. Cross-album pairs serve as the
"different artwork" control.
Usage: exp3b_real.py <out.json>
"""
import cv2, glob, itertools, json, os, sys
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from exp3_pressing import homography, residual_map, GRID  # noqa: E402

cv2.setNumThreads(1)
ROOT = ('/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/'
        'b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/real-pressings')


def stats(R):
    v = R[~np.isnan(R)]
    if v.size == 0:
        return None
    return {'max': float(v.max()), 'p99': float(np.percentile(v, 99)),
            'p95': float(np.percentile(v, 95)), 'median': float(np.median(v)),
            'n_valid': int(v.size),
            'frac_ge': {str(t): float((v >= t).mean()) for t in (0.5, 0.7, 0.9, 1.1, 1.3)}}


def main():
    det = cv2.SIFT_create()
    bf = cv2.BFMatcher(cv2.NORM_L2)
    meta = {}
    for line in open(f'{ROOT}/download.log'):
        p = line.split()
        if len(p) >= 4 and p[3] == '200':
            meta[p[1]] = {'album': p[0], 'country': p[2], 'year': p[3 - 1]}
    albums = {}
    for d in sorted(os.listdir(ROOT)):
        if os.path.isdir(f'{ROOT}/{d}'):
            albums[d] = sorted(glob.glob(f'{ROOT}/{d}/*.jpg'))
    imgs = {}
    for a, fs in albums.items():
        for f in fs:
            im = cv2.imread(f, cv2.IMREAD_GRAYSCALE)
            imgs[f] = im
    out = {'detector': 'SIFT', 'grid': GRID,
           'images': {os.path.basename(f)[:-4]: {'album': a, 'size': list(imgs[f].shape)}
                      for a, fs in albums.items() for f in fs},
           'meta': {k: v for k, v in meta.items()},
           'within': [], 'cross': []}
    for a, fs in albums.items():
        for f1, f2 in itertools.combinations(fs, 2):
            H, inl = homography(det, bf, imgs[f1], imgs[f2])
            rec = {'album': a, 'a': os.path.basename(f1)[:-4], 'b': os.path.basename(f2)[:-4],
                   'inliers': inl, 'aligned': H is not None and inl >= 8}
            if rec['aligned']:
                rec['residual'] = stats(residual_map(imgs[f1], imgs[f2], H))
            out['within'].append(rec)
            print('within', a, rec['inliers'], flush=True)
    names = [(a, f) for a, fs in albums.items() for f in fs]
    for (a1, f1), (a2, f2) in itertools.combinations(names, 2):
        if a1 == a2:
            continue
        H, inl = homography(det, bf, imgs[f1], imgs[f2])
        out['cross'].append({'a_album': a1, 'b_album': a2, 'inliers': inl,
                             'aligned': H is not None and inl >= 8})
    json.dump(out, open(sys.argv[1], 'w'))
    print('wrote', sys.argv[1])


if __name__ == '__main__':
    main()
