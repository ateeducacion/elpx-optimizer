# Testing

| Suite                                 | Runner                                                               | What it covers                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/**`, `test/integration/**` | Vitest (Node)                                                        | Core (ZIP, parsers, references, analysis, plan, optimize, report; flattening, removal of broken references, clean names, audio conversion and their verification), native adapters (real ffmpeg/ffprobe and sharp, including audio), CLI in-process (`main(argv, io)`) and as a process, static server, skill wrapper (including a copy of the built skill outside the repository).                                   |
| `test/browser/**`                     | Vitest browser mode, headless Chromium (Playwright provider)         | Browser adapters with the real ffmpeg.wasm core (video and audio, including stereo Opus and a recording without a duration) and jSquash codecs, the playback check, the pipeline worker logic (including previews), the page client, the UI (options, plan, previews, side panels, dark mode).                                                                                                                        |
| `test/bun/**`                         | `bun test`                                                           | The same core, native engine and CLI under the Bun runtime (not part of coverage).                                                                                                                                                                                                                                                                                                                                    |
| `test/e2e/**`                         | Playwright (Chromium; Firefox and WebKit for `@cross-browser` tests) | `dist/web` served statically by `elpx-optimizer serve` with no backend: real in-browser re-encoding of video and audio, downloads verified with native ffprobe/ffmpeg, flattening and removal of broken references, clean names, privacy (requests), subdirectory, cancellation and recovery, engine failure, size limit, offline after preload, multi-thread core, keyboard/mobile, colour scheme, CLI↔web contract. |
| `test/compat/**` (`make compat`)      | Bun, inside the pinned eXeLearning checkout                          | eXeLearning's own importer and exporters on original vs optimized packages (17 cases, see below).                                                                                                                                                                                                                                                                                                                     |

## Coverage

`make coverage` runs both Vitest projects with the V8 provider and merges them into one report
(`coverage/`, lcov + HTML + JSON summary). Thresholds: 90 % lines, statements, functions and branches
globally and separately for `src/core/parse`, `src/core/refs`, `src/core/plan`, `src/core/zip` and
`src/core/optimize`. `coverage.include` covers every production file (`src/**/*.ts`) plus the skill
wrapper, so files without tests count as 0 %. Excluded: `*.d.ts` only. Code that runs only inside a
separate process or a Web Worker is not instrumented by V8/CDP; those entry points are kept to thin
wiring and are exercised in-process, and the logic they call is tested directly.

Final measured run (`npx vitest run --coverage`, 75 test files, 1481 tests, 86 production files):

| Metric     | Result              | Threshold |
| ---------- | ------------------- | --------- |
| Lines      | 99.88 % (5950/5957) | 90 %      |
| Statements | 99.80 % (7182/7196) | 90 %      |
| Functions  | 100 % (1086/1086)   | 90 %      |
| Branches   | 98.61 % (5701/5781) | 90 %      |

Critical areas (each ≥ 90 % on the four metrics): `src/core/parse`, `src/core/refs`, `src/core/plan`,
`src/core/zip`, `src/core/optimize`. Lowest files by branches: `src/cli/commands/doctor.ts` (92 %),
`src/core/report/report.ts` (93.05 %), `src/core/optimize/optimize.ts` (93.77 %); the uncovered
branches are defensive fallbacks, including a guard that reverts a converted file whose rename no
longer holds at execution (unreachable now that execution keeps the plan's names). There are no
`v8 ignore` comments in `src/`; the only one wraps the process entry of
`skills/elpx-optimizer/scripts/run.mjs` (it calls `process.exit`), which is exercised by spawn tests
instead.

`bun test test/bun`: 14 tests pass under Bun 1.4.0 (core, native adapters with a process-group kill,
CLI in-process and as a process).

E2E (`npx playwright test` on the built `dist/web`): 30 tests pass — 18 on Chromium, and the 6
`@cross-browser` tests on each of Firefox and WebKit (video re-encoding, no-improvement copy, audio
conversion, clean names, flattening with removal of broken references, colour scheme).

## Compatibility with eXeLearning

`make compat` optimizes each case with the CLI and checks the result with eXeLearning's own
importer and exporters at the pinned SHA (`test/compat/upstream-roundtrip.ts`): the semantic model
(pages, blocks, iDevices, their content and properties, with every asset reference normalized to the
content hash of the original file it points to), metadata, missing assets, unresolved references,
placeholders the importer leaves unconverted, ELPX and HTML5 re-export and re-import. Moved,
converted and renamed files are mapped back through `--renames`; runs that take out broken
references use `--content-changes` (structure and ids must not change, no asset may become missing).
The 17 cases are the 11 fixtures with clean-up and deduplication, two flattening runs, one audio run
and three runs that remove broken references. Final run: 17/17 compatible. On the upstream v3
fixture, flattening turns the 7 placeholders eXeLearning's importer could not resolve into resolved
assets.

## Fixtures

- `test/fixtures/media`: synthetic media generated by `scripts/generate-media-fixtures.mjs` (native
  ffmpeg + sharp): inefficient/efficient H.264, rotated video with two audio languages, subtitles and
  chapters, PCM audio in MOV, alpha video, 10-bit video, WebM, audio only, truncated files; JPEG with
  EXIF orientation, ICC and XMP; CMYK JPEG; PNG with alpha and text chunks; 16-bit PNG; palette PNG;
  OxiPNG-optimal PNG; lossy/lossless WebP with metadata; animated PNG/WebP/GIF; SVG; mismatched extension;
  audio: WAV, FLAC and AIFF tones, a 320 kb/s MP3, a stereo Opus WebM and a mono Opus WebM without a
  duration in its header (like a browser recording).
- `test/fixtures/elpx`: synthetic eXeLearning v4 packages built by `scripts/generate-elpx-fixtures.ts`
  with `test/helpers/elpx-builder.ts` (fflate, fixed timestamps): `course-video.elpx` (names with
  spaces, `&` and `ñ`, srcset, poster, subtitle track, plain-JSON and XOR DataGames with link anchors,
  interactive video, download-source-file and manifest, duplicates, unused file, script-only
  reference), `efficient.elpx` (no improvement possible), `broken-refs.elpx` (missing, case,
  ambiguous, percent-encoded, `asset://`, external, root-relative, legacy and malformed JSON),
  `legacy-folders.elpx` (eXeLearning 3 editor folders with name collisions, identical copies, a user
  folder, an empty editor folder and broken references), `audio-course.elpx` (WAV, FLAC, AIFF and a
  high-bitrate MP3 referenced from `<audio>`, `<source type>`, a link and DataGame JSON, plus a WAV
  named only in a script).
- `test/fixtures/upstream`: 12 real packages from eXeLearning at `406a2158` (v4, v3.0-era, legacy
  `.elp`, web export, DataGame, interactive video, malformed JSON...), see `PROVENANCE.md`.
- E2E generates a 40-second 720p lossless video package with native ffmpeg in `global-setup.ts`
  (native FFmpeg only creates fixtures and verifies downloads; it never processes for the page).

Ordinary tests need no network once dependencies, Playwright browsers and fixtures are installed.
