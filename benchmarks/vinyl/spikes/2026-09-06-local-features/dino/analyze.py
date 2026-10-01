"""Steps 2, 3, 5: CLS baseline, patch-token verification scores, timing."""
import json
import os
import time

import cv2
import numpy as np

SCRATCH = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SCRATCH), "verify")
IDX = json.load(open(os.path.join(DATA, "index.json")))
KEYS = json.load(open(os.path.join(SCRATCH, "keys.json")))
TOK = np.load(os.path.join(SCRATCH, "tokens.npy"))
KI = {k: i for i, k in enumerate(KEYS)}
NAMES = [r["name"] for r in IDX["rows"]]
R = {}

# ---- normalized views ----------------------------------------------------
def l2(a, axis=-1):
    return a / np.maximum(np.linalg.norm(a, axis=axis, keepdims=True), 1e-12)

CLS = l2(TOK[:, 0, :])                      # [N,384]
PATCH = l2(TOK[:, 1:, :])                   # [N,256,384]

ORIG = np.array([KI[f"{n}|original"] for n in NAMES])            # [65]
O_CLS = CLS[ORIG]                                                # [65,384]

# patch-grid centres (patch size 14, 16x16 grid)
GI = np.arange(256)
GXY = np.stack([((GI % 16) + 0.5) * 14.0, ((GI // 16) + 0.5) * 14.0], 1).astype(np.float32)

# ---------------------------------------------------------------- step 2
step2 = {}
for kind in ("mild", "hard"):
    qi = np.array([KI[f"{n}|{kind}"] for n in NAMES])
    sim = CLS[qi] @ O_CLS.T                                      # [65,65]
    order = np.argsort(-sim, 1)
    top1 = order[:, 0] == np.arange(65)
    top5 = np.array([np.where(order[r] == r)[0][0] < 5 for r in range(65)])
    best = sim[np.arange(65), order[:, 0]]
    second = sim[np.arange(65), order[:, 1]]
    margin = best - second
    truesim = sim[np.arange(65), np.arange(65)]
    step2[kind] = {
        "recall@1": float(top1.mean()), "recall@5": float(top5.mean()),
        "margin_best_minus_second": {"min": float(margin.min()), "p10": float(np.percentile(margin, 10)),
                                     "median": float(np.median(margin))},
        "true_cls_cos": {"min": float(truesim.min()), "p10": float(np.percentile(truesim, 10)),
                         "median": float(np.median(truesim))},
        "n": 65,
    }
    print(kind, json.dumps(step2[kind]), flush=True)
R["step2_cls_baseline"] = step2

# ---------------------------------------------------------------- step 3
def pair_scores(q, c, with_ransac=True):
    """q,c: [256,384] L2-normalized patch tokens."""
    S = q @ c.T                                                  # [256,256]
    rmax = S.max(1)
    ci = S.argmax(1)                                             # best cand for each query patch
    ri = S.argmax(0)                                             # best query for each cand patch
    mutual = ri[ci] == np.arange(256)
    out = {"rowmax_mean": float(rmax.mean())}
    for t in (0.5, 0.6, 0.7):
        out[f"mnn{int(t*100)}"] = int(np.count_nonzero(mutual & (rmax > t)))
    if with_ransac:
        sel = np.where(mutual & (rmax > 0.5))[0]
        out["inl_h"] = 0
        out["inl_a"] = 0
        if len(sel) >= 4:
            src = GXY[sel]
            dst = GXY[ci[sel]]
            H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 20.0)
            if mask is not None:
                out["inl_h"] = int(mask.sum())
            A, maska = cv2.estimateAffine2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=20.0)
            if maska is not None:
                out["inl_a"] = int(maska.sum())
    return out

SCORE_KEYS = ["mnn50", "mnn60", "mnn70", "rowmax_mean", "inl_h", "inl_a"]
raw = {}
for kind in ("mild", "hard"):
    rows = []
    for r, name in enumerate(NAMES):
        q = KI[f"{name}|{kind}"]
        sims = CLS[q] @ O_CLS.T
        sims_false = sims.copy()
        sims_false[r] = -9
        false4 = np.argsort(-sims_false)[:4]
        cands = [r] + [int(x) for x in false4]
        entry = {"name": name, "cands": cands, "cls": [float(sims[c]) for c in cands], "scores": []}
        for c in cands:
            entry["scores"].append(pair_scores(PATCH[q], PATCH[ORIG[c]]))
        rows.append(entry)
        if (r + 1) % 20 == 0:
            print(f"  {kind} {r+1}/65", flush=True)
    raw[kind] = rows
json.dump(raw, open(os.path.join(SCRATCH, "pairs_raw.json"), "w"))


def summarize(rows, getter, higher_is_better=True):
    true_v, false_v, hit = [], [], []
    for e in rows:
        v = np.array([getter(e, j) for j in range(5)], float)
        t = v[0]
        f = v[1:]
        true_v.append(t)
        false_v.append(f.max() if higher_is_better else f.min())
        hit.append(bool(t > f.max()) if higher_is_better else bool(t < f.min()))
    true_v, false_v = np.array(true_v), np.array(false_v)
    return {
        "recall@1_of5": float(np.mean(hit)),
        "true": {"min": float(true_v.min()), "p10": float(np.percentile(true_v, 10)),
                 "median": float(np.median(true_v))},
        "best_false": {"median": float(np.median(false_v)), "p90": float(np.percentile(false_v, 90)),
                       "max": float(false_v.max())},
        "separation_minTrue_minus_maxFalse": float(true_v.min() - false_v.max()),
        "n_pairs_true_le_false": int(np.count_nonzero(~np.array(hit))),
    }

step3 = {}
for kind in ("mild", "hard"):
    rows = raw[kind]
    d = {"cls_cos": summarize(rows, lambda e, j: e["cls"][j])}
    for sk in SCORE_KEYS:
        d[sk] = summarize(rows, lambda e, j, sk=sk: e["scores"][j][sk])
    step3[kind] = d
R["step3_patch_verification"] = step3

# ---------------------------------------------------------------- step 5 timing
q = PATCH[KI[f"{NAMES[0]}|hard"]]
c = PATCH[ORIG[0]]
for _ in range(5):
    pair_scores(q, c)
t0 = time.perf_counter()
NIT = 200
for _ in range(NIT):
    pair_scores(q, c, with_ransac=False)
t_cos = (time.perf_counter() - t0) / NIT
t0 = time.perf_counter()
for _ in range(NIT):
    pair_scores(q, c, with_ransac=True)
t_full = (time.perf_counter() - t0) / NIT
R["step5_timing"] = {
    "numpy_cosine_plus_mnn_ms_per_pair": t_cos * 1000,
    "numpy_full_incl_ransac_ms_per_pair": t_full * 1000,
    "numpy_ransac_only_ms_per_pair": (t_full - t_cos) * 1000,
    "per_query_5_candidates_ms": t_full * 1000 * 5,
    "js_estimate": {
        "macs_per_pair": 256 * 256 * 384,
        "assumed_js_mac_per_s": 1e9,
        "js_matmul_ms_per_pair": 256 * 256 * 384 / 1e9 * 1000,
        "js_matmul_ms_per_query_5cand": 256 * 256 * 384 / 1e9 * 1000 * 5,
    },
    "extract": json.load(open(os.path.join(SCRATCH, "timing_extract.json"))),
}

json.dump(R, open(os.path.join(SCRATCH, "results_part1.json"), "w"), indent=1)
print(json.dumps(R["step3_patch_verification"], indent=1))
print(json.dumps(R["step5_timing"], indent=1))
