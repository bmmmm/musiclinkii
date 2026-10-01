"""Step 3b: global-threshold (accept/reject) analysis, since recall@1-of-5 saturates at 1.0."""
import json
import os

import numpy as np

SCRATCH = os.path.dirname(os.path.abspath(__file__))
raw = json.load(open(os.path.join(SCRATCH, "pairs_raw.json")))
R = json.load(open(os.path.join(SCRATCH, "results_part1.json")))
SCORE_KEYS = ["mnn50", "mnn60", "mnn70", "rowmax_mean", "inl_h", "inl_a"]


def roc(pos, neg):
    """pos/neg: 1-D arrays, higher = more 'true'. Returns AUC, best-acc threshold, TPR@0FP."""
    pos, neg = np.asarray(pos, float), np.asarray(neg, float)
    order = np.argsort(np.concatenate([pos, neg]))
    lab = np.concatenate([np.ones(len(pos)), np.zeros(len(neg))])[order]
    vals = np.concatenate([pos, neg])[order]
    # AUC via rank statistic (ties averaged)
    ranks = np.empty(len(vals))
    i = 0
    while i < len(vals):
        j = i
        while j + 1 < len(vals) and vals[j + 1] == vals[i]:
            j += 1
        ranks[i:j + 1] = (i + j) / 2.0 + 1
        i = j + 1
    auc = (ranks[lab == 1].sum() - len(pos) * (len(pos) + 1) / 2.0) / (len(pos) * len(neg))
    # best accuracy over all candidate thresholds
    cand = np.unique(np.concatenate([vals, [vals.min() - 1, vals.max() + 1]]))
    best = (-1, None, None, None)
    for t in cand:
        tp = int((pos >= t).sum()); fn = len(pos) - tp
        fp = int((neg >= t).sum()); tn = len(neg) - fp
        acc = (tp + tn) / (len(pos) + len(neg))
        if acc > best[0]:
            best = (acc, float(t), (tp, fn, fp, tn), None)
    # highest TPR with zero false accepts
    t0 = float(neg.max()) + 1e-9
    tpr0 = float((pos >= t0).mean())
    return {"auc": float(auc), "best_acc": float(best[0]), "best_threshold": best[1],
            "confusion_tp_fn_fp_tn": best[2], "tpr_at_zero_false_accept": tpr0,
            "threshold_for_zero_false_accept": t0,
            "d_prime": float((pos.mean() - neg.mean()) / np.sqrt(0.5 * (pos.var() + neg.var()) + 1e-12))}


out = {}
for kind in ("mild", "hard"):
    rows = raw[kind]
    d = {}
    pos = np.array([e["cls"][0] for e in rows])
    neg = np.array([e["cls"][j] for e in rows for j in range(1, 5)])
    d["cls_cos"] = roc(pos, neg) | {"n_pos": len(pos), "n_neg": len(neg)}
    for sk in SCORE_KEYS:
        pos = np.array([e["scores"][0][sk] for e in rows], float)
        neg = np.array([e["scores"][j][sk] for e in rows for j in range(1, 5)], float)
        d[sk] = roc(pos, neg) | {"n_pos": len(pos), "n_neg": len(neg)}
    out[kind] = d

# pooled mild+hard: one global threshold has to serve both
d = {}
rowsall = raw["mild"] + raw["hard"]
pos = np.array([e["cls"][0] for e in rowsall])
neg = np.array([e["cls"][j] for e in rowsall for j in range(1, 5)])
d["cls_cos"] = roc(pos, neg) | {"n_pos": len(pos), "n_neg": len(neg)}
for sk in SCORE_KEYS:
    pos = np.array([e["scores"][0][sk] for e in rowsall], float)
    neg = np.array([e["scores"][j][sk] for e in rowsall for j in range(1, 5)], float)
    d[sk] = roc(pos, neg) | {"n_pos": len(pos), "n_neg": len(neg)}
out["pooled"] = d

# per-query margin (true minus best false), scale-free comparison
marg = {}
for kind in ("mild", "hard"):
    rows = raw[kind]
    m = {}
    v = np.array([e["cls"][0] - max(e["cls"][1:]) for e in rows])
    m["cls_cos"] = {"min": float(v.min()), "p10": float(np.percentile(v, 10)), "median": float(np.median(v))}
    for sk in SCORE_KEYS:
        v = np.array([e["scores"][0][sk] - max(e["scores"][j][sk] for j in range(1, 5)) for e in rows], float)
        m[sk] = {"min": float(v.min()), "p10": float(np.percentile(v, 10)), "median": float(np.median(v))}
    marg[kind] = m

R["step3b_global_threshold"] = out
R["step3c_per_query_margin"] = marg
json.dump(R, open(os.path.join(SCRATCH, "results_part1.json"), "w"), indent=1)
for k in ("mild", "hard", "pooled"):
    print(f"=== {k} ===")
    for sk, vv in out[k].items():
        print(f"  {sk:12s} auc={vv['auc']:.4f} bestacc={vv['best_acc']:.4f} @t={vv['best_threshold']:.4g} "
              f"conf(tp,fn,fp,tn)={vv['confusion_tp_fn_fp_tn']} tpr@0FA={vv['tpr_at_zero_false_accept']:.3f} d'={vv['d_prime']:.2f}")
