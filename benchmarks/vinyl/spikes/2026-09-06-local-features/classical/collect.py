"""Merge every experiment's output into one results.json."""
import json, os
import numpy as np

D = os.path.dirname(os.path.abspath(__file__))


def j(p):
    return json.load(open(f'{D}/{p}'))


def strip_records(o):
    for d in o['detectors'].values():
        for v in d.values():
            v.pop('records', None)
    return o


hs = j('raw_hsanity.json')
P = hs['pairs']
gate = {}
for T in (8, 15, 20, 30, 50):
    gate[str(T)] = {
        'within_accept_inliers_only': float(np.mean([p['inliers'] >= T for p in P if p['same_album']])),
        'cross_accept_inliers_only': float(np.mean([p['inliers'] >= T for p in P if not p['same_album']])),
        'within_accept_with_H': float(np.mean([p['inliers'] >= T and p['h_ok'] for p in P if p['same_album']])),
        'cross_accept_with_H': float(np.mean([p['inliers'] >= T and p['h_ok'] for p in P if not p['same_album']])),
    }

out = {
    'machine': 'Apple M1 Max, single process, cv2.setNumThreads(1), opencv-python-headless 4.14.0',
    'params': {'ratio_test': 0.75, 'ransac_reproj_px': 5.0, 'residual_grid': '16x16',
               'residual_norm': 'per-block mean/std, std floor 0.03'},
    'exp1_verification_native': j('results_verify_native.json'),
    'exp1_verification_250px': j('results_verify_250.json'),
    'exp1b_homography_sanity_gate': strip_records(j('raw_hsanity_exp1.json')),
    'exp2_timing': j('results_timing.json'),
    'exp3_pressing_synthetic': j('results_pressing.json'),
    'exp3_pressing_synthetic_localized': j('results_pressing_localized.json'),
    'exp3b_real_pressings': j('results_real.json'),
    'exp3b_real_pressings_gate': {'per_threshold': gate,
                                  'keypoints_per_image': hs['keypoints'],
                                  'pairs': P},
}
json.dump(out, open(f'{D}/results.json', 'w'), indent=1)
print('wrote results.json', os.path.getsize(f'{D}/results.json'), 'bytes')
