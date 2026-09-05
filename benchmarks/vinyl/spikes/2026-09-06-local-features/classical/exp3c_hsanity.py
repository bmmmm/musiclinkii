"""Does a geometric sanity check on H kill the cross-album false positives?

Warps A's corners through H and demands a convex, non-degenerate, plausibly
scaled quad. Run over the real-pressing set (within = same artwork / different
pressing, cross = different artwork).
"""
import cv2, glob, itertools, json, os, sys
import numpy as np

cv2.setNumThreads(1)
ROOT = ('/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/'
        'b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/real-pressings')


def h_plausible(H, shape_a, shape_b):
    """True if H maps A's frame to a sane quad inside B's coordinate system."""
    if H is None or not np.isfinite(H).all():
        return False, {}
    ha, wa = shape_a
    hb, wb = shape_b
    c = np.float32([[0, 0], [wa, 0], [wa, ha], [0, ha]]).reshape(-1, 1, 2)
    q = cv2.perspectiveTransform(c, H).reshape(-1, 2)
    # convexity: all cross products same sign
    cr = []
    for i in range(4):
        a, b, d = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        u, v = b - a, d - b
        cr.append(float(u[0] * v[1] - u[1] * v[0]))
    convex = all(x > 0 for x in cr) or all(x < 0 for x in cr)
    area = 0.5 * abs(np.dot(q[:, 0], np.roll(q[:, 1], -1)) - np.dot(q[:, 1], np.roll(q[:, 0], -1)))
    area_ratio = area / (wb * hb)
    sides = [np.linalg.norm(q[(i + 1) % 4] - q[i]) for i in range(4)]
    ar = (max(sides[0], sides[2]) / max(1e-6, min(sides[0], sides[2])),
          max(sides[1], sides[3]) / max(1e-6, min(sides[1], sides[3])))
    info = {'area_ratio': float(area_ratio), 'convex': bool(convex),
            'opposite_side_ratio': float(max(ar))}
    ok = convex and 0.25 <= area_ratio <= 4.0 and max(ar) <= 2.0
    return ok, info


def match(det, bf, a, b):
    ka, da = det.detectAndCompute(a, None)
    kb, db = det.detectAndCompute(b, None)
    if da is None or db is None or len(da) < 2 or len(db) < 2:
        return None, 0, 0
    m = bf.knnMatch(da, db, k=2)
    good = [x for p in m if len(p) == 2 for x, y in [p] if x.distance < 0.75 * y.distance]
    if len(good) < 4:
        return None, len(good), 0
    src = np.float32([ka[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
    dst = np.float32([kb[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    return H, len(good), (0 if mask is None else int(mask.sum()))


def main():
    det = cv2.SIFT_create()
    bf = cv2.BFMatcher(cv2.NORM_L2)
    files = []
    for d in sorted(os.listdir(ROOT)):
        if os.path.isdir(f'{ROOT}/{d}'):
            files += [(d, f) for f in sorted(glob.glob(f'{ROOT}/{d}/*.jpg'))]
    imgs = {f: cv2.imread(f, cv2.IMREAD_GRAYSCALE) for _, f in files}
    kps = {f: len(det.detect(imgs[f], None)) for _, f in files}
    out = {'keypoints': {os.path.basename(f)[:-4]: {'album': a, 'kp': kps[f],
                                                    'size': list(imgs[f].shape)}
                         for a, f in files},
           'pairs': []}
    for (a1, f1), (a2, f2) in itertools.combinations(files, 2):
        H, good, inl = match(det, bf, imgs[f1], imgs[f2])
        ok, info = h_plausible(H, imgs[f1].shape, imgs[f2].shape)
        out['pairs'].append({'same_album': a1 == a2, 'album_a': a1, 'album_b': a2,
                             'a': os.path.basename(f1)[:-4], 'b': os.path.basename(f2)[:-4],
                             'good': good, 'inliers': inl, 'h_ok': bool(ok), **info})
    json.dump(out, open(sys.argv[1], 'w'), indent=1)
    P = out['pairs']
    w = np.array([p['inliers'] for p in P if p['same_album']])
    c = np.array([p['inliers'] for p in P if not p['same_album']])
    wf = np.array([p['inliers'] for p in P if p['same_album'] and p['h_ok']])
    print('within n=%d, cross n=%d' % (len(w), len(c)))
    print(f"{'rule':38} {'within-accept':>13} {'cross-accept':>12}")
    for T in (8, 15, 20, 30, 50):
        wa = float((w >= T).mean())
        ca = float((c >= T).mean())
        wah = float(np.mean([p['inliers'] >= T and p['h_ok'] for p in P if p['same_album']]))
        cah = float(np.mean([p['inliers'] >= T and p['h_ok'] for p in P if not p['same_album']]))
        print(f"inliers>={T:<3d}                            {wa:13.3f} {ca:12.3f}")
        print(f"inliers>={T:<3d} AND H plausible            {wah:13.3f} {cah:12.3f}")
    print('\nkeypoints per image (SIFT):')
    for n, v in sorted(out['keypoints'].items(), key=lambda x: (x[1]['album'], x[1]['kp'])):
        print(f"  {v['album']:26} {n[:8]} {v['size']} kp={v['kp']}")


if __name__ == '__main__':
    main()
