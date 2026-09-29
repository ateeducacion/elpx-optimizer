# elpx-optimizer CLI reference (for the skill)

Run everything through `node scripts/run.mjs <command> ...` (or `bun scripts/run.mjs`). The wrapper
finds the CLI in this order and runs it with the same JavaScript runtime:

1. `ELPX_OPTIMIZER_CLI`: path to `elpx-optimizer.mjs` (or to an `elpx-optimizer` executable).
2. `vendor/elpx-optimizer.mjs` inside this skill (the distributed skill bundle).
3. `elpx-optimizer` on `PATH` (installed CLI).
4. `../../dist/cli/elpx-optimizer.mjs` when the skill is used from a built checkout of the repository.

`node scripts/run.mjs --which` prints the resolved CLI without running it.

## Commands

| Command                                                | Purpose                                                             | Exit codes                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `doctor [--json]`                                      | Runtime, ffmpeg/ffprobe (with a real encode test), sharp, web build | 0 all available, 5 something missing                                                     |
| `inspect FILE [--json] [--no-probe] [--no-references]` | Analysis without changes                                            | 0, 3 invalid input                                                                       |
| `validate FILE [--json] [--strict]`                    | Integrity, references, manifest                                     | 0 valid, 4 errors (warnings with --strict), 3 unusable                                   |
| `optimize FILE [options]`                              | Plan (`--dry-run`) or run                                           | 0 optimized/no-improvement/dry run, 4 partial, 3 invalid input, 1 failure, 130 cancelled |
| `serve [--host --port --root --base --isolation]`      | Static web app only (no upload API)                                 | 0                                                                                        |

`--json` prints exactly one JSON document on stdout; progress goes to stderr (`--quiet` silences it).

## optimize options

- Output: `--output PATH` (default `<name>_optimized.elpx` next to the input; refuses the input path),
  `--overwrite` (only the output), `--report PATH`, `--dry-run`, `--json`.
- Selection: `--preset conservative|balanced|aggressive`, `--no-video`, `--no-images`,
  `--remove-unused off|safe`, `--deduplicate off|exact`, `--exclude PATH` (repeatable; ZIP paths such as
  `content/resources/video.mp4`), `--config FILE` (JSON with the same keys as the web app).
- Video: `--video-crf 16-35`, `--video-max-resolution 360|480|720|1080|1440|2160|original`,
  `--video-audio-bitrate 64-320`, `--video-x264-preset NAME`, `--video-force`, `--video-drop-data-streams`.
- Images: `--image-quality 30-100`, `--webp-quality 30-100`, `--image-max-dimension N|none`, `--no-png`,
  `--strip-metadata`, `--image-force`, `--include-screenshot`, `--min-savings-percent N`, `--min-savings-bytes N`.
- Resources: `--threads N`, `--image-concurrency N`, `--timeout-video SECONDS`, `--max-archive-size BYTES`,
  `--max-video-size BYTES`, `--temp-dir DIR`, `--ffmpeg PATH`, `--ffprobe PATH`.

## JSON documents

- `inspect`: `schema: "elpx-optimizer/analysis"` with `ok`, `package` (variant, title, pages, components),
  `totals`, `entries[]` (path, size, kind, format, usage `used|uncertain|protected|unreferenced`,
  image/video properties), `duplicates[]`, `diagnostics[]` (code, severity, message, resource, location).
- `optimize --dry-run`: `schema: "elpx-optimizer/dry-run"` with `plan.operations[]`, `plan.skipped[]`
  (reason codes), `plan.estimate` (an estimate, not a measurement), `plan.risks[]`.
- `optimize`: `schema: "elpx-optimizer/report"` with `status`, `sizes`, `operations[]` (status
  `applied|reverted|failed`, `before`, `after`, `detail`, `checks`), `validations[]`, `diagnostics`
  (`before`, `introduced`, `resolved`).
- `validate`: `schema: "elpx-optimizer/validation"` with `verdict` and `checks[]` (`status`: `passed`,
  `failed` or `not-run` — a not-run check was not verified, do not report it as passed or failed).

## Installing dependencies (tell the user; do not do it silently)

- ffmpeg/ffprobe: Ubuntu `sudo apt install ffmpeg`; macOS `brew install ffmpeg`; or set `--ffmpeg/--ffprobe`
  (or `ELPX_OPTIMIZER_FFMPEG` / `ELPX_OPTIMIZER_FFPROBE`).
- sharp: `npm install sharp@0.35.5` in the directory that contains the CLI bundle.
- Windows: use the Docker image (`docker run --rm -v "%cd%:/work" elpx-optimizer-cli optimize /work/curso.elpx`).
