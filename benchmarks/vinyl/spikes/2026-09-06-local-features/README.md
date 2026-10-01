# Spike 2026-09-06: local-feature verification and pressing disambiguation

Developer-only record of the experiments summarised in
`docs/vinyl-index-plan.md` ("Prüfstufe mit lokalen Merkmalen"). Nothing here is
loaded by the application.

- `data/make-variants.py` regenerates the mild/hard phone-like variants and the
  synthetic pressing overlays from `.cache/vinyl-benchmark/covers/*.jpg`
  (produced by `scripts/build-vinyl-benchmark.mjs`); `data/index.json` lists the
  generated files. `data/candidates.json` and `data/download.log` hold the
  MusicBrainz release ids of the 24 real Cover Art Archive pressings
  (`https://coverartarchive.org/release/<mbid>/front-500`). Images are
  third-party cover art and are not committed.
- `classical/` — ORB, AKAZE, SIFT with OpenCV 4.14 (`opencv-python-headless<5`;
  OpenCV 5 dropped AKAZE), RANSAC homography, plausibility gate, block-residual
  pressing tests. `results.json` is the aggregate written by `collect.py`.
- `dino/` — DINOv2-small q4 ONNX patch tokens (`Xenova/dinov2-small`,
  onnxruntime CPU), mutual-nearest-neighbour and RANSAC scores, per-patch
  pressing tests. `results.json` holds every reported number.

The scripts were written against a session scratch directory; the absolute
paths at the top of each file must be pointed at a local copy of the generated
images before rerunning. Python via `uv venv --python 3.12` with numpy, pillow,
opencv-python-headless<5, onnxruntime, transformers.
