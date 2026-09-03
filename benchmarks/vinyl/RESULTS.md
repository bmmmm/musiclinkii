# Vinyl retrieval result — 2026-09-03

Status: preliminary feasibility result, not a production accuracy claim.

## Dataset

- 12 vinyl releases selected from 130 deterministic MusicBrainz candidates.
- Cover images came from Cover Art Archive; Discogs supplied release identity
  and the popularity filter, not images.
- Discogs collection counts range from 2 to 77; wantlist counts range from 1 to
  28. The configured ceilings were 100 and 30.
- Release dates range from 1962 to 2013 and cover Brazil, the Netherlands,
  Canada, Great Britain, Australia, and Japan.
- Seed: `240824`; no Discogs token; all API requests were serial and cached.

The images and live manifest remain under `.cache/vinyl-benchmark/` and are not
committed.

This developer-only corpus is not a production import path. The application
continues to process only an image explicitly selected by the person using the
scanner, entirely in that browser; the visual fallback must not add an image
upload or proxy.

## Measured in Chrome

Model: `Xenova/dinov2-small`, Transformers.js 4.2.0, q4 weights, 384-dimensional
CLS embedding, normalized and stored as signed Int8.

| Run | Model load | Mean inference | Mild recall@1 / @5 | Hard recall@1 / @5 |
|---|---:|---:|---:|---:|
| Final serialized-transfer run, cached model | 1,284 ms | 3,018 ms/image | 12/12 / 12/12 | 12/12 / 12/12 |

An earlier cold-cache instrumentation run loaded the model in 20,729 ms and
averaged 3,050 ms/image. Every measured run produced median rank 1 for both
variants. On the final run, the lowest hard-query cosine score was 0.691 and the
smallest winning margin over the second result was 0.276.

The encoded vector index was 4,620 bytes: a 12-byte header plus 12 × 384 bytes.
The browser decoded that serialized Int8 representation before ranking; the
page also exposed the index and metadata as separate downloadable files.

## Interpretation

This is enough evidence to keep the OCR-first hybrid design:

1. Run OCR first and use readable artist/title text to query the catalog.
2. Run visual retrieval when OCR is empty, weak, or yields no confident album.
3. Merge both candidate lists and always ask the person scanning to confirm the
   cover; never silently select a pressing.

The result does not establish real-camera accuracy. All queries were generated
from their own reference covers with deterministic crop, rotation, shear,
brightness, glare, and JPEG changes, and there were only 11 distractors per
query. The next gate is a held-out set of real phone photos, including sleeves,
wear, stickers, partial occlusion, reflections, and multiple pressings that use
identical artwork. Until that gate exists, this remains a technical spike.

## Product integration check — 2026-09-04

The first production slice reranks only an explicit set of two to five OCR
candidates. In Chrome, a Queen `Greatest Hits II` catalog cover began at rank 2
for the deliberately ambiguous text `Queen Greatest Hits`; after the optional
local comparison it moved to rank 1 among five candidates. A `Greatest Hits`
cover stayed at rank 1 in the corresponding control. Both runs fetched five
Deezer thumbnails without CORS or console errors, and neither selected the
album until its candidate button was clicked.

This verifies the application wiring and a real correction, not phone-camera
accuracy: both query images were clean 500 px catalog covers. Zero-text covers
still need the separately shippable global vector index tested above.
