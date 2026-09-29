# Design decisions

Each decision records the options considered and the evidence. Upstream facts come from
[upstream-review.md](upstream-review.md) (eXeLearning `406a2158623da1862e9f50fdfd5e358b818c9aa8`,
`v4.0.5-16`).

## D1. Minimal changes to the existing package instead of an eXeLearning round trip

Options: (a) import with upstream's importer into Yjs and re-export; (b) edit the package in place.

Chosen: (b). A re-export is a re-render with the current runtime: it replaces themes, libraries and
iDevice runtimes, rewrites every asset path, drops unread metadata keys and has known bugs (the
backslash swallowed in JSON at `BaseExporter.ts:1039`, the accumulating `screenshot.png` in CLI
round trips). In-place editing keeps every unchanged entry byte-for-byte (compressed bytes copied)
and changes only media bytes and, for deduplication, the exact bytes of rewritten references.
Upstream's importer and exporters are used instead as an **independent check** (`make compat`,
`test/compat`): the optimized package must import with the same pages, blocks, components, IDs,
texts and properties (asset references normalized to the original content they point to), with no
new missing assets, and must re-export to ELPX and HTML5.

## D2. Formats and extensions are preserved

Changing a file's format would require rewriting its references in `content.xml` (HTML and JSON,
including escaped layers), every page, `search_index.js`, the manifest, DataGame link anchors and
the interactive-video JSON (whose MIME type is derived from the extension). Keeping the format makes
recompression reference-neutral. A format-change option is therefore not offered in this version.

## D3. Pixo (eXeLearning's image optimizer) evaluated, jSquash chosen for the browser

eXeLearning vendors Pixo (`public/libs/pixo`, MIT, crate version not recorded) in
`ImageOptimizerWorker.js`. Facts: it has encoders only (no decoder: upstream decodes with
`createImageBitmap` + `OffscreenCanvas`, which applies colour conversion and drops EXIF/ICC); its
default policy converts any PNG without transparency to JPEG and renames `.png` to `.jpg`, which is
incompatible with D2.

Measured with `bun scripts/bench-image-encoders.ts` on the same decoded pixels:

| Input                       | Encoder                   | Bytes | Quality                                           |
| --------------------------- | ------------------------- | ----- | ------------------------------------------------- |
| photo-exif-icc.jpg JPEG q82 | Pixo (eXeLearning)        | 12352 | 36.08 dB                                          |
| photo-exif-icc.jpg JPEG q82 | MozJPEG via jSquash (web) | 6986  | 35.64 dB                                          |
| photo-exif-icc.jpg JPEG q82 | sharp mozjpeg (CLI)       | 6366  | 35.62 dB                                          |
| alpha-text.png (120483 B)   | Pixo lossless             | 32988 | RGB of 100/30000 fully transparent pixels changed |
| alpha-text.png (120483 B)   | OxiPNG via jSquash (web)  | 31123 | pixel-identical                                   |
| alpha-text.png (120483 B)   | sharp libpng (CLI)        | 46712 | pixel-identical                                   |

At the same nominal quality Pixo's JPEG is ~1.8× larger than MozJPEG (quality scales are not
identical, PSNR differs by ~0.4 dB); its PNG "lossless" mode is visually lossless but not bit-exact.
The browser engine uses the jSquash builds of MozJPEG, OxiPNG, libwebp and a Rust resizer
(Apache-2.0 wrappers; codecs under their own licenses) behind the same `MediaEngine` contract, with
our own metadata re-injection. Pixo could be plugged in as an alternative encoder later.

## D4. ffmpeg.wasm 0.12.15 + core 0.12.10, single-thread by default

Latest published versions (`@ffmpeg/ffmpeg` 0.12.15 of 2025-01-07, `@ffmpeg/core` and
`@ffmpeg/core-mt` 0.12.10). The single-thread core needs neither SharedArrayBuffer nor COOP/COEP,
so any static host works; the multi-thread core is loaded only when the page is cross-origin
isolated, SharedArrayBuffer exists, the device has ≥ 4 cores (and ≥ 4 GiB when reported) and the
user did not disable it. The `FFmpeg` class is given explicit same-origin `coreURL`, `wasmURL`,
`workerURL` and `classWorkerURL`: its worker otherwise falls back to an unpkg.com CDN URL. Its
`ffprobe()` returns a non-zero code even on success, so the JSON output is authoritative.

## D5. Own ZIP reader and writer (with fflate for DEFLATE)

Generic libraries (fflate's `unzip`, JSZip) read whole archives into memory or do not expose the
checks we need (local vs central header cross-checks, overlap detection, per-chunk inflate
accounting, ZIP64 cross-validation, raw copy of compressed bytes). fflate is used for streaming
DEFLATE/INFLATE only. The reader and writer are tested against Python's `zipfile` (including
forced ZIP64 and archives with more than 65535 entries) and hostile crafted archives.

## D6. Strict, entity-free XML parser with offsets

`content.xml` must be parsed without resolving entities or DTDs (XXE and billion-laughs protection)
and edited in place, which requires raw offsets of text, CDATA and attributes. Well-formedness is
checked strictly; any DOCTYPE internal subset is rejected (upstream never writes one); external
DTDs (`content.dtd`) are never loaded.

## D7. Minimal escaping when rewriting references

eXeLearning resolves `{{context_path}}` references by literal text matching on `htmlView` and JSON
strings. A rewrite to `foto&amp;x.jpg` is correct HTML but does not resolve in eXeLearning; the
independent compatibility check found this. Rewritten references keep `&` raw unless it would be
read as a character reference, and references in `content.xml` to names that cannot be written so
that both eXeLearning and browsers agree are not rewritten (the duplicate is kept).

## D8. Upstream code reuse

No upstream source is copied into the product. Reused knowledge: reference regexes and resolution
order, the DataGame `escape()`+XOR 146 codec (reimplemented from `common.js`), the manifest format,
the ZIP compression policy (deflate text, store media) and import limits. Upstream fixtures are
copied with provenance in `test/fixtures/upstream/PROVENANCE.md`; the upstream importer/exporters
run only in the compatibility check, from a pinned checkout fetched by `scripts/fetch-upstream.sh`.
