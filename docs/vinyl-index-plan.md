# Plan: Vinyl-Cover-Index

Stand: 2026-09-05 (ersetzt den Contributor-Entwurf vom 2026-09-04)

## Ziel

Musiclinkii soll Vinyl-Cover clientseitig erkennen können, ohne dass das Foto
der nutzenden Person den Browser verlässt. Dafür wird ein visueller
Referenzindex einmal zentral aufgebaut und statisch ausgeliefert. Der Browser
lädt pro Suche nur einen kleinen Ausschnitt des Index.

## Entscheidung in einem Satz

Ein M1-Mac (plus optional zwei bis drei weitere MacBooks) baut den kompletten
Index selbst; der Engpass ist der Cover-Download von archive.org, nicht die
Rechenzeit. Vektoren entstehen in Node mit exakt der Bibliothek und
Modelldatei des Browsers. Ausgeliefert wird ein IVF-Index aus kleinen
Zellen-Dateien auf GitHub Pages. Die Dauer „ein bis zwei Tage" ist eine
Hochrechnung aus 60 Requests; ob archive.org einen Dauerlauf mit vier
Verbindungen duldet, prüft Meilenstein 2, nicht dieser Plan.

## Laufzeit-Matching (unverändert)

`lokales Foto → OCR-Kandidaten → Katalog-Thumbnails → lokale Rangfolge`
bleibt der erste Pfad (`rerankVinylCandidates` in `js/visual-match.mjs`).
Der Index aus diesem Plan bedient nur den zweiten Pfad, wenn OCR nichts
Brauchbares liefert (`searchVinylCatalog`, Aufruf in `js/app.mjs:1042`). Beide
Pfade laden nie den gesamten Bildbestand und senden weder Bild noch Vektor.

## Messungen 2026-09-05 (M1 Max, 10 Kerne, 32 GB)

Alle Zahlen stammen aus Spikes dieser Session; Skripte lagen im
Session-Scratchpad und sind nicht eingecheckt. Eingabe waren die 65 gecachten
Benchmark-Cover unter `.cache/vinyl-benchmark/covers/`.

### Embedding-Durchsatz für `Xenova/dinov2-small`

| Pfad | Modell | img/s |
|---|---|---:|
| Node, `@huggingface/transformers@4.2.0`, onnxruntime-node CPU | q4 (Browser-Datei) | 22–25 (p10, Median 21–25) |
| Node, dieselbe Bibliothek | fp32 | 23–26 (p10, Median 22–25) |
| Python, onnxruntime CPU | q4 | 21–23 |
| Python, PyTorch MPS (GPU), Batch 8 | fp32 | ~210 |
| Browser, WASM (Pilot 2026-09-03, `benchmarks/vinyl/RESULTS.md`) | q4 | ~0,3 |

Node-Werte sind das 10. Perzentil eines interleaved Laufs über Batch 1, 8 und
16 (Batch 1 am unteren, Batch 8–16 am oberen Ende) auf einer Maschine unter
Fremdlast; ein leerer Mac liegt eher darüber. q4 ist
nativ nicht schneller als fp32; CoreML als Execution Provider ist in beiden
Runtimes langsamer als CPU. Thread-Knopf in Node:
`session_options.intraOpNumThreads`, Default ist bereits optimal.

### Kompatibilität der Vektoren (Cosinus, L2-normalisiert, 65 bzw. 12 Bilder)

| Vergleich | mean | min | Recall@1 |
|---|---:|---:|---:|
| Browser q4 (Pilot-Export) vs. Node q4 | 0,984 | 0,967 | 12/12, Marge ≥ 0,29 |
| Browser q4 vs. Node fp32 | 0,906 | 0,846 | 12/12 |
| Node q4 vs. Node fp32 | 0,906 | 0,778 | 65/65 |
| Python (PIL) q4 vs. Node (sharp) q4 | 0,984 | 0,946 | — |
| PyTorch fp32 vs. ONNX fp32 (gleiche Vorverarbeitung) | 0,999 | 0,998 | — |
| ONNX fp16 vs. fp32 | 0,9999 | 0,9998 | — |
| ONNX uint8 / quantized vs. fp32 | 0,968 / 0,973 | 0,883 / 0,848 | — |

Folgerungen:

