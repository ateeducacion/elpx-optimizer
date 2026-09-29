# Architecture

One portable core, three interfaces. The core never imports `node:*`, Bun, sharp, ffmpeg.wasm,
DOM globals or the eXeLearning editor; this is enforced by `tsconfig.core.json` (ES2023 lib only,
no DOM or Node types) and ESLint `no-restricted-imports`/`no-restricted-globals` rules on
`src/core/**`.

```
            ┌──────────── web (src/web) ─────────────┐   ┌──── CLI (src/cli) ────┐   skill
            │ UI  ⇄  PipelineClient ⇄ pipeline worker │   │ main(argv, io)        │   scripts/run.mjs
            └──────────────────────┬──────────────────┘   └──────────┬────────────┘   → CLI
                                   │                                  │
  adapters/browser: BlobByteSource, BlobStore,        adapters/node: FileByteSource, AtomicFileSink,
  BlobOutputTarget, BrowserMediaEngine                NodeResourceStore, NativeMediaEngine
  (ffmpeg.wasm nested worker, jSquash codecs)         (ffmpeg/ffprobe processes, sharp)
                                   │                                  │
                                   └──────────────┬───────────────────┘
                                          src/core (portable)
     zip/ reader+writer · format/ detect, content.xml, manifest, DataGame · parse/ xml, json, html,
     css, uri, text-map · refs/ scan, resolve, rewrite · analyze/ · plan/ · optimize/ · validate/ ·
     report/ · media/ sniff, image-inspect, image-metadata, probe, video-policy, image-policy, engine
```

## Public operations

| Operation                                                      | Module                      | Notes                                                                                                     |
| -------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------- |
| `analyzeArchive(source, options)`                              | `core/analyze/analyze.ts`   | Never modifies anything and never throws for bad input: fatal problems give `ok: false` with diagnostics. |
| `buildOptimizationPlan(analysis, options, engineInfo, limits)` | `core/plan/plan.ts`         | Pure. Same plan for the CLI dry run and the web preview.                                                  |
| `optimizeArchive(source, analysis, plan, platform, run)`       | `core/optimize/optimize.ts` | Re-validates input hash, options hash and plan hash, executes, repackages, verifies.                      |
| `validateArchive(source, options)`                             | `core/validate/validate.ts` | Analysis summarized as a verdict.                                                                         |

Adapters are injected through small interfaces: `ByteSource`/`ByteSink` (bytes), `ResourceStore`
(temporary media: files natively, Blobs in the browser), `MediaEngine` (probe, transcode, decode
check, playback check, image encode/verify, capabilities) and `OutputTarget` (atomic file or Blob).

## Reading archives safely

`core/zip/reader.ts` is a purpose-built reader because the checks we need are not exposed by
generic libraries (see [decisions](decisions.md)):

- The end of central directory must end exactly at the end of the file; ZIP64 records are
  supported and cross-checked with the classic ones; multi-volume archives are rejected.
- Every central header is validated (names, flags, methods, sizes, ZIP64 extra fields) and every
  local header is read and compared with it (name bytes, method, flags, CRC and sizes), so the
  central directory is never the only source of truth. Data descriptors are checked too.
- Rejected: traversal (`..`), absolute and drive/UNC paths, backslashes, control characters,
  duplicates, names that collide after Unicode NFC normalization, file/directory conflicts,
  symbolic links, encryption, methods other than stored/deflate, overlapping entries (overlap ZIP
  bombs) and data outside the declared ranges. Case-only collisions are warnings.
- Limits: archive size, entry count, total and per-entry declared sizes, compression ratio, name
  length, path depth. While inflating, output is counted chunk by chunk (inputs are fed in 16 KiB
  slices) and the read aborts as soon as it exceeds the declared size; CRC-32 and the final size
  are verified at the end.
- Reading is incremental: entries are streamed from random-access sources; the archive is never
  inflated as a whole. Text entries are loaded only up to `maxTextEntryBytes`.

`core/zip/writer.ts` copies unchanged entries with their compressed bytes untouched (so their
content is preserved exactly; in the browser as zero-copy Blob slices of the input File), stores
new media, deflates changed text, writes ZIP64 structures only when needed, and preserves entry
order, raw names and timestamps.

## References

References are discovered through nested encodings, each decoded with an offset map back to the
raw bytes (`core/parse/text-map.ts`):

```
content.xml text or CDATA ─► JSON (jsonProperties) ─► JSON string ─► HTML fragment ─► attribute ─► URL
                          └► HTML (htmlView) ─► attribute / srcset / style url() / text
                                             └► DataGame div (plain JSON | escape()+XOR 146)
                                             └► interactive-video JSON (div or <script>)
index.html, html/*.html ─► HTML document ─► same as above, URLs relative to the page
search_index.js ─► window.exeSearchData JSON ─► htmlView/jsonProperties strings ─► ...
CSS (theme, content/css, resources) ─► url() / @import
```

Each found reference records its location (entry, page, block, iDevice, field, JSON path, element,
attribute, line), the layers it went through, whether it is **explicit** (markup, data) or
**dynamic** (inside scripts or obfuscated payloads), and a `lift` function that maps an edit of
the reference into an edit of the entry's raw text. Rewriting therefore replaces exactly the bytes
of the reference and re-encodes only the replacement for its layers (XML text/CDATA, JSON string
escapes in the document's own style, HTML attribute/text with minimal escaping, CSS escapes,
percent-encoding). Anything that cannot be re-encoded faithfully is marked non-rewritable.

