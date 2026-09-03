# Vinyl cover retrieval benchmark

This benchmark answers one narrow question: can a compact visual index recover
the correct vinyl release from a phone-like cover image when OCR is insufficient?
It does not replace OCR. It measures the proposed fallback independently.

## Data path

The sampler uses only documented public paths:

1. Search MusicBrainz for official album releases whose physical format is
   vinyl.
2. Download the 500 px front image from Cover Art Archive.
3. Follow the MusicBrainz URL relation to a Discogs release.
4. Keep only releases below explicit Discogs collection and wantlist ceilings.

Discogs images are deliberately not downloaded: image access requires
authentication and has separate usage constraints. Discogs contributes the
physical-release identity and long-tail signal; Cover Art Archive supplies the
benchmark image. HTTP responses and covers are cached locally, all requests are
serial, MusicBrainz stays below one request per second, and unauthenticated
Discogs requests stay below 25 per minute. The optional `DISCOGS_TOKEN`
environment variable raises the allowance but is never printed or stored.

The defaults define long-tail as at most 100 Discogs collection owners and at
most 30 wantlist entries. They sample structured MusicBrainz result pages below
the first third before applying that explicit filter. Popularity is therefore
measured, not inferred from artist names.

```sh
node scripts/build-vinyl-benchmark.mjs --count 24 --seed 240824
python3 -m http.server 8000
# Open http://localhost:8000/benchmarks/vinyl/
```

The generated dataset lives under `.cache/vinyl-benchmark/` and is ignored by
Git. It contains third-party cover art and must not be committed.

## Browser index

Microsoft's Record Scanner describes the same architectural split with a
Transformers.js ViT embedding in the browser and vector search on the server.
This benchmark deliberately tests the static-site variant: DINOv2-small has a
384-dimensional output and its quantized browser model is substantially smaller
than the 768-dimensional ViT used in that article. The searchable cover index
is downloaded or generated separately from the model.

The harness loads `Xenova/dinov2-small` through Transformers.js, extracts its
384-dimensional CLS embedding, normalizes it, and stores each reference as 384
signed bytes. The binary header adds 12 bytes, so the vector file size is:

```text
12 + (cover count × 384) bytes
```

Search is an exact cosine scan over Int8 vectors. That is intentionally simpler
than a vector database and sufficient for validating quality and transfer size.
At 50,000 covers the raw index is about 19.2 MB; an approximate browser index is
only justified after exact search latency becomes a measured problem.

The page offers `index.bin`, `metadata.json`, and `results.json` as downloads.
The same binary index can later be shipped as a static asset and decoded without
WebAssembly. WebAssembly remains an option for approximate search at larger
scale, not a prerequisite for the MVP.

## What the score means

Each clean cover becomes a reference. The harness then generates two
deterministic variants:

- `mild`: small rotation, shear, brightness change, and glare.
- `hard`: crop, stronger rotation and shear, reduced brightness, glare, and JPEG
  compression.

Recall@1 and Recall@5 report where the matching clean cover ranks. These are
synthetic perturbations, not a substitute for a held-out set of real phone
photos. A production decision requires that second dataset and confusing
same-art/different-pressing cases.

## Source policies

- [MusicBrainz rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)
- [MusicBrainz search API](https://musicbrainz.org/doc/MusicBrainz_API/Search)
- [Cover Art Archive API](https://musicbrainz.org/doc/Cover_Art_Archive/API)
- [Discogs API terms and rate limits](https://www.discogs.com/developers)
- [DINOv2-small Transformers.js model](https://huggingface.co/Xenova/dinov2-small)
- [Transformers.js package](https://www.npmjs.com/package/@huggingface/transformers)
- [Microsoft Record Scanner architecture](https://devblogs.microsoft.com/cosmosdb/record-scanner-for-vinyl-collectors-cuts-costs-with-azure-cosmos-db-vector-search/)