- Der Ranking-Treffer bleibt in allen Kombinationen erhalten, aber absolute
  Werte sind nur innerhalb eines Modell-/dtype-Raums vergleichbar. Ein Index
  muss mit derselben dtype gebaut werden, die der Client abfragt.
- Die Vorverarbeitung (Canvas im Browser, sharp in Node, PIL in Python) wiegt
  genauso schwer wie die Runtime. Node mit Transformers.js liegt dem Browser am
  nächsten und ist deshalb der Build-Pfad.
- Int8-Speicherung der Vektoren kostet ~0,001 Cosinus, ist also frei.
- Wollte man einen fp32-Index (GPU, 210 img/s) nutzen, müsste der Browser auf
  `dtype: 'fp16'` wechseln (44 MB statt 15 MB Download). Bleibt Option, ist
  aber für v1 unnötig, weil Rechenzeit nicht der Engpass ist.
- Einen brauchbaren absoluten Schwellwert gibt es noch nicht: bei 65 Bildern
  liegt der schlechteste Impostor im q4-Raum bei 0,687 und der schlechteste
  hard-Variante-Treffer des Pilots bei 0,691 (`RESULTS.md`). Verlässlich ist
  nur die Ranking-Marge (0,276 im Pilot).

### Exakter Scan im Browser (Node/V8 als Näherung, plain JS ohne SIMD)

| Vektoren (384-d Int8) | Scan | Rohgröße |
|---|---:|---:|
| 100 000 | 38 ms | 38 MB |
| 1 000 000 | 399 ms | 384 MB |

Rechenzeit ist kein Argument für einen ANN-Index. Der einzige Grund für eine
Partitionierung ist die Downloadgröße pro Suche.

### Cover-Download von archive.org (ohne Sandbox-Proxy, direkter Pfad)

Je Stufe 20 Bilder, 60 Requests insgesamt; img/s ist Parallelität geteilt
durch mittlere Latenz.

| Parallelität | img/s | Latenz/Bild | Bytes/Bild (250 px) |
|---:|---:|---:|---:|
| 1 | 0,5 | 1,9 s | 24 KB |
| 2 | 1,1 | 1,8 s | 20 KB |
| 4 | 2,4 | 1,7 s | 21 KB |

In diesen 60 Downloads und den 600 HEAD-Requests der Coverage-Stichprobe kein
429 und kein `Retry-After`; ein einzelner HTTP 500 (transient, einfach
wiederholen). Die Latenz ist ein fester Preis pro Request
(Redirect auf einen CDN-Knoten plus neuer TLS-Handshake), daher skaliert der
Durchsatz linear mit den Verbindungen. Ob das über Hunderttausende Requests
hält, ist offen (Meilenstein 2). 500-px-Thumbnails sind ~2,6-mal größer
(61 KB) und bringen für 224-px-Eingaben nichts. Der Umweg über
`coverartarchive.org` kostet ~0,9 s extra; der direkte Pfad ist
`https://archive.org/download/mbid-<mbid>/mbid-<mbid>-<id>_thumb250.jpg`.
`https://archive.org/metadata/mbid-<mbid>` liefert die Dateiliste mit Größen.

### Umfang laut MusicBrainz (2026-09-05)

- Releases gesamt 5 753 655, davon mit Cover im Cover Art Archive 3 813 631
  (66,3 %) — <https://musicbrainz.org/statistics>.
