"""Step 4b: 24 REAL Cover Art Archive pressings (3 albums x 8 official 12" vinyl pressings).

For every within-album pair: CLS cosine, the step-3 patch scores, and per-patch cosine
statistics both unaligned (same grid position) and after RANSAC-homography alignment.
"""
import glob
import json
import os
import time

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image
from transformers import AutoImageProcessor
from huggingface_hub import hf_hub_download

SCRATCH = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SCRATCH), "verify")
RP = os.path.join(DATA, "real-pressings")
ALBUMS = ["The_Dark_Side_of_the_Moon", "Abbey_Road", "Rumours"]
META = {}
for line in open(os.path.join(RP, "download.log")):
    p = line.split()          # album mbid country year http_status bytes
    if len(p) >= 6 and p[4] == "200":
        META[p[1]] = {"country": p[2], "year": p[3]}

proc = AutoImageProcessor.from_pretrained("Xenova/dinov2-small")
mp = hf_hub_download("Xenova/dinov2-small", "onnx/model_q4.onnx")
sess = ort.InferenceSession(mp, ort.SessionOptions(), providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name


def l2(a, axis=-1):
    return a / np.maximum(np.linalg.norm(a, axis=axis, keepdims=True), 1e-12)


def tokens_of_px(px):
    return sess.run(None, {iname: px[None]})[0][0]


# ---- step 1 for the 24 real pressings ------------------------------------
items, T, P = [], [], []
t0 = time.perf_counter()
for alb in ALBUMS:
    for f in sorted(glob.glob(os.path.join(RP, alb, "*.jpg"))):
        mbid = os.path.basename(f)[:-4]
        img = Image.open(f).convert("RGB")
        px = proc(images=[img], return_tensors="np")["pixel_values"].astype(np.float32)[0]
        T.append(tokens_of_px(px))
        P.append(px)
        items.append({"album": alb, "mbid": mbid, "size": list(img.size),
                      "country": META.get(mbid, {}).get("country"), "year": META.get(mbid, {}).get("year")})
t_extract = time.perf_counter() - t0
T = np.array(T, np.float32); P = np.array(P, np.float32)
np.save(os.path.join(SCRATCH, "tokens_real.npy"), T)
print(f"extracted {len(items)} real pressings in {t_extract:.1f}s ({t_extract/len(items)*1000:.1f} ms/img)")

CLS = l2(T[:, 0, :])
PATCH = l2(T[:, 1:, :])
GI = np.arange(256)
GXY = np.stack([((GI % 16) + 0.5) * 14.0, ((GI // 16) + 0.5) * 14.0], 1).astype(np.float32)


def pair_scores(qi, ci):
    S = PATCH[qi] @ PATCH[ci].T
    rmax = S.max(1); cidx = S.argmax(1); ridx = S.argmax(0)
    mutual = ridx[cidx] == np.arange(256)
    out = {"rowmax_mean": float(rmax.mean())}
    for t in (0.5, 0.6, 0.7):
        out[f"mnn{int(t*100)}"] = int(np.count_nonzero(mutual & (rmax > t)))
    sel = np.where(mutual & (rmax > 0.5))[0]
    out["inl_h"] = 0; out["inl_a"] = 0
    H = None
    if len(sel) >= 4:
        H, mask = cv2.findHomography(GXY[sel], GXY[cidx[sel]], cv2.RANSAC, 20.0)
        if mask is not None:
            out["inl_h"] = int(mask.sum())
        A, ma = cv2.estimateAffine2D(GXY[sel], GXY[cidx[sel]], method=cv2.RANSAC, ransacReprojThreshold=20.0)
        if ma is not None:
            out["inl_a"] = int(ma.sum())
    return out, H


def patch_stats(pcos, valid=None):
    v = pcos if valid is None else pcos[valid]
    if len(v) == 0:
        return None
    return {"min": float(v.min()), "p1": float(np.percentile(v, 1)), "median": float(np.median(v)),
            "n_below_0.5": int((v < 0.5).sum()), "n_below_0.6": int((v < 0.6).sum()),
            "n_below_0.7": int((v < 0.7).sum()), "n_valid": int(len(v))}


def aligned_stats(qi, ci, H):
    if H is None:
        return None
    img = np.transpose(P[qi], (1, 2, 0))
    w = cv2.warpPerspective(img, H, (224, 224), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    m = cv2.warpPerspective(np.ones((224, 224), np.float32), H, (224, 224), flags=cv2.INTER_NEAREST,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    valid = m.reshape(16, 14, 16, 14).mean((1, 3)).reshape(256) >= 0.95
    wt = l2(tokens_of_px(np.ascontiguousarray(np.transpose(w, (2, 0, 1))))[1:])
    return patch_stats((PATCH[ci] * wt).sum(1), valid)


pairs = []
for alb in ALBUMS:
    ix = [i for i, it in enumerate(items) if it["album"] == alb]
    for a in range(len(ix)):
        for b in range(a + 1, len(ix)):
            i, j = ix[a], ix[b]
            sc, H = pair_scores(i, j)
            e = {"album": alb, "a": items[i]["mbid"], "b": items[j]["mbid"],
                 "a_meta": f"{items[i]['country']}/{items[i]['year']}",
                 "b_meta": f"{items[j]['country']}/{items[j]['year']}",
                 "cls_cos": float(CLS[i] @ CLS[j]), "scores": sc,
                 "patch_unaligned": patch_stats((PATCH[i] * PATCH[j]).sum(1)),
                 "patch_aligned": aligned_stats(i, j, H)}
            pairs.append(e)
    print(f"  {alb}: {len(ix)} covers", flush=True)

# cross-album pairs = true negatives (different artwork)
cross = []
for a in range(len(items)):
    for b in range(a + 1, len(items)):
        if items[a]["album"] != items[b]["album"]:
            sc, _ = pair_scores(a, b)
            cross.append({"cls_cos": float(CLS[a] @ CLS[b]), "scores": sc})


def d(vals):
    v = np.array(vals, float)
    return {"min": float(v.min()), "p10": float(np.percentile(v, 10)), "median": float(np.median(v)),
            "p90": float(np.percentile(v, 90)), "max": float(v.max()), "n": len(v)}


SK = ["mnn50", "mnn60", "mnn70", "rowmax_mean", "inl_h", "inl_a"]
summary = {"n_covers": len(items), "extract_ms_per_image": t_extract / len(items) * 1000,
           "sizes": sorted({tuple(i["size"]) for i in items}.__iter__(), key=lambda x: x[0])}
summary["sizes"] = [list(s) for s in summary["sizes"]]

by_album = {}
for alb in ALBUMS:
    ps = [p for p in pairs if p["album"] == alb]
    by_album[alb] = {
        "n_pairs": len(ps),
        "cls_cos": d([p["cls_cos"] for p in ps]),
        **{sk: d([p["scores"][sk] for p in ps]) for sk in SK},
        "patch_unaligned_min": d([p["patch_unaligned"]["min"] for p in ps]),
        "patch_unaligned_n_below_0.5": d([p["patch_unaligned"]["n_below_0.5"] for p in ps]),
        "patch_aligned_min": d([p["patch_aligned"]["min"] for p in ps if p["patch_aligned"]]),
        "patch_aligned_n_below_0.5": d([p["patch_aligned"]["n_below_0.5"] for p in ps if p["patch_aligned"]]),
        "patch_aligned_n_valid": d([p["patch_aligned"]["n_valid"] for p in ps if p["patch_aligned"]]),
    }
summary["by_album"] = by_album
summary["all_within_album"] = {
    "n_pairs": len(pairs),
    "cls_cos": d([p["cls_cos"] for p in pairs]),
    **{sk: d([p["scores"][sk] for p in pairs]) for sk in SK},
    "patch_unaligned_min": d([p["patch_unaligned"]["min"] for p in pairs]),
    "patch_unaligned_n_below_0.5": d([p["patch_unaligned"]["n_below_0.5"] for p in pairs]),
    "patch_aligned_min": d([p["patch_aligned"]["min"] for p in pairs if p["patch_aligned"]]),
    "patch_aligned_n_below_0.5": d([p["patch_aligned"]["n_below_0.5"] for p in pairs if p["patch_aligned"]]),
}
summary["cross_album"] = {"n_pairs": len(cross), "cls_cos": d([c["cls_cos"] for c in cross]),
                          **{sk: d([c["scores"][sk] for c in cross]) for sk in SK}}

# --- comparison against the synthetic phone-variant controls (step 3 raw) ---
raw = json.load(open(os.path.join(SCRATCH, "pairs_raw.json")))
ctrl = {}
for kind in ("mild", "hard"):
    rows = raw[kind]
    ctrl[kind] = {"cls_cos": d([e["cls"][0] for e in rows]),
                  **{sk: d([e["scores"][0][sk] for e in rows]) for sk in SK}}
summary["phone_variant_controls_same_pressing"] = ctrl


def sep(pos, neg, lower_is_positive=False):
    """best single global threshold separating pos from neg."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    cand = np.unique(np.concatenate([pos, neg]))
    best = (-1, None, None)
    for t in cand:
        tp = int((pos <= t).sum()) if lower_is_positive else int((pos >= t).sum())
        fp = int((neg <= t).sum()) if lower_is_positive else int((neg >= t).sum())
        acc = (tp + (len(neg) - fp)) / (len(pos) + len(neg))
        if acc > best[0]:
            best = (acc, float(t), (tp, len(pos) - tp, fp, len(neg) - fp))
    return {"best_acc": best[0], "threshold": best[1], "confusion_tp_fn_fp_tn": best[2],
            "n_pos": len(pos), "n_neg": len(neg)}


# Q: can a score tell "different pressing of same album" (pos) from "phone photo of the very
#    same pressing" (neg)?  A working pressing-discriminator needs a clean separation.
disc = {}
for sk in ["cls_cos"] + SK:
    pos = [p["cls_cos"] if sk == "cls_cos" else p["scores"][sk] for p in pairs]
    neg = [e["cls"][0] if sk == "cls_cos" else e["scores"][0][sk]
           for kind in ("mild", "hard") for e in raw[kind]]
    disc[sk] = sep(pos, neg, lower_is_positive=True)
disc["patch_unaligned_min"] = sep([p["patch_unaligned"]["min"] for p in pairs],
                                  [x["min"] for x in json.load(open(os.path.join(SCRATCH, "results.json")))
                                   ["step4_per_image"]["mild"] + json.load(open(os.path.join(SCRATCH, "results.json")))
                                   ["step4_per_image"]["hard"] if "min" in x], lower_is_positive=True)
disc["patch_aligned_min"] = sep([p["patch_aligned"]["min"] for p in pairs if p["patch_aligned"]],
                                [x["min"] for x in json.load(open(os.path.join(SCRATCH, "results.json")))
                                 ["step4_per_image"]["mild"] + json.load(open(os.path.join(SCRATCH, "results.json")))
                                 ["step4_per_image"]["hard"] if "min" in x], lower_is_positive=True)
summary["pressing_vs_samepressing_discriminator"] = disc

R = json.load(open(os.path.join(SCRATCH, "results.json")))
R["step4b_real_pressings"] = summary
R["step4b_pairs"] = pairs
R["step4b_items"] = items
json.dump(R, open(os.path.join(SCRATCH, "results.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
