"""Contact sheets for the real-pressing albums + exact measurement of what the
resize(256)+center-crop(224) preprocessing keeps of the synthetic catno/sticker overlays."""
import glob
import json
import os

import numpy as np
from PIL import Image, ImageDraw

SCRATCH = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(os.path.dirname(SCRATCH), "verify")
RP = os.path.join(DATA, "real-pressings")

META = {}
for line in open(os.path.join(RP, "download.log")):
    p = line.split()
    if len(p) >= 6 and p[4] == "200":
        META[p[1]] = f"{p[2]} {p[3]}"

for alb in ("The_Dark_Side_of_the_Moon", "Abbey_Road", "Rumours"):
    fs = sorted(glob.glob(os.path.join(RP, alb, "*.jpg")))
    sheet = Image.new("RGB", (4 * 200, 2 * 220), (30, 30, 30))
    d = ImageDraw.Draw(sheet)
    for i, f in enumerate(fs):
        im = Image.open(f).convert("RGB")
        lab = f"{META.get(os.path.basename(f)[:-4],'?')} {im.size[0]}x{im.size[1]}"
        im = im.resize((196, 196), Image.BICUBIC)
        sheet.paste(im, ((i % 4) * 200 + 2, (i // 4) * 220 + 2))
        d.text(((i % 4) * 200 + 4, (i // 4) * 220 + 202), lab, fill=(255, 255, 0))
    sheet.save(os.path.join(SCRATCH, f"sheet-{alb}.png"))
    print("wrote", f"sheet-{alb}.png")

# ---- what survives the center crop? --------------------------------------
KEYS = json.load(open(os.path.join(SCRATCH, "keys.json")))
KI = {k: i for i, k in enumerate(KEYS)}
PIX = np.load(os.path.join(SCRATCH, "pixels.npy"))
IDX = json.load(open(os.path.join(DATA, "index.json")))
ROWS = [r for r in IDX["rows"] if "catno" in r]

out = {}
for kind in ("catno", "sticker"):
    rows_touched, patchrows, fracs = [], [], []
    for r in ROWS:
        o, p = KI[f"{r['name']}|original"], KI[f"{r['name']}|{kind}"]
        d = np.abs(PIX[o] - PIX[p]).max(0)                        # [224,224]
        rr = np.where(d.max(1) > 0.02)[0]
        rows_touched.append(len(rr))
        patchrows.append(sorted({int(x) // 14 for x in rr}))
        fracs.append(float((d > 0.02).mean()))
    out[kind] = {
        "input_rows_changed_of_224": {"min": int(min(rows_touched)), "median": float(np.median(rows_touched)),
                                      "max": int(max(rows_touched))},
        "patch_rows_touched_example": patchrows[0],
        "frac_of_224x224_pixels_changed_median": float(np.median(fracs)),
    }
# geometry of the crop, stated exactly
out["crop_geometry"] = {
    "note": "500 px square -> resize shortest edge 256 -> center crop 224",
    "visible_fraction_of_original": [16 / 256, 240 / 256],
    "catno_strip_in_original": [0.93, 1.0],
    "catno_strip_visible_fraction_of_strip": max(0.0, (0.9375 - 0.93)) / 0.07,
    "catno_strip_height_in_224px": (0.9375 - 0.93) / 0.875 * 224,
    "sticker_bbox_in_original": [0.08, 0.24],
    "sticker_fully_visible": True,
}
print(json.dumps(out, indent=1))
R = json.load(open(os.path.join(SCRATCH, "results.json")))
R["step4_crop_geometry"] = out
json.dump(R, open(os.path.join(SCRATCH, "results.json"), "w"), indent=1)