- Vinyl über alle Formate: rund **616 000 Releases** (Summe über 12" Vinyl
  406 554, 7" Vinyl 158 457, Vinyl 37 542, 10" Vinyl 10 812, Phonograph
  record, Flexi-disc, VinylDisc, Pathé disc; Stand 2026-09-05,
  <https://musicbrainz.org/statistics/formats>). Die Summe zählt Releases mit
  mehreren Vinyl-Medien doppelt und ist damit eine Obergrenze. `format:vinyl`
  in der Such-API trifft nur das Format „Vinyl" (37 525), nicht die
  Untervarianten; ein `hascoverart`-Suchfeld gibt es nicht.
- Stichprobe `format:vinyl AND status:official` (nur plain „Vinyl"), Offset
  2000–2600: 134 von 600 (22,3 %) mit Front in CAA. Der Anteil für 12"/7" und
  für nicht-offizielle Releases ist unbekannt. Grobe Spanne für den Index:
  **135 000 bis 410 000 Releases** (616 000 × 22 % bzw. × 66 %), vor Dedup
  nach Release-Group. Die exakte Zahl fällt in Schritt 1 aus den Dumps.

### Hosting

- GitHub Pages liefert live `Accept-Ranges: bytes`, HTTP 206 und
  `Access-Control-Allow-Origin: *` (geprüft an
  `assets/vinyl-index/shard-000.bin`). Grenzen: 100 MiB pro Datei hart, 1 GB
  Repo-Empfehlung, ~100 GB/Monat Bandbreite (inoffiziell).
- Hugging Face Hub: Range-Requests mit CORS über die Xet-Bridge waren Anfang
  2026 gebrochen (<https://github.com/huggingface/datasets/issues/7931>,
  geschlossen 2026-02-24). Vor einer Nutzung live gegen die konkrete Datei
  prüfen (`curl -I -H "Range: bytes=0-11" -H "Origin: https://example.com"`);
  bis dahin bleibt Pages die Wahl.
- Cloudflare R2: 10 GB frei, kein Egress-Entgelt, CORS pro Bucket
  (<https://developers.cloudflare.com/r2/buckets/cors/>); Reserve, falls
  Pages-Bandbreite knapp wird.

## Verworfene Alternativen

- **Contributor-Crowd im Browser** (Plan vom 2026-09-04): 3 s/Bild in WASM
  gegen 45 ms nativ, jeder Contributor lädt 15 MB Modell, Quorum- und
  Queue-Logik nötig, und der eigentliche Engpass (Download je Verbindung)
  wird pro Kopf kaum kleiner. Für den Bootstrap gestrichen.
- **Fertiger HF-Datensatz** `dyslexi/Music_covers`
  (<https://huggingface.co/datasets/dyslexi/Music_covers>, MIT, 3,5 Mio.
  Release-Groups): CLIP, 1 536-d, nicht vinyl-gefiltert, inkompatibel zu
  DINOv2.
- **Nativer fp32/MPS-Index**: neunmal schneller als nötig und inkompatibel zu
  den q4-Werten des Browsers (Cosinus 0,906).
- **HNSW in WASM** (usearch, hnswlib-wasm, voy): braucht den ganzen Graphen im
  Speicher, also den kompletten Download.
- **Product Quantization**: bei ≤ 1 Mio. Vektoren mit IVF unnötig; Option,
  falls der Index deutlich wächst.

## Prüfstufe mit lokalen Merkmalen (erkundet 2026-09-06)

Frage: Lohnt eine zweite Stufe, die die Top-5-Kandidaten mit lokalen
Merkmalen (Keypoints plus RANSAC-Homographie, oder DINOv2-Patch-Tokens)
verifiziert und Pressungen mit identischem Artwork unterscheidet? Testdaten:
65 Cover, je eine mild- und hard-Variante nach dem Rezept aus
`benchmarks/vinyl/runner.mjs`, 40 synthetische Pressungen (Katalogstreifen,
Aufkleber) und 24 echte CAA-Frontcover aus drei Release-Groups (je 8
offizielle 12"-Pressungen von Dark Side of the Moon, Abbey Road, Rumours).
Alle DINOv2-Zahlen gelten für `Xenova/dinov2-small` q4. Skripte,
Ergebnisdateien und die MBIDs der echten Pressungen liegen unter
`benchmarks/vinyl/spikes/2026-09-06-local-features/`; die Bilder nicht.

### Verifikation der Kandidaten

Recall@1 über 130 Queries; die CLS- und die Patch-Zeile messen gegen die vier
härtesten Impostor je Query (520 Falschpaare), die Keypoint-Zeilen gegen alle
65 Originale.

| Verfahren | Recall@1 | Annahme ohne Falschtreffer | Kosten |
|---|---:|---|---|
| CLS-Cosinus allein (heutige Pipeline) | 130/130 | 126/130 bei Schwelle 0,73, 0 von 520 | keine |
| DINOv2-Patch-Tokens, wechselseitige Nachbarn ≥ 0,7 | 130/130 | 128/130 bei Schwelle 60, 0 von 520 | geschätzt ~126 ms je Suche in JS (25 M MAC je Paar, 1 G MAC/s angenommen); 98 KB Tokens je Cover im Index statt 384 B (Schwellen an fp32-Tokens gemessen) oder 43 ms Forward-Pass je Kandidat |
| SIFT bei 500/640 px + RANSAC + Geometrie-Gate | 130/130 | 130/130 wahr, 0/130 härteste Falschpaare, 0/192 fremdes Artwork | 264 ms nativ je Suche gegen 5 Kandidaten; bei 250 px bleibt Recall 130/130, das Gate wurde dort nicht gemessen (schlechtester Falschkandidat 84 Inlier); 29 ms nur mit vorberechneten Deskriptoren (~58 KB je Cover), kalt 97 ms; Browser-Faktor ungemessen |
| ORB 1500 bei 250 px / AKAZE bei 500 px | je 129/130 | je 1 Falschtreffer trotz Gate (23 bzw. 57 Inlier); je 3 hard-Queries unter 8 Inliern | ORB ~14 ms nativ |

Die Suche ist auf diesem Datensatz schon gesättigt; keine Prüfstufe verbessert
das Ranking. Ein nacktes Inlier-Minimum ist gefährlich: 34 % der Paare mit
verschiedenem Artwork (65 von 192) erreichen 8 Inlier, einmal 48. Erst das
Geometrie-Gate (konvexes Viereck, Flächenverhältnis 0,25–4, Seitenverhältnis
≤ 2) macht den Inlier-Wert brauchbar. Texturarme Cover sind das Risiko jedes
Keypoint-Verfahrens: Die acht Dark-Side-Scans liefern 33 bis 965
SIFT-Punkte, drei davon unter 140, teils weil CAA nur 300-px-Bilder hat; 5 von
84 echten Pressungspaaren lassen sich nicht ausrichten, alle bei Dark Side.
Der CLS-Vektor trennt dieselben Cover sauber (innerhalb der Release-Group
≥ 0,585, fremdes Artwork ≤ 0,310).

### Pressungen unterscheiden

Negativ, mit beiden Verfahren. Nach der Ausrichtung überlappt das Restbild der
79 echten Pressungspaare (≤ 500 px) mit dem Restbild der 40 synthetischen
Fotovarianten aus dem 65er-Set (beste Genauigkeit 0,83, kein trennender
Schwellwert). Auf dem synthetischen Overlay-Set trennen lokalisierte
Statistiken (Maximum zu Median) die 40 Overlays perfekt, weil der Hintergrund
dort pixelidentisch ist; auf echten Paaren fällt dieselbe Statistik auf 0,66.
Echte Pressungsunterschiede sind global verteilt (Farbstich, Scanqualität,
Anschnitt), Fotostörungen dagegen lokal (Glanz), also zeigt die Statistik in
die falsche Richtung. Ein synthetischer Aufkleber, gegen die hard-Variante
gesucht, bleibt in 10 von 20 Fällen unter dem Eigenrauschen des Fotos, ein
Katalogstreifen in 16 von 20. DINOv2-Patches erreichen auf den synthetischen
Paaren Zufallsniveau (0,54); auf den echten Paaren gegen Fotovarianten liegen
die besten Scores bei 0,65–0,69 mit auf denselben Daten optimierter Schwelle,
Basisrate 0,61. Abbey-Road-Pressungen liegen untereinander bei CLS
0,927–0,969, Handyfotos derselben Pressung bei 0,616–0,973. Dazu kommt ein
struktureller Grund: Die DINOv2-Vorverarbeitung behält nur das Band von
6,25 % bis 93,75 % des Bildes; vom Katalogstreifen am unteren Rand bleiben
geometrisch 1,9, nach Resampling 4 bis 10 von 224 Zeilen. Ungeprüft blieb ein
Held-out-Set echter Handyfotos; alle Kontrollen sind synthetisch.

### Entscheidung

- Keine Keypoint-Stufe für v1. Erst das Held-out-Set echter Handyfotos kann
  zeigen, ob das Ranking überhaupt Fehler macht; auf synthetischen Varianten
  macht es keine. Das Set entsteht seit 2026-09-06 über `vinyl-test/`
  (unverlinkte Handy-Testseite, Wahrheit pro Foto, Bericht per Teilen) und
  `scripts/evaluate-vinyl-test-report.mjs --heldout .cache/vinyl-heldout`;
  echte Fotos liegen noch keine vor.
- Braucht die UI ein „kein Treffer", ist 0,73 (small q4, 650 synthetische
  Paare) ein Startwert für die CLS-Schwelle, keine Kalibrierung; die
  Folgerung oben bleibt gültig. Der Patch-Nachbar-Zähler ist nur im
  Rerank-Pfad gratis, weil `rerankVinylCandidates` die Kandidaten-Thumbnails
  ohnehin einbettet und `modelVector` die Patch-Tokens heute wegwirft; im
  Index-Pfad kostet er 43 ms je Kandidat oder 98 KB je Cover. Der Rerank-Pfad
  läuft standardmäßig auf `base` (768-d), dort gelten andere Skalen.
- Pressungen werden nicht aus dem Bild unterschieden, sondern über `aliases`
  plus Metadaten zur Auswahl angeboten; Katalognummer und Land liest OCR vom
  vollen Bild, das die Ränder sieht.
- Recherche: OpenCV.js ist Apache-2.0, der 4.x-Build ~11 MB
  (<https://docs.opencv.org/4.x/opencv.js>), die JS-Bindings enthalten ORB,
  AKAZE, BRISK und `findHomography` mit RANSAC, aber kein SIFT
  (<https://github.com/opencv/opencv/blob/4.x/platforms/js/opencv_js.config.py>);
  jsfeat (<https://github.com/inspirit/jsfeat>) hat den letzten Commit von
  2018; Transformers.js führt kein Keypoint-Modell
  (<https://github.com/huggingface/transformers.js>); SuperPoint-Gewichte sind
  nur nicht-kommerziell nutzbar
  (<https://github.com/magicleap/SuperPointPretrainedNetwork>); XFeat ist
  Apache-2.0 ohne Web-Pfad (<https://github.com/verlab/accelerated_features>).
  Microsofts Record Scanner beschreibt globale Embeddings plus Vektorsuche,
  keine Verifikationsstufe
  (<https://devblogs.microsoft.com/cosmosdb/record-scanner-for-vinyl-collectors-cuts-costs-with-azure-cosmos-db-vector-search/>).

## Datenmodell und Quellen

- **MusicBrainz** ist die kanonische Quelle für Release-Identitäten. Ein
  `release` ist eine konkrete Pressung, eine `release-group` das Album.
- Vinyl sind alle `medium_format`-Namen, die „Vinyl", „Flexi-disc",
  „VinylDisc", „Phonograph record" oder „Pathé disc" enthalten. Die Tabelle hat
  eine `parent`-Spalte; ob alle Varianten Kinder eines „Vinyl"-Eintrags sind,
  wird in Schritt 1 aus dem Dump geprüft und nicht angenommen.
- **Cover Art Archive** liefert das Referenzbild; die `cover_art`-Tabelle im
  Dump sagt ohne API-Aufruf, welches Release welches Front-Bild mit welcher
  Bild-ID hat. Nach dem CAA-Editiermodell werden Bilder hinzugefügt oder
  entfernt, nicht unter derselben `cover_art.id` ersetzt (Annahme; in
  Meilenstein 1 an `edit`/`date_uploaded` gegenprüfen).
- **Discogs** bleibt Anreicherung (Katalognummer, Barcode) für spätere
  Meilensteine und ist für den Index nicht nötig. Der Benchmark-Sampler
  (`scripts/build-vinyl-benchmark.mjs`) nutzt die Discogs-API weiterhin:
  Attribution, Verlinkung, Rate-Limits und die aktuellen
  API-Nutzungsbedingungen bleiben einzuhalten; Discogs-Bilder werden nicht
  geladen.

## Aufbau (Node, ein Skript pro Schritt unter `scripts/vinyl-index/`)

Alle Skripte sind Developer-Tooling, werden nie von der App geladen und
schreiben nur nach `.cache/vinyl-index/` (gitignored).

1. **Manifest aus den Dumps, ohne Postgres.** Dump-Datum auflösen:
   `curl -s https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST`
   liefert z. B. `20260905-002519`; die Archive liegen dann unter
   `https://data.metabrainz.org/pub/musicbrainz/data/fullexport/<datum>/`
   (`mbdump.tar.bz2` 7,5 GB, `mbdump-cover-art-archive.tar.bz2` 167 MB). Die
   Archive enthalten je Tabelle eine TSV-Datei ohne Kopfzeile, NULL ist `\N`.
   Streamen mit `tar -xOjf <archiv> mbdump/<tabelle>`. Spaltenreihenfolgen,
   geprüft 2026-09-05 gegen
   <https://github.com/metabrainz/musicbrainz-server/blob/master/admin/sql/CreateTables.sql>
   (Kern) und `admin/sql/caa/CreateTables.sql` (CAA):
   - `medium_format`: id, name, parent, child_order, year, has_discids,
     description, gid
   - `medium`: id, release, position, format, name, edits_pending,
     last_updated, track_count, gid
   - `release`: id, gid, name, artist_credit, release_group, status, packaging,
     language, script, barcode, comment, edits_pending, quality, last_updated
   - `release_group`: id, gid, name, artist_credit, type, comment,
     edits_pending, last_updated
   - `artist_credit`: id, name, artist_count, ref_count, created,
     edits_pending, gid
   - `release_country`: release, country, date_year, date_month, date_day;
     `country` ist eine Area-ID, der ISO-Code kommt aus `iso_3166_1`: area,
     code. Dazu `release_unknown_country`: release, date_year, date_month,
     date_day.
   - CAA `cover_art`: id, release, comment, edit, ordering, date_uploaded,
     edits_pending, mime_type, filesize, thumb_250_filesize,
     thumb_500_filesize, thumb_1200_filesize (eine Zeile pro Bild; 7 472 801
     Bilder laut <https://musicbrainz.org/statistics/coverart>)
   - CAA `cover_art_type`: id, type_id; `art_type`: id, name, parent,
     child_order, description, gid („Front")

   Reihenfolge, damit nichts Großes im Speicher landet: `medium_format` und
   `art_type` laden, `medium` streamen und die Menge der Vinyl-Release-IDs
   bilden (Integer-Set, < 1 Mio.), `cover_art` streamen und nur Bilder dieser
   Releases behalten, `cover_art_type` streamen und auf „Front" filtern, dann
   `release`, `release_group`, `artist_credit`, `release_country`,
   `iso_3166_1` streamen und nur Treffer behalten. Ausgabe
   `.cache/vinyl-index/manifest.jsonl`, eine Zeile pro Release: `mbid`,
   `releaseGroupId`, `artist`, `title`, `year`, `country` (ISO-Code oder
   null), `format`, `coverArtId`, `thumb250Bytes`. Zeilen ohne
   `thumb_250_filesize` bekommen `thumb250Bytes: null` und werden beim
   Download über `_thumb500.jpg` versucht. Das Skript druckt am Ende die
   Zählung (Vinyl gesamt, mit Front, davon mit 250-px-Thumbnail) — das ist die
   erste verlässliche Zahl für den Index-Umfang.
2. **Dedup nach Release-Group.** Pro `releaseGroupId` bleibt eine Zeile
   (Vinyl-Release mit Front, bei mehreren das mit dem jüngsten Upload); die
   anderen Pressungen stehen als `aliases: [mbid, …]` in derselben Zeile, damit
   der Client die Pressung anbieten kann, statt dass identische Cover
   gegeneinander ranken. Ausgabe `manifest-dedup.jsonl` plus Zählung.
3. **Download + Embedding in einem Prozess.** `node scripts/vinyl-index/embed.mjs
   --shard 0/1` (bzw. `i/n` je MacBook; Zuordnung über `stableShard(mbid, n)`
   aus `scripts/vinyl-benchmark-lib.mjs:26`). Direkt-URL siehe oben,
   Parallelität 4, User-Agent `musiclinkii-index/<version>
   (+https://github.com/bmmmm/musiclinkii)`, Retry mit Backoff bei 5xx, Abbruch
   mit Meldung bei 429. Thumbnails bleiben unter
   `.cache/vinyl-index/covers/<mbid>.jpg` liegen, damit ein Modellwechsel
   keinen zweiten Download braucht. Embedding mit
   `pipeline('image-feature-extraction', 'Xenova/dinov2-small', { dtype: 'q4' })`
   aus `@huggingface/transformers@4.2.0`, CLS-Token wie in
   `js/visual-match.mjs:148` (`modelVector`), L2-normalisiert, Int8 wie
   `quantizeUnitVector` in `js/vector-index.mjs`. Fortschritt als JSONL
   (`done-<shard>.jsonl`: mbid, `coverArtId`, sha256 der Datei, Status), damit
   ein Abbruch an derselben Stelle weitermacht und ein halb geschriebenes Bild
   erkannt wird. Ausgabe `vectors-<shard>.bin` im bestehenden MLVI-Format
   (`encodeQuantizedIndex`) plus `rows-<shard>.jsonl`. Erwartung pro Maschine
   bei vier Verbindungen: ~2,4 Bilder/s, also rund 200 000 pro Tag, wenn
   archive.org den Dauerlauf duldet; Embedding läuft neunmal schneller als
   der Download und wartet nur.
4. **Zusammenführen und IVF bauen** (eine Maschine):
   `node scripts/vinyl-index/build-ivf.mjs --nlist <N/500>`. k-means (Lloyd,
   Float32 aus den Int8-Vektoren, 20 Iterationen, fester Seed) über alle
   Vektoren; `nlist` so wählen, dass eine Zelle ~500 Vektoren hat. Zentroiden
   werden vor der Int8-Quantisierung L2-normalisiert, weil `rankQuantized`
   Einheitsvektoren voraussetzt. Ausgabe unter `assets/vinyl-index/` (bzw. im
   Index-Repo, siehe Hosting):
   - `manifest.json`: `schemaVersion: 2`, `model`, `dtype`, `dimension`,
     `releaseCount`, `nlist`, `nprobeDefault`, `centroids` (Dateiname),
     `cells: [{ index, metadata, count, bytes }]`, `generatedAt`,
     `source.dumpDate`.
   - `centroids.bin`: MLVI mit `nlist` Int8-Vektoren.
   - `cell-0000.bin` / `cell-0000.json`: MLVI-Zelle plus Metadaten
     (`musicBrainzReleaseId`, `releaseGroupId`, `aliases`, `artist`, `title`,
     `date`, `country`, `coverSource`). Bei 500 Vektoren: 192 KB Vektoren plus
     ~160 KB JSON (gemessen ~330 B pro Zeile im Pilot-Schema), also ~350 KB
     pro Zelle auf der Platte; Pages komprimiert die JSON-Hälfte auf dem Draht.
     Jede Datei bleibt unter 1 MB.
5. **Client anpassen.** `searchVinylCatalog` in `js/vinyl-index.mjs:71` lädt
   heute alle Shards nacheinander. Neu: Manifest und `centroids.bin` laden,
   Query gegen die Zentroiden ranken (`rankQuantized`), die `nprobe` besten
   Zellen parallel laden, exakt scannen, mergen. `validateManifest`
   (`js/vinyl-index.mjs:27`) wird für `schemaVersion: 2` mit `cells` statt
   `shards` neu geschrieben und prüft `dtype` gegen die Query-dtype; dafür
   wird `DTYPE` aus `js/visual-match.mjs:31` exportiert. Der Aufruf in
   `js/app.mjs:1038` bleibt auf `modelKey: 'small'` festgelegt; wer das
   Default-Modell `base` (`DEFAULT_VISUAL_MODEL`, `js/visual-match.mjs:24`)
   gewählt hat, lädt für die Katalogsuche zusätzlich die 15 MB von `small`
   (siehe offene Entscheidungen). Erwartung pro Suche: einmalig Manifest plus
   Zentroiden (< 500 KB bei nlist ≈ 800), dann `nprobe = 8` Zellen à ~350 KB,
   also rund 3 MB.
6. **Hosting.** Eigenes Repo `musiclinkii-vinyl-index` mit GitHub Pages, damit
   Rebuilds die App-Historie nicht aufblähen; jeder Rebuild als Orphan-Commit,
   so bleibt das Repo unter 1 GB. `VINYL_CATALOG_URL` in `js/vinyl-index.mjs:10`
   zeigt dann auf dieses Origin; `shardUrl` (Zeile 44) erlaubt bereits nur
   Dateien unterhalb des Manifest-Verzeichnisses.

## Prüfrezepte vor dem Ausliefern

- **IVF-Recall:** die mild/hard-Varianten aus `benchmarks/vinyl/` gegen den
  IVF-Index mit `nprobe = 8` müssen dieselben Treffer liefern wie der flache
  Scan über alle Zellen. Schlägt eine Variante fehl, `nprobe` erhöhen oder
  adaptiv nachladen, wenn die Marge zum zweiten Treffer klein ist.
- **Schwellwert:** wird erst mit dem Held-out-Set echter Handyfotos (offenes
  Gate aus `benchmarks/vinyl/RESULTS.md`) festgelegt; bis dahin zeigt die UI
  Kandidaten nach Rang und wählt nie automatisch. Weg zum Set: Bericht aus
  `vinyl-test/` auswerten (`scripts/evaluate-vinyl-test-report.mjs`), die
  `.summary.md` liefert Recall je Quelle, Zeiten je Stufe und die
  Fehlschläge nach Situation; `--heldout` legt `photos/` und `index.json` für
  die Spike-Skripte ab.
- **Round-trip:** ein frisch gebauter Index muss die 12 Pilot-Cover aus dem
  Browser heraus auf Rang 1 liefern (dasselbe Rezept wie „Product integration
  check" in `RESULTS.md`).
- **Dateigrößen:** kein Artefakt über 1 MB, Gesamtgröße im Index-Repo unter
  1 GB, `manifest.json` zählt die Zellen und Bytes wie heute.

## Speicherung und Aktualisierung

- Öffentlich sind Metadaten, Vektoren, Modell/dtype, Zentroiden und Quell-URLs,
  keine Bildkopien.
- Monatlicher Dump-Delta: neue `cover_art`-Zeilen und neue Vinyl-Releases
  durchlaufen Schritt 3 für nur diese Zeilen, werden dem nächsten Zentroiden
  zugeordnet und an die Zelle angehängt; k-means wird erst neu trainiert, wenn
  eine Zelle mehr als das Dreifache des Mittels enthält.
- Ein Vektor bleibt gültig, solange `coverArtId` und Modell/dtype unverändert
  sind. Bekommt ein Release im Dump eine andere Front-`cover_art.id` oder
  verschwindet die Zeile, wird der Eintrag `stale` und im nächsten Lauf neu
  berechnet oder entfernt.
- Ein Modell- oder dtype-Wechsel bedeutet einen kompletten Rebuild aus den
  lokal liegenden Thumbnails (ohne erneuten Download, ~5 h bei 400 000 Bildern
  und 22 img/s auf einem Mac).

## Rechtliche Leitplanken

- MusicBrainz-Kerndaten sind CC0, ergänzende Daten CC BY-NC-SA 3.0. Das
  Cover Art Archive hostet Bilder, deren Rechte bei den Rechteinhabern liegen;
  Bilder werden nicht weiterverteilt, nur Vektoren und Identifikatoren.
- Discogs bezeichnet Release-Titel, Formate, Tracklists, Barcodes,
  Identifikatoren und Credits als CC0-Daten; Discogs-Bilder und andere
  Restricted Data werden weiterhin nicht gespiegelt.
- Ein MIT-lizenzierter Präzedenzfall für veröffentlichte Cover-Embeddings mit
  MBIDs existiert (`dyslexi/Music_covers`), eine offizielle MetaBrainz-Aussage
  dazu nicht. Vor einem öffentlichen Langzeitbetrieb wird die Nutzung der
  Dumps, der abgeleiteten Vektoren **und der lokal gecachten CAA-Thumbnails**
  (Schritt 3 hält 135 000 bis 410 000 Bilder auf den Build-Maschinen)
  schriftlich geprüft bzw. bestätigt.

## Meilensteine

1. **Manifest:** Schritt 1 und 2 laufen, die Zählung steht im Commit.
2. **Pilot 10 000:** Schritt 3 mit einem Shard aus 10 000 Releases; gemessene
   Download-Rate, Fehlerquote und jedes Drosselsignal im Commit. Erst danach
   gilt die Tagesrate als belegt.
3. **Vollbuild:** alle Shards, IVF, Prüfrezepte grün.
4. **Client + Hosting:** Schritt 5 und 6, Round-trip im Browser.
5. **Betrieb:** monatlicher Delta-Lauf, Stale-Prozess, Held-out-Fotoset.

## Offene Entscheidungen

- Exakter Index-Umfang und Dedup-Faktor (fällt aus Meilenstein 1).
- Ob 7"-Singles in v1 gehören (158 457 Releases, viele Firmenhüllen ohne
  eigenes Artwork).
- Schwellwert und `nprobe` (fällt aus dem Held-out-Fotoset).
- Katalogsuche und Modellwahl: entweder bleibt die Katalogsuche auf `small`
  und nimmt den Zweitdownload für `base`-Nutzende in Kauf, oder es wird
  später ein zweiter Index für `base` gebaut (Durchsatz für `base` ist nicht
  gemessen; das Modell hat rund die vierfache Parameterzahl von `small`).
- Lizenz- und Freigabebestätigung für den öffentlichen Index.