`core/refs/resolve.ts` implements eXeLearning's rules (`{{context_path}}` short and long forms with
upstream's prefix order, legacy `resources/`, stale `files/tmp/...` editor paths, page-relative
URLs, `asset://`, pseudo-links such as `exe-node:` and `exe-package:elp`). Percent-decoding happens
once. Lenient matches (file name only, case, Unicode normalization, double slashes, unencoded `#`/`?`
in names) are resolved but flagged, and ambiguity is reported, never guessed.

## Usage classification, cleanup and deduplication

User resources (`content/resources/**`, legacy `custom/**`) are classified as:

- `used`: at least one explicit, exact reference;
- `uncertain`: only lenient or dynamic references, or the same file name as a missing reference;
- `protected`: inside a folder that contains HTML or scripts (an opaque bundle), or in `custom/`;
- `unreferenced`: nothing refers to it anywhere.

`--remove-unused safe` removes only `unreferenced` files. Runtime folders (`theme/`, `libs/`,
`idevices/`, `content/css/`, `content/img/`), pages, `content.xml`, `content.dtd`,
`screenshot.png`, the search index and the manifest are never candidates. Exact deduplication
(size + CRC → SHA-256 → byte comparison, same format and extension, binary media only) removes a
copy only when every reference to it is explicit, exact and rewritable and the rewritten reference
re-resolves exactly to the kept file; otherwise both are kept with the reason in the plan. After
any removal, `libs/elpx-manifest.js` is regenerated to list exactly the final entries (manifest
last), as the download-source-file iDevice expects.

## Media

Policies are shared by both engines (`core/media/*-policy.ts`): profiles, eligibility (animated,
multi-image, CMYK, 16-bit, alpha video, HDR, interlaced, unsupported streams...), the FFmpeg
argument builder (argument vectors, `-protocol_whitelist file`, forced demuxer, `-enable_drefs 0`),
candidate validation (codec, size, pixel format, frame rate, duration tolerance, audio streams and
languages, subtitles, chapters) and savings thresholds. ffprobe runs in both engines (native binary
or the ffprobe entry point of ffmpeg.wasm) with the same arguments, and its JSON is normalized by
`core/media/probe.ts`. Image metadata (ICC, EXIF, XMP, IPTC, text chunks) is extracted from the
original and injected into the encoder's output by `core/media/image-metadata.ts`, so both engines
produce the same metadata; pixels are never rotated (the EXIF orientation is kept).

Engines differ in capabilities, and plans and reports say which engine and versions were used:

|                         | NativeMediaEngine (CLI, skill)                                            | BrowserMediaEngine (web)                                                 |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Video                   | ffmpeg/ffprobe processes (libx264, aac, libvpx-vp9, libopus when present) | ffmpeg.wasm 0.12.15, core 0.12.10 (single-thread; core-mt when isolated) |
| x264 preset per profile | slow / medium / medium                                                    | faster / veryfast / veryfast                                             |
| VP9 (WebM)              | yes                                                                       | too slow; skipped unless forced                                          |
| JPEG / PNG / WebP       | sharp 0.35.5 (mozjpeg, libpng, libwebp)                                   | jSquash MozJPEG, OxiPNG, libwebp (WASM)                                  |
| Playback check          | —                                                                         | `<video>` in the page, compared with the original                        |
| Cancellation            | process-group SIGTERM/SIGKILL                                             | `FFmpeg.terminate()` (worker killed, reloaded for the next job)          |

Encoders produce different bytes; tests check equivalent semantics (streams, duration, size,
validity), not identical hashes.

## Plan, execution and verification

The plan contains the input SHA-256, normalized options and their hash, engine versions and
capabilities, operations (with lossy flags and human-readable conversions), resources left
unchanged with stable reason codes, risks and an estimate labelled as such. Execution rebuilds the
plan from the analysis and refuses to run if any hash differs.

Videos run one at a time; images run with bounded concurrency. Each candidate is validated
(probe + full decode + playback in the browser) and must save at least the configured minimum;
otherwise the original is kept and the reason recorded. The output is written to a temporary
file next to the destination (CLI) or to a Blob (web), then reopened and analyzed from scratch:
same entries minus the removed ones, unchanged entries with identical CRC and size, no new
missing/ambiguous/structural diagnostics, every previously resolved reference still resolving,
same pages and component IDs, and a manifest matching the entries. Only then is the file committed
(renamed into place) or offered for download. If the final ZIP is not smaller than the input, a
byte-for-byte copy of the input is delivered with status `no-improvement`.

## Web runtime

The page (`src/web`) only renders and talks to a module worker (`pipeline.worker.ts`). The worker
reads the File with ranged Blob slices, runs the core, encodes images with WASM codecs and drives
FFmpeg, which runs in its own nested worker created by `@ffmpeg/ffmpeg`. FFmpeg inputs are mounted
with WORKERFS (read from the Blob on demand) and outputs are read from MEMFS and deleted
immediately. All JavaScript, workers and WASM are emitted by Vite into `dist/web/assets` and
loaded from the same origin with relative URLs; a Content-Security-Policy restricts scripts,
workers and connections to the same origin. See [web.md](web.md).
