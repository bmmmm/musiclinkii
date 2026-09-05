# Replicates benchmarks/vinyl/runner.mjs createVariant() (mild/hard) in PIL, plus
# simulated "same artwork, different pressing" covers (catalog strip + sticker).
import json, math, sys, os, glob
import numpy as np
from PIL import Image, ImageDraw, ImageFont
REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), *(['..'] * 5)))
SRC = os.path.join(REPO, '.cache', 'vinyl-benchmark', 'covers')
OUT = sys.argv[1]
SIZE = 640
def css_filter(img, brightness, contrast):
    a = np.asarray(img.convert('RGB')).astype(np.float32) / 255.0
    a = a * brightness
    a = (a - 0.5) * contrast + 0.5
    return Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8))
def glare(img, hard):
    w = h = SIZE
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    x0, y0, x1, y1 = 0.15 * w, 0.0, 0.85 * w, float(h)
    dx, dy = x1 - x0, y1 - y0
    t = ((xx - x0) * dx + (yy - y0) * dy) / (dx * dx + dy * dy)
    t = np.clip(t, 0, 1)
    mid, end, alpha = (0.62, 0.76, 0.30) if hard else (0.72, 0.82, 0.10)
    a = np.where(t <= mid, t / mid * alpha, np.where(t <= end, (end - t) / (end - mid) * alpha, 0.0))
    arr = np.asarray(img).astype(np.float32)
    arr = arr * (1 - a[..., None]) + 255.0 * a[..., None]
    return Image.fromarray(arr.astype(np.uint8))
def variant(src, hard, seed):
    angle = (-0.095 if hard else 0.035) * (1 if seed % 2 else -1)
    shear = (0.09 if hard else 0.025) * (-1 if seed % 3 == 0 else 1)
    scale = 1.17 if hard else 0.94
    brightness, contrast = (0.78, 1.14) if hard else (0.94, 1.04)
    bg = (0x1f, 0x1b, 0x18) if hard else (0x35, 0x30, 0x2b)
    tx = SIZE / 2 + (34 if hard else -8); ty = SIZE / 2 + (-18 if hard else 7)
    source = css_filter(src.resize((SIZE, SIZE), Image.BICUBIC), brightness, contrast)
    # canvas: translate(tx,ty) rotate(angle) transform(1,shear,-shear*.35,1) scale(s) drawImage(-320,-320)
    T = np.array([[1, 0, tx], [0, 1, ty], [0, 0, 1]], float)
    R = np.array([[math.cos(angle), -math.sin(angle), 0], [math.sin(angle), math.cos(angle), 0], [0, 0, 1]])
    Sh = np.array([[1, -shear * 0.35, 0], [shear, 1, 0], [0, 0, 1]])
    Sc = np.array([[scale, 0, 0], [0, scale, 0], [0, 0, 1]])
    T0 = np.array([[1, 0, -SIZE / 2], [0, 1, -SIZE / 2], [0, 0, 1]])
    M = T @ R @ Sh @ Sc @ T0
    Minv = np.linalg.inv(M)
    a, b, c = Minv[0]; d, e, f = Minv[1]
    out = source.transform((SIZE, SIZE), Image.AFFINE, data=(a, b, c, d, e, f), resample=Image.BICUBIC, fillcolor=bg)
    return glare(out, hard), 72 if hard else 88
def pressing(src, kind):
    img = src.convert('RGB').copy(); w, h = img.size; d = ImageDraw.Draw(img)
    try: font = ImageFont.load_default(size=int(h * 0.045))
    except TypeError: font = ImageFont.load_default()
    if kind == 'catno':
        d.rectangle([0, int(h * 0.93), w, h], fill=(0, 0, 0))
        d.text((int(w * 0.62), int(h * 0.94)), 'SHVL 804 · STEREO', fill=(255, 255, 255), font=font)
    else:
        r = int(w * 0.08); cx, cy = int(w * 0.16), int(h * 0.16)
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=(250, 240, 80), outline=(0, 0, 0))
        d.text((cx - int(r * 0.7), cy - int(r * 0.3)), 'PROMO', fill=(0, 0, 0), font=font)
    return img
files = sorted(glob.glob(f'{SRC}/*.jpg'))
index = []
for i, path in enumerate(files):
    name = os.path.basename(path)[:-4]
    src = Image.open(path).convert('RGB')
    src.save(f'{OUT}/originals/{name}.jpg', quality=95)
    row = {'name': name, 'original': f'originals/{name}.jpg'}
    for hard in (False, True):
        img, q = variant(src, hard, i)
        rel = f"variants/{name}-{'hard' if hard else 'mild'}.jpg"
        img.save(f'{OUT}/{rel}', quality=q); row['hard' if hard else 'mild'] = rel
    if i < 20:
        for kind in ('catno', 'sticker'):
            rel = f'pressings/{name}-{kind}.jpg'; pressing(src, kind).save(f'{OUT}/{rel}', quality=95); row[kind] = rel
    index.append(row)
json.dump({'size': SIZE, 'count': len(index), 'rows': index}, open(f'{OUT}/index.json', 'w'), indent=1)
print('wrote', len(index), 'rows')
