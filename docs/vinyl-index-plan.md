# Plan: verteilter Vinyl-Cover-Index

Stand: 2026-09-04

## Ziel

Musiclinkii soll Vinyl-Cover clientseitig erkennen können, ohne dass das Foto
der nutzenden Person den Browser verlässt. Dafür bauen Contributors gemeinsam
einen visuellen Referenzindex auf.

## Datenmodell und Quellen

- **MusicBrainz** ist die kanonische Quelle für Release-Identitäten. Ein
  `release` steht für eine konkrete Ausgabe/Pressung; ein `release-group` für
  das abstrakte Album.
- Als Vinyl-Releases gelten Medien mit den MusicBrainz-Formaten `Vinyl`,
  `7" Vinyl`, `10" Vinyl`, `12" Vinyl` und Flexi-disc-Varianten.
- **Discogs** ergänzt Pressungsdetails wie Katalognummern, Barcodes und
  Varianten. Discogs-ID und MBID werden als externe Referenzen verknüpft.
- **Cover Art Archive** ist die primäre Referenzbildquelle. Die konkrete
  Release-MBID bestimmt das Bild; Discogs-Cover werden nicht gespiegelt.

## Aufbau der Basisdaten

1. Den vollständigen MusicBrainz-Datenbankdump lokal importieren und Vinyl-
   Releases herausfiltern.
2. Discogs-Daten (bevorzugt offizieller Monatsdump, sonst API im Rahmen der
   Nutzungsbedingungen) zur Anreicherung und zum Abgleich verwenden.
3. Ein normalisiertes Manifest erzeugen mit:
   `mbid`, `release_group_mbid`, Artist, Titel, Jahr, Land, Format, Label,
   Katalognummer, Barcode, `discogs_release_id`, CAA-URL und Status.
4. Das Manifest reproduzierbar nach Artist-Namen in A–Z- sowie `#`-Blöcke
   teilen. Die MBID bleibt der technische Primärschlüssel; sie ist eine UUID
   und nicht alphabetisch sortierbar.

## Contributor-Workflow

1. Ein Contributor übernimmt einen Manifest-Block.
2. Der Browser lädt die erlaubte CAA-Referenzgrafik direkt.
3. Das ausgewählte lokale Modell vektorisiert das Referenzbild im Browser.
4. Zurückgesendet werden ausschließlich MBID, Vektor, Bild-Hash,
   Modellversion, Bildquelle und Qualitäts-/Fehlerstatus.
5. Das persönliche Scan-Foto bleibt lokal und wird nicht hochgeladen.
6. Für wichtige Einträge können zwei unabhängige Berechnungen verlangt werden;
   ein Quorum bestätigt den Eintrag.

## Laufzeit-Matching

`lokales Foto → OCR-Kandidaten → MB/Discogs-Metadatenfilter → CAA-Thumbnails →
lokale Vektor-/Layout-/Farb-Rangfolge`

Es werden nur wenige Kandidatenbilder geladen, nicht der gesamte Bildbestand.

## Speicherung und Aktualisierung

- Der öffentliche Index enthält Metadaten, Vektoren, Hashes, Modellversionen
  und Quell-URLs, aber keine kopierten Coverbilder.
- Neue monatliche Dumps werden als Delta verarbeitet; bestehende Vektoren
  bleiben gültig, solange Bild-Hash und Modellversion unverändert sind.
- Geänderte oder entfernte Quellen werden als `stale` markiert und später neu
  validiert.

## Rechtliche Leitplanken

- Discogs bezeichnet Release-Titel, Formate, Tracklists, Barcodes,
  Identifikatoren und Credits als CC0-Daten. Attribution, Verlinkung,
  Rate-Limits und aktuelle API-Nutzungsbedingungen bleiben einzuhalten.
- Discogs-Bilder und andere Restricted Data werden nicht weitergegeben oder
  in unserem Speicher gespiegelt.
- MusicBrainz-Daten stehen unter CC BY-NC-SA 3.0; Cover Art Archive ist eine
  getrennte Bildquelle, deren Bilder nicht pauschal frei weiterverteilbar sind.
- Vor einem öffentlichen Langzeitbetrieb wird die konkrete Nutzung der Dumps,
  der Vektoren und der CAA-Bilder schriftlich geprüft bzw. bestätigt.

## Meilensteine

1. **Bootstrap:** MusicBrainz-Vinyl-Manifest mit reproduzierbarem Filter.
2. **Anreicherung:** Discogs-IDs, Katalognummern und Barcodes verknüpfen.
3. **Queue:** A–Z-Blockvergabe, Fortschritt, Checksums und Wiederaufnahme.
4. **Contributor-Client:** lokale Vektorisierung und signierte Ergebnisabgabe.
5. **Qualität:** Doppelberechnung, Hash-Prüfung und Regressionstest mit echten
   Vinyl-Covern.
6. **Betrieb:** monatliche Deltas, Modellmigration und Stale-Quelle-Prozess.

## Offene Entscheidungen

- endgültige Lizenz- und Freigabebestätigung für den öffentlichen Index;
- genaue MB- und Discogs-Dump-Version für den ersten Bootstrap;
- Vektorformat, Quantisierung und Zielgröße pro Modellvariante;
- Backend/Storage für Manifest, Queue und Contributor-Ergebnisse.
