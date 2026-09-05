"""Step 1: extract full [257,384] DINOv2-small (q4 ONNX) token matrices for every test image."""
import json
import os
import time

import numpy as np
import onnxruntime as ort
from PIL import Image
from transformers import AutoImageProcessor
from huggingface_hub import hf_hub_download

SCRATCH = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SCRATCH), "verify")
IDX = json.load(open(os.path.join(DATA, "index.json")))

# ---- build the work list -------------------------------------------------
keys, paths = [], []
for row in IDX["rows"]:
    for kind in ("original", "mild", "hard", "catno", "sticker"):
        if kind in row:
            keys.append(f"{row['name']}|{kind}")
            paths.append(os.path.join(DATA, row[kind]))
print(f"images: {len(keys)}", flush=True)

proc = AutoImageProcessor.from_pretrained("Xenova/dinov2-small")
mp = hf_hub_download("Xenova/dinov2-small", "onnx/model_q4.onnx")
sess = ort.InferenceSession(mp, ort.SessionOptions(), providers=["CPUExecutionProvider"])
iname = sess.get_inputs()[0].name
print(f"model {os.path.getsize(mp)/1e6:.1f} MB  in={iname} out={[o.name for o in sess.get_outputs()]}", flush=True)

N = len(keys)
tokens = np.zeros((N, 257, 384), np.float32)
pixels = np.zeros((N, 3, 224, 224), np.float32)
t_pre, t_inf = [], []

# warm-up
warm = proc(images=[Image.open(paths[0]).convert("RGB")], return_tensors="np")["pixel_values"].astype(np.float32)
sess.run(None, {iname: warm})
sess.run(None, {iname: warm})

for i, p in enumerate(paths):
    t0 = time.perf_counter()
    px = proc(images=[Image.open(p).convert("RGB")], return_tensors="np")["pixel_values"].astype(np.float32)
    t1 = time.perf_counter()
    out = sess.run(None, {iname: px})[0]
    t2 = time.perf_counter()
    tokens[i] = out[0]
    pixels[i] = px[0]
    t_pre.append(t1 - t0)
    t_inf.append(t2 - t1)
    if (i + 1) % 50 == 0:
        print(f"  {i+1}/{N}", flush=True)

np.save(os.path.join(SCRATCH, "tokens.npy"), tokens)
np.save(os.path.join(SCRATCH, "pixels.npy"), pixels)
json.dump(keys, open(os.path.join(SCRATCH, "keys.json"), "w"))

pre, inf = np.array(t_pre) * 1000, np.array(t_inf) * 1000
timing = {
    "n_images": N,
    "preprocess_ms": {"mean": float(pre.mean()), "median": float(np.median(pre)), "p90": float(np.percentile(pre, 90))},
    "inference_ms": {"mean": float(inf.mean()), "median": float(np.median(inf)), "p90": float(np.percentile(inf, 90))},
    "total_ms_per_image": float((pre + inf).mean()),
    "img_per_s": float(1000.0 / (pre + inf).mean()),
    "tokens_shape": list(tokens.shape),
    "model_bytes": os.path.getsize(mp),
}
json.dump(timing, open(os.path.join(SCRATCH, "timing_extract.json"), "w"), indent=1)
print(json.dumps(timing, indent=1))
