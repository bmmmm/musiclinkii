"""Experiment 1 + 2: keypoint verification of vinyl-cover candidates.

For every detector, match all 130 queries (65 mild + 65 hard) against all 65
originals, run RANSAC homography, count inliers, and derive separation stats.
Usage: exp1_verify.py <scale|native> <out.json>
"""
import cv2, json, os, sys, time
import numpy as np

cv2.setNumThreads(1)
BASE = '/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/'
RATIO = 0.75
REPROJ = 5.0


def detectors():
    return {
        'ORB500': (cv2.ORB_create(nfeatures=500), cv2.NORM_HAMMING),
        'ORB1500': (cv2.ORB_create(nfeatures=1500), cv2.NORM_HAMMING),
        'AKAZE': (cv2.AKAZE_create(), cv2.NORM_HAMMING),
        'SIFT': (cv2.SIFT_create(), cv2.NORM_L2),
    }


def load(path, scale):
    """scale = None -> native, else longest side scaled to `scale` px."""
    img = cv2.imread(BASE + path, cv2.IMREAD_GRAYSCALE)
    if scale:
        h, w = img.shape
        f = scale / max(h, w)
        img = cv2.resize(img, (max(1, round(w * f)), max(1, round(h * f))),
                         interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_LINEAR)
    return img


def features(det, img):
    kp, desc = det.detectAndCompute(img, None)
    pts = np.float32([k.pt for k in kp]).reshape(-1, 1, 2) if kp else np.zeros((0, 1, 2), np.float32)
    return pts, desc


def inliers(bf, qpts, qdesc, cpts, cdesc):
    """ratio-test matches + RANSAC homography -> (n_good, n_inliers)."""
    if qdesc is None or cdesc is None or len(qdesc) < 2 or len(cdesc) < 2:
        return 0, 0
    m = bf.knnMatch(qdesc, cdesc, k=2)
    good = [a for pair in m if len(pair) == 2 for a, b in [pair] if a.distance < RATIO * b.distance]
    if len(good) < 4:
        return len(good), 0
    src = np.float32([qpts[g.queryIdx] for g in good]).reshape(-1, 1, 2)
    dst = np.float32([cpts[g.trainIdx] for g in good]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, REPROJ)
    if H is None or mask is None:
        return len(good), 0
    return len(good), int(mask.sum())


def main():
    scale = None if sys.argv[1] == 'native' else int(sys.argv[1])
    out_path = sys.argv[2]
    only = sys.argv[3].split(',') if len(sys.argv) > 3 else None
    idx = json.load(open(BASE + 'index.json'))
    rows = idx['rows']
    names = [r['name'] for r in rows]

    imgs_c = [load(r['original'], scale) for r in rows]
    imgs_q = {v: [load(r[v], scale) for r in rows] for v in ('mild', 'hard')}

    result = {'scale': sys.argv[1], 'ratio': RATIO, 'reproj': REPROJ, 'names': names, 'detectors': {}}
    for dname, (det, norm) in detectors().items():
        if only and dname not in only:
            continue
        t0 = time.perf_counter()
        cand = [features(det, im) for im in imgs_c]
        t_cand = (time.perf_counter() - t0) / len(imgs_c)
        bf = cv2.BFMatcher(norm)
        d = {'kp_candidates': [len(p) for p, _ in cand],
             'detect_ms_candidate': t_cand * 1e3, 'variants': {}}
        for v in ('mild', 'hard'):
            t0 = time.perf_counter()
            qf = [features(det, im) for im in imgs_q[v]]
            t_q = (time.perf_counter() - t0) / len(qf)
            mat = np.zeros((len(rows), len(rows)), np.int32)
            gmat = np.zeros((len(rows), len(rows)), np.int32)
            t0 = time.perf_counter()
            for i, (qp, qd) in enumerate(qf):
                for j, (cp, cd) in enumerate(cand):
                    g, n = inliers(bf, qp, qd, cp, cd)
                    gmat[i, j] = g
                    mat[i, j] = n
            t_pair = (time.perf_counter() - t0) / (len(rows) ** 2)
            d['variants'][v] = {
                'inliers': mat.tolist(), 'good': gmat.tolist(),
                'kp_query': [len(p) for p, _ in qf],
                'detect_ms_query': t_q * 1e3, 'match_ransac_ms_pair': t_pair * 1e3,
            }
            print(f'{dname} {v} scale={sys.argv[1]} done ({t_pair*1e3:.1f} ms/pair)', flush=True)
        result['detectors'][dname] = d
    json.dump(result, open(out_path, 'w'))
    print('wrote', out_path)


if __name__ == '__main__':
    main()
