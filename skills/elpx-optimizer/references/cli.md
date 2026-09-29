# elpx-optimizer CLI reference (for the skill)

Run everything through `node scripts/run.mjs <command> ...` (or `bun scripts/run.mjs`). The wrapper
finds the CLI in this order and runs it with the same JavaScript runtime:

1. `ELPX_OPTIMIZER_CLI`: path to `elpx-optimizer.mjs` (or to an `elpx-optimizer` executable).
2. `vendor/elpx-optimizer.mjs` inside this skill (the distributed skill bundle).
3. `elpx-optimizer` on `PATH` (installed CLI).
4. `../../dist/cli/elpx-optimizer.mjs` when the skill is used from a built checkout of the repository.

`node scripts/run.mjs --which` prints the resolved CLI without running it.

## Commands

| Command                                                | Purpose                                                                                                              | Exit codes                                                                               |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `doctor [--json]`                                      | Runtime, ffmpeg/ffprobe (real encode test), sharp, qpdf, web build; `capabilities.video`, `.audio`, `.image`, `.pdf` | 0 all available, 5 something missing                                                     |
| `inspect FILE [--json] [--no-probe] [--no-references]` | Analysis without changes                                                                                             | 0, 3 invalid input                                                                       |
| `validate FILE [--json] [--strict]`                    | Integrity, references, manifest                                                                                      | 0 valid, 4 errors (warnings with --strict), 3 unusable                                   |
| `optimize FILE [options]`                              | Plan (`--dry-run`) or run                                                                                            | 0 optimized/no-improvement/dry run, 4 partial, 3 invalid input, 1 failure, 130 cancelled |
| `serve [--host --port --root --base --isolation]`      | Static web app only (no upload API)                                                                                  | 0                                                                                        |

`--json` prints exactly one JSON document on stdout; progress goes to stderr (`--quiet` silences it).

## optimize options

- Output: `--output PATH` (default `<name>_optimized.elpx` next to the input; refuses the input path),
  `--overwrite` (only the output), `--report PATH`, `--dry-run`, `--json`.
- Selection: `--preset conservative|balanced|aggressive` (`maximum` = `aggressive`, the web app's
  "Maximum"), `--no-video`, `--no-images`, `--no-audio`, `--no-pdf`, `--remove-unused off|safe`,
  `--deduplicate off|exact`, `--exclude PATH` (repeatable; ZIP paths such as
  `content/resources/video.mp4`), `--config FILE` (JSON with the same keys as the web app).
- Restructuring (off by default, ask first):
  - `--flatten off|legacy`: move files out of eXeLearning 3 folders `content/resources/<ODE-ID>/`
    (14 digits + 6 upper-case letters/digits) into `content/resources/`. Suggest it when `inspect`
    reports `legacy-resource-folders`. Same-name files become `name_2.ext`, identical ones merge;
    files with uncertain references stay (see `skipped[]`).
  - `--normalize-names off|slug`: clean file names (lower case, no accents or spaces, only a–z, 0–9
    and hyphens, copy markers such as "Copia de" or "(2)" removed, extension lower-cased). Only the
    file name changes; taken names get `-2`, `-3`; files with uncertain references keep their names.
    Plan op `rename-resource`. The web app has it on by default; the CLI does not.
  - `--missing-references keep|remove`: `remove` takes out references to files that do not exist
    (broken images and players deleted, links keep their text; CSS and text are left). Opt-in only.
- Video: `--video-crf 16-35`, `--video-max-resolution 360|480|720|1080|1440|2160|original`,
  `--video-audio-bitrate 64-320` (audio tracks inside videos), `--video-x264-preset NAME`,
  `--video-force`, `--video-drop-data-streams`.
- Images: `--image-quality 30-100`, `--webp-quality 30-100`, `--image-max-dimension N|none`
  (default 2560/1920/1600 px by preset), `--no-png`, `--strip-metadata`, `--image-force`,
  `--include-screenshot`.
- Thumbnail: `--screenshot FILE` replaces (or adds) `screenshot.png` with a 16:9 image at least 600 px
  wide, saved as a PNG of up to 1280×720 (plan op `replace-screenshot`). Only the web app can redraw
  it from the first page.
