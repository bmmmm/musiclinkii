"""Step 4: pressing-overlay detection via per-patch cosine at the same grid position."""
import json
import os

import cv2
import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download

SCRATCH = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SCRATCH), "verify")
IDX = json.load(open(os.path.join(DATA, "index.json")))
KEYS = json.load(open(os.path.join(SCRATCH, "keys.json")))
KI = {k: i for i, k in enumerate(KEYS)}
TOK = np.load(os.path.join(SCRATCH, "tokens.npy"))
PIX = np.load(os.path.join(SCRATCH, "pixels.npy"))
ROWS = [r for r in IDX["rows"] if "catno" in r]
print(f"pressing rows: {len(ROWS)}")


def l2(a, axis=-1):
    return a / np.maximum(np.linalg.norm(a, axis=axis, keepdims=True), 1e-12)


PATCH = l2(TOK[:, 1:, :])
GI = np.arange(256)
GXY = np.stack([((GI % 16) + 0.5) * 14.0, ((GI // 16) + 0.5) * 14.0], 1).astype(np.float32)

mp = hf_hub_download("Xenova/dinov2-small", "onnx/model_q4.onnx")
sess = ort.InferenceSession(mp, ort.SessionOptions(), providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name


def tokens_of(px):  # px [3,224,224] float32
    return sess.run(None, {iname: px[None]})[0][0]


def homography(qi, ci):
    """RANSAC homography mapping query-image 224-coords -> candidate-image 224-coords."""
    S = PATCH[qi] @ PATCH[ci].T
    rmax = S.max(1); cidx = S.argmax(1); ridx = S.argmax(0)
    mutual = ridx[cidx] == np.arange(256)
    sel = np.where(mutual & (rmax > 0.5))[0]
    if len(sel) < 4:
        return None, len(sel), 0
    H, mask = cv2.findHomography(GXY[sel], GXY[cidx[sel]], cv2.RANSAC, 20.0)
    return H, len(sel), int(mask.sum()) if mask is not None else 0


def warp_tokens(qi, H):
    """Warp query's preprocessed 224 image into the candidate frame, re-run the model."""
    img = np.transpose(PIX[qi], (1, 2, 0))                      # HWC, ImageNet-normalized
    w = cv2.warpPerspective(img, H, (224, 224), flags=cv2.INTER_LINEAR,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    m = cv2.warpPerspective(np.ones((224, 224), np.float32), H, (224, 224), flags=cv2.INTER_NEAREST,
                            borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    valid = m.reshape(16, 14, 16, 14).mean((1, 3)).reshape(256) >= 0.95
    return l2(tokens_of(np.ascontiguousarray(np.transpose(w, (2, 0, 1))))[1:]), valid


def stats(pcos, valid=None):
    v = pcos if valid is None else pcos[valid]
    if len(v) == 0:
        return None
    return {"min": float(v.min()), "p1": float(np.percentile(v, 1)), "p5": float(np.percentile(v, 5)),
            "median": float(np.median(v)), "n_below_0.5": int((v < 0.5).sum()),
            "n_below_0.6": int((v < 0.6).sum()), "n_below_0.7": int((v < 0.7).sum()),
            "n_valid": int(len(v))}


# how much of each overlay even survives resize(256)+centercrop(224)?
def pixel_delta_patches(a, b, eps=0.02):
    d = np.abs(PIX[a] - PIX[b]).max(0)                          # [224,224]
    pp = d.reshape(16, 14, 16, 14).max((1, 3)).reshape(256)
    return int((pp > eps).sum()), float(d.max()), float((d > eps).mean())


res = {"catno": [], "sticker": [], "mild": [], "hard": [], "crop_survival": {"catno": [], "sticker": []}}
for r in ROWS:
    oi = KI[f"{r['name']}|original"]
    for kind in ("catno", "sticker"):
        pi = KI[f"{r['name']}|{kind}"]
        pcos = (PATCH[oi] * PATCH[pi]).sum(1)
        res[kind].append(stats(pcos) | {"name": r["name"]})
        npx, dmax, frac = pixel_delta_patches(oi, pi)
        res["crop_survival"][kind].append({"name": r["name"], "patches_touched": npx,
                                           "max_pixel_delta": dmax, "frac_pixels_changed": frac})
    for kind in ("mild", "hard"):
        qi = KI[f"{r['name']}|{kind}"]
        H, nsel, ninl = homography(qi, oi)
        if H is None:
            res[kind].append({"name": r["name"], "failed": "too few MNN"})
            continue
        wp, valid = warp_tokens(qi, H)
        pcos = (PATCH[oi] * wp).sum(1)
        res[kind].append(stats(pcos, valid) | {"name": r["name"], "mnn": nsel, "ransac_inliers": ninl})
    print(".", end="", flush=True)
print()


def agg(lst, field):
    v = np.array([x[field] for x in lst if field in x], float)
    return {"min": float(v.min()), "p10": float(np.percentile(v, 10)), "median": float(np.median(v)),
            "p90": float(np.percentile(v, 90)), "max": float(v.max()), "n": len(v)}


summary = {}
for kind in ("catno", "sticker", "mild", "hard"):
    summary[kind] = {f: agg(res[kind], f) for f in ("min", "p1", "n_below_0.5", "n_below_0.6", "n_below_0.7")}
    summary[kind]["n_valid"] = agg(res[kind], "n_valid")
summary["crop_survival"] = {k: agg(res["crop_survival"][k], "patches_touched") for k in ("catno", "sticker")}
summary["crop_survival"]["catno_frac_pixels_changed"] = agg(res["crop_survival"]["catno"], "frac_pixels_changed")
summary["crop_survival"]["sticker_frac_pixels_changed"] = agg(res["crop_survival"]["sticker"], "frac_pixels_changed")


def sweep(field, lower_is_positive):
    """positives = catno+sticker (overlay present), negatives = mild+hard (same pressing)."""
    pos = np.array([x[field] for x in res["catno"] + res["sticker"]], float)
    neg = np.array([x[field] for x in res["mild"] + res["hard"] if field in x], float)
    cand = np.unique(np.concatenate([pos, neg]))
    best = (-1, None, None)
    for t in cand:
        if lower_is_positive:
            tp = int((pos <= t).sum()); fp = int((neg <= t).sum())
        else:
            tp = int((pos >= t).sum()); fp = int((neg >= t).sum())
        fn = len(pos) - tp; tn = len(neg) - fp
        acc = (tp + tn) / (len(pos) + len(neg))
        if acc > best[0]:
            best = (acc, float(t), (tp, fn, fp, tn))
    return {"best_acc": best[0], "threshold": best[1], "confusion_tp_fn_fp_tn": best[2],
            "pos": {"min": float(pos.min()), "median": float(np.median(pos)), "max": float(pos.max())},
            "neg": {"min": float(neg.min()), "median": float(np.median(neg)), "max": float(neg.max())},
            "n_pos": len(pos), "n_neg": len(neg)}


summary["detector"] = {
    "min_patch_cos (lower=overlay)": sweep("min", True),
    "n_below_0.5 (higher=overlay)": sweep("n_below_0.5", False),
    "n_below_0.6 (higher=overlay)": sweep("n_below_0.6", False),
    "n_below_0.7 (higher=overlay)": sweep("n_below_0.7", False),
}
# sticker-only detector (catno strip is mostly cropped away, see crop_survival)
for label, positives in (("sticker_only", res["sticker"]), ("catno_only", res["catno"])):
    pos = np.array([x["min"] for x in positives], float)
    neg = np.array([x["min"] for x in res["mild"] + res["hard"] if "min" in x], float)
    cand = np.unique(np.concatenate([pos, neg]))
    best = (-1, None, None)
    for t in cand:
        tp = int((pos <= t).sum()); fp = int((neg <= t).sum())
        fn = len(pos) - tp; tn = len(neg) - fp
        acc = (tp + tn) / (len(pos) + len(neg))
        if acc > best[0]:
            best = (acc, float(t), (tp, fn, fp, tn))
    summary["detector"][f"min_patch_cos_{label}"] = {
        "best_acc": best[0], "threshold": best[1], "confusion_tp_fn_fp_tn": best[2],
        "pos": {"min": float(pos.min()), "median": float(np.median(pos)), "max": float(pos.max())},
        "neg": {"min": float(neg.min()), "median": float(np.median(neg)), "max": float(neg.max())}}

R = json.load(open(os.path.join(SCRATCH, "results_part1.json")))
R["step4_pressing_detection"] = summary
R["step4_per_image"] = res
json.dump(R, open(os.path.join(SCRATCH, "results.json"), "w"), indent=1)
print(json.dumps(summary, indent=1))
