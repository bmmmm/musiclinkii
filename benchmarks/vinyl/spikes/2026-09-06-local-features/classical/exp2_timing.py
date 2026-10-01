"""Experiment 2: single-process timings on this machine.

detect+describe per image at native / 320 / 250 px, match+RANSAC per pair,
and the derived cost of one query verified against 5 candidates.
"""
import cv2, json, sys, time
import numpy as np

cv2.setNumThreads(1)
BASE = '/private/tmp/claude-501/-Users-bma-offline-coding-musiclinkii/b199e6f2-b49a-44be-8352-6bdebd2fce96/scratchpad/verify/'
DETS = {'ORB500': (lambda: cv2.ORB_create(nfeatures=500), cv2.NORM_HAMMING),
        'ORB1500': (lambda: cv2.ORB_create(nfeatures=1500), cv2.NORM_HAMMING),
        'AKAZE': (cv2.AKAZE_create, cv2.NORM_HAMMING),
        'SIFT': (cv2.SIFT_create, cv2.NORM_L2)}
SCALES = {'native': None, '320': 320, '250': 250}
N = 30  # images used per timing measurement


def load(p, s):
    img = cv2.imread(BASE + p, cv2.IMREAD_GRAYSCALE)
    if s:
        h, w = img.shape
        f = s / max(h, w)
        img = cv2.resize(img, (round(w * f), round(h * f)),
                         interpolation=cv2.INTER_AREA if f < 1 else cv2.INTER_LINEAR)
    return img


def main():
    idx = json.load(open(BASE + 'index.json'))
    rows = idx['rows'][:N]
    out = {}
    for dname, (factory, norm) in DETS.items():
        det = factory()
        bf = cv2.BFMatcher(norm)
        e = {'detect_ms': {}, 'kp': {}, 'match_ransac_ms_pair': {}, 'query_ms_5cands': {}}
        for sname, s in SCALES.items():
            cands = [load(r['original'], s) for r in rows]
            queries = [load(r['hard'], s if s else None) for r in rows]
            # warm-up
            det.detectAndCompute(cands[0], None)
            t0 = time.perf_counter()
            fc = [det.detectAndCompute(im, None) for im in cands]
            t_c = (time.perf_counter() - t0) / len(cands) * 1e3
            t0 = time.perf_counter()
            fq = [det.detectAndCompute(im, None) for im in queries]
            t_q = (time.perf_counter() - t0) / len(queries) * 1e3
            e['detect_ms'][sname] = {'candidate': t_c, 'query': t_q}
            e['kp'][sname] = {'candidate': float(np.median([len(k) for k, _ in fc])),
                              'query': float(np.median([len(k) for k, _ in fq]))}
            # match+RANSAC per pair: 5 candidates per query, mixed true/false
            pairs = 0
            t0 = time.perf_counter()
            for i, (kq, dq) in enumerate(fq):
                for j in range(5):
                    kc, dc = fc[(i + j) % len(fc)]
                    if dq is None or dc is None or len(dq) < 2 or len(dc) < 2:
                        continue
                    m = bf.knnMatch(dq, dc, k=2)
                    good = [a for p in m if len(p) == 2 for a, b in [p] if a.distance < 0.75 * b.distance]
                    if len(good) >= 4:
                        src = np.float32([kq[g.queryIdx].pt for g in good]).reshape(-1, 1, 2)
                        dst = np.float32([kc[g.trainIdx].pt for g in good]).reshape(-1, 1, 2)
                        cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
                    pairs += 1
            t_p = (time.perf_counter() - t0) / pairs * 1e3
            e['match_ransac_ms_pair'][sname] = t_p
            # one query vs 5 candidates, candidate features assumed cached
            e['query_ms_5cands'][sname] = {'features_cached': t_q + 5 * t_p,
                                           'features_cold': t_q + 5 * (t_c + t_p)}
            print(f'{dname} {sname}: det c={t_c:.1f} q={t_q:.1f} pair={t_p:.2f} '
                  f'query5={t_q + 5*t_p:.1f}ms', flush=True)
        out[dname] = e
    json.dump(out, open(sys.argv[1], 'w'), indent=1)


if __name__ == '__main__':
    main()
