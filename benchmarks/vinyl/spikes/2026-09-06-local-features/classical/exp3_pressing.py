"""Experiment 3: detect a different pressing (overlay) by residual after alignment.

Align A onto B with a RANSAC homography, then build a 16x16 block residual map of
per-block mean/std normalized grayscale differences. Blocks that the warp does not
cover are invalid.
Usage: exp3_pressing.py <detector> <out.json>
"""
import cv2, json, sys
import numpy as np

cv2.setNumThreads(1)
BASE = '/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/'
GRID = 16
RATIO = 0.75
REPROJ = 5.0
STD_FLOOR = 0.03          # in 0..1 gray units, keeps flat blocks from exploding
MIN_VALID = 0.75          # a block needs this fraction of warped pixels to count

DETS = {'ORB500': (lambda: cv2.ORB_create(nfeatures=500), cv2.NORM_HAMMING),
        'ORB1500': (lambda: cv2.ORB_create(nfeatures=1500), cv2.NORM_HAMMING),
        'AKAZE': (cv2.AKAZE_create, cv2.NORM_HAMMING),
        'SIFT': (cv2.SIFT_create, cv2.NORM_L2)}


def homography(det, bf, a, b):
    ka, da = det.detectAndCompute(a, None)
    kb, db = det.detectAndCompute(b, None)
    if da is None or db is None or len(da) < 2 or len(db) < 2:
        return None, 0
    m = bf.knnMatch(da, db, k=2)
    good = [x for p in m if len(p) == 2 for x, y in [p] if x.distance < RATIO * y.distance]
    if len(good) < 4:
        return None, 0
    src = np.float32([ka[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
    dst = np.float32([kb[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, REPROJ)
    return H, (0 if mask is None else int(mask.sum()))


def residual_map(a, b, H):
    """Warp a into b's frame, return GRID x GRID residual map (NaN = invalid)."""
    h, w = b.shape
    wa = cv2.warpPerspective(a, H, (w, h), flags=cv2.INTER_LINEAR, borderValue=0)
    cov = cv2.warpPerspective(np.ones_like(a, np.uint8) * 255, H, (w, h), borderValue=0)
    A = wa.astype(np.float32) / 255.0
    B = b.astype(np.float32) / 255.0
    R = np.full((GRID, GRID), np.nan, np.float32)
    ys = np.linspace(0, h, GRID + 1).round().astype(int)
    xs = np.linspace(0, w, GRID + 1).round().astype(int)
    for gy in range(GRID):
        for gx in range(GRID):
            sl = (slice(ys[gy], ys[gy + 1]), slice(xs[gx], xs[gx + 1]))
            c = cov[sl]
            if c.size == 0 or (c > 127).mean() < MIN_VALID:
                continue
            pa, pb = A[sl], B[sl]
            na = (pa - pa.mean()) / max(pa.std(), STD_FLOOR)
            nb = (pb - pb.mean()) / max(pb.std(), STD_FLOOR)
            R[gy, gx] = float(np.abs(na - nb).mean())
    return R


def region_masks(shape):
    h, w = shape
    ys = np.linspace(0, h, GRID + 1).round().astype(int)
    xs = np.linspace(0, w, GRID + 1).round().astype(int)
    catno = np.zeros((GRID, GRID), bool)
    sticker = np.zeros((GRID, GRID), bool)
    cx, cy, r = 0.16 * w, 0.16 * h, 0.08 * w
    for gy in range(GRID):
        for gx in range(GRID):
            y0, y1, x0, x1 = ys[gy], ys[gy + 1], xs[gx], xs[gx + 1]
            if y1 > h * 0.93:
                catno[gy, gx] = True
            # block centre inside the sticker disc (plus a small margin)
            mx, my = (x0 + x1) / 2, (y0 + y1) / 2
            if (mx - cx) ** 2 + (my - cy) ** 2 <= (r * 1.15) ** 2:
                sticker[gy, gx] = True
    return {'catno': catno, 'sticker': sticker}


def stats(R, mask=None):
    v = R[~np.isnan(R)]
    out = {'max': float(v.max()) if v.size else None,
           'p99': float(np.percentile(v, 99)) if v.size else None,
           'p95': float(np.percentile(v, 95)) if v.size else None,
           'median': float(np.median(v)) if v.size else None,
           'n_valid': int(v.size)}
    if mask is not None:
        inm = R[mask & ~np.isnan(R)]
        outm = R[(~mask) & ~np.isnan(R)]
        out['max_in_region'] = float(inm.max()) if inm.size else None
        out['max_out_region'] = float(outm.max()) if outm.size else None
        out['p95_out_region'] = float(np.percentile(outm, 95)) if outm.size else None
    return out


def main():
    dname = sys.argv[1]
    out_path = sys.argv[2]
    factory, norm = DETS[dname]
    det = factory()
    bf = cv2.BFMatcher(norm)
    idx = json.load(open(BASE + 'index.json'))
    rows = [r for r in idx['rows'] if 'catno' in r]
    res = {'detector': dname, 'grid': GRID, 'std_floor': STD_FLOOR, 'rows': []}
    for r in rows:
        o = cv2.imread(BASE + r['original'], cv2.IMREAD_GRAYSCALE)
        masks = region_masks(o.shape)
        entry = {'name': r['name'], 'cases': {}}
        cases = [('catno_vs_orig', r['catno'], r['original'], 'catno'),
                 ('sticker_vs_orig', r['sticker'], r['original'], 'sticker'),
                 ('mild_vs_orig', r['mild'], r['original'], None),
                 ('hard_vs_orig', r['hard'], r['original'], None),
                 ('hard_vs_catno', r['hard'], r['catno'], 'catno'),
                 ('hard_vs_sticker', r['hard'], r['sticker'], 'sticker')]
        for label, pa, pb, mkey in cases:
            a = cv2.imread(BASE + pa, cv2.IMREAD_GRAYSCALE)
            b = cv2.imread(BASE + pb, cv2.IMREAD_GRAYSCALE)
            H, inl = homography(det, bf, a, b)
            if H is None:
                entry['cases'][label] = {'aligned': False, 'inliers': inl}
                continue
            R = residual_map(a, b, H)
            s = stats(R, masks[mkey] if mkey else None)
            s.update({'aligned': True, 'inliers': inl})
            s['map'] = [[None if np.isnan(x) else round(float(x), 4) for x in row] for row in R]
            entry['cases'][label] = s
        res['rows'].append(entry)
        print('done', r['name'], flush=True)
    json.dump(res, open(out_path, 'w'))
    print('wrote', out_path)


if __name__ == '__main__':
    main()