- Audio files: WAV/AIFF/FLAC become MP3 renamed to `.mp3` (references and `type` attributes
  rewritten; a file whose references cannot follow stays unchanged); MP3, M4A and Opus (WebM/Ogg)
  are re-encoded in place only when their bitrate is ≥ 1.4 × the target. `--audio-bitrate 64-320`
  (MP3/AAC stereo; mono half, at least 64; Opus half of those; default 192/128/96 by preset),
  `--audio-force`.
- PDFs: rewritten by qpdf (WebAssembly, no external tool) without re-rendering; text, fonts, links,
  bookmarks, forms and tags are kept and names never change. A lossless pass (object streams, Flate
  streams recompressed) always runs; the balanced and aggressive presets also convert images that
  are not JPEG into JPEG where that makes them smaller (lossy; existing JPEGs are not re-encoded).
  `--pdf-lossless` turns the image conversion off, `--no-pdf` leaves every PDF untouched. Encrypted
  and signed PDFs, PDFs over 512 MiB and PDFs qpdf cannot read are skipped (`skipped[]`, kind `pdf`,
  reasons `encrypted`, `signed`, `exceeds-size-limit`, `not-inspected`); a result must pass
  `qpdf --check` without warnings, keep the page count and save at least the minimum.
- Thresholds: `--min-savings-percent N`, `--min-savings-bytes N`.
- Resources: `--threads N`, `--image-concurrency N` (also parallel audio jobs), `--timeout-video SECONDS`
  (also per qpdf run), `--max-archive-size BYTES`, `--max-video-size BYTES`, `--temp-dir DIR`,
  `--ffmpeg PATH`, `--ffprobe PATH`.

## JSON documents

- `inspect`: `schema: "elpx-optimizer/analysis"` with `ok`, `package` (variant, title, pages, components,
  `legacyFolders.files`/`.folders`), `totals` (incl. `audioBytes`), `entries[]` (path, size, kind, format,
  usage `used|uncertain|protected|unreferenced`, image/video/audio properties, and for PDFs `pdf`:
  `pages`, `encrypted`, `signed`, `pdfA1`, `linearized`), `duplicates[]`, `diagnostics[]` (code,
  severity, message, resource, location).
- `optimize --dry-run`: `schema: "elpx-optimizer/dry-run"` with `plan.operations[]` (`op`:
  `transcode-video`, `recompress-image`, `transcode-audio` with `to` when renamed, `optimize-pdf`,
  `remove-unused`, `deduplicate`, `move-resource` and `rename-resource` with `to`,
  `remove-missing-reference`, `rewrite-references`, `update-manifest`, `replace-screenshot`), `plan.skipped[]` (kind,
  reason code, detail),
  `plan.estimate` (an estimate, not a measurement), `plan.risks[]`.
- `optimize`: `schema: "elpx-optimizer/report"` with `status`, `sizes`, `operations[]` (status
  `applied|reverted|failed`, `before`, `after`, `detail`, `checks`), `validations[]`, `diagnostics`
  (`before`, `introduced`, `resolved`).
- `validate`: `schema: "elpx-optimizer/validation"` with `verdict` and `checks[]` (`status`: `passed`,
  `failed` or `not-run` — a not-run check was not verified, do not report it as passed or failed).

## Installing dependencies (tell the user; do not do it silently)

- ffmpeg/ffprobe (video and audio): Ubuntu `sudo apt install ffmpeg`; macOS `brew install ffmpeg`; or set
  `--ffmpeg/--ffprobe` (or `ELPX_OPTIMIZER_FFMPEG` / `ELPX_OPTIMIZER_FFPROBE`).
- sharp: `npm install sharp@0.35.5` in the directory that contains the CLI bundle.
- qpdf (PDFs): `npm install @neslinesli93/qpdf-wasm@0.3.0` in the directory that contains the CLI
  bundle (`qpdf-runner.mjs` must sit next to `elpx-optimizer.mjs`). It is WebAssembly: no system
  qpdf is needed or used. In the skill's `vendor/`, a plain `npm install` installs sharp and qpdf.
- No local installation, or Windows: the published Docker image includes everything
  (`docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx`;
  in PowerShell `-v "${PWD}:/work"`). It is used directly, not through `scripts/run.mjs`.
- The CLI package (`elpx-optimizer-cli-X.Y.Z.tgz`) and this skill (`elpx-optimizer-skill.zip`) are
  attached to every release at https://github.com/ateeducacion/elpx-optimizer/releases.
