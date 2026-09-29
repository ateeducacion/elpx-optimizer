# CLI

```
elpx-optimizer <command> [options]
```

| Command         | What it does                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `doctor`        | Runtime, ffmpeg/ffprobe (version, encoders and a real 0.5 s libx264 encode + probe), sharp/libvips (a real encode), static web build. |
| `inspect FILE`  | Full analysis without changes. Uses ffprobe for videos when available (`--no-probe` to skip); inspecting never requires FFmpeg.       |
| `validate FILE` | Integrity (ZIP, CRC, `content.xml`), references and download manifest, as a verdict.                                                  |
| `optimize FILE` | Builds the plan (`--dry-run` stops there) and runs it, writing `<name>_optimized.elpx`.                                               |
| `serve`         | Serves the static web app (`dist/web`). GET/HEAD only: no upload or processing API.                                                   |

Global options: `--json` (exactly one JSON document on stdout, nothing else), `--quiet` (no
progress on stderr), `--help`/`-h`, `--version`/`-v`. Progress, messages and errors always go to
stderr; binary data is never written to stdout. `<command> --help` lists every option.

## Examples

```bash
elpx-optimizer doctor
elpx-optimizer inspect "curso.elpx" --json
elpx-optimizer validate "curso.elpx" --json
elpx-optimizer optimize "curso.elpx" --preset balanced --dry-run --json
elpx-optimizer optimize "curso.elpx" --preset balanced \
  --remove-unused safe --deduplicate exact \
  --output "curso_optimized.elpx" --report "curso_optimization.json"
elpx-optimizer optimize "curso.elpx" --no-video --image-quality 85 --strip-metadata
elpx-optimizer optimize "curso.elpx" --exclude "content/resources/intro.mp4" --video-max-resolution 720
elpx-optimizer serve --host 127.0.0.1 --port 8080
elpx-optimizer serve --base /tools/elpx/ --isolation      # subdirectory + COOP/COEP (multi-thread core)
```

## optimize options

| Option                                   | Values                                                                                                                                                            | Default                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `--output PATH`                          | output file; must not be the input (also checked through symlinks/hard links)                                                                                     | `<name>_optimized.elpx` next to the input |
| `--overwrite`                            | allow replacing an existing output (never the input)                                                                                                              | refuse                                    |
| `--report PATH`                          | also write the JSON report (the plan for `--dry-run`)                                                                                                             | —                                         |
| `--dry-run`                              | print the plan only                                                                                                                                               | —                                         |
| `--preset`                               | `conservative`, `balanced`, `aggressive`                                                                                                                          | `balanced`                                |
| `--config FILE`                          | JSON with the same keys as the web app (`{"preset": ..., "video": {...}, "images": {...}, "removeUnused": ..., "deduplicate": ..., "exclude": [...]}`); flags win | —                                         |
| `--no-video`, `--no-images`              | skip a media type                                                                                                                                                 | enabled                                   |
| `--remove-unused`                        | `off`, `safe` (only resources with no reference of any kind)                                                                                                      | `off`                                     |
| `--deduplicate`                          | `off`, `exact` (byte-identical binary media, references rewritten)                                                                                                | `off`                                     |
| `--exclude PATH`                         | ZIP path to leave untouched (repeatable)                                                                                                                          | —                                         |
| `--video-crf`                            | 16–35                                                                                                                                                             | 20 / 23 / 28 by preset                    |
| `--video-max-resolution`                 | 360, 480, 720, 1080, 1440, 2160 (short side) or `original`                                                                                                        | 1080 / 1080 / 720                         |
| `--video-audio-bitrate`                  | 64–320 kb/s, for audio that must be converted                                                                                                                     | 192 / 128 / 96                            |
| `--video-x264-preset`                    | `ultrafast` … `veryslow`                                                                                                                                          | `slow` / `medium` / `medium`              |
| `--video-force`                          | re-encode sources that already look efficient                                                                                                                     | off                                       |
| `--video-drop-data-streams`              | allow dropping timecode/telemetry streams                                                                                                                         | off (such videos are kept)                |
| `--image-quality`                        | JPEG quality 30–100                                                                                                                                               | 90 / 82 / 72                              |
| `--webp-quality`                         | 30–100                                                                                                                                                            | 90 / 82 / 75                              |
| `--image-max-dimension`                  | pixels or `none`                                                                                                                                                  | none / none / 1920                        |
| `--no-png`                               | do not recompress PNG                                                                                                                                             | recompress (lossless)                     |
| `--strip-metadata`                       | remove EXIF/XMP/IPTC/text (ICC kept; EXIF kept when it holds a rotation)                                                                                          | keep                                      |
| `--image-force`                          | re-encode images that already look efficient                                                                                                                      | off                                       |
| `--include-screenshot`                   | also optimize `screenshot.png` (lossless only)                                                                                                                    | off                                       |
| `--min-savings-percent`                  | minimum saving to replace a resource                                                                                                                              | 5                                         |
| `--min-savings-bytes`                    | minimum saving in bytes (videos: at least 10240)                                                                                                                  | 1024                                      |
| `--threads`                              | FFmpeg encoder threads                                                                                                                                            | min(4, cores − 1)                         |
| `--image-concurrency`                    | parallel image jobs                                                                                                                                               | min(4, cores − 1)                         |
| `--timeout-video`                        | seconds per video                                                                                                                                                 | 7200                                      |
| `--max-archive-size`, `--max-video-size` | bytes                                                                                                                                                             | 16 GiB, 8 GiB                             |
| `--temp-dir`                             | parent of the private temporary directory                                                                                                                         | OS temp dir                               |
| `--ffmpeg`, `--ffprobe`                  | tool paths (also `ELPX_OPTIMIZER_FFMPEG`, `ELPX_OPTIMIZER_FFPROBE`)                                                                                               | `PATH`                                    |

## Exit codes

| Code | Meaning                                                                                                                                                                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | Success: `optimized`, `no-improvement` (byte copy delivered), dry run, `inspect` ok, `validate` valid (warnings allowed).                                                                    |
| 1    | Operational failure (I/O error, our own output failed its final validation). Nothing is delivered.                                                                                           |
| 2    | Usage error: unknown command/flag, invalid value, output exists without `--overwrite`, output equals the input.                                                                              |
| 3    | Invalid input: not a ZIP, legacy `.elp` (eXeLearning ≤ 2.x), not an eXeLearning project, corrupt or unsafe archive, limits exceeded.                                                         |
| 4    | Partial: `optimize` delivered a valid, smaller file but some operations failed (their originals were kept); `validate` found errors such as missing resources (or warnings with `--strict`). |
| 5    | Missing dependency (`doctor` found an unavailable capability).                                                                                                                               |
| 130  | Cancelled (Ctrl+C / SIGTERM). FFmpeg processes are killed with their process group, temporary files are removed and no output is written.                                                    |

Warnings (e.g. an external link, a lenient match) never change the exit code of `optimize`; a
failed operation does (4), because the user asked for something that was not done.

## JSON documents

All documents carry `schema` and `schemaVersion`.

- `inspect` → `elpx-optimizer/analysis`: `ok`, `input` (name, size, sha256), `package` (variant
  `v4`/`v3`, title, pages, components, iDevice types, screenshot/manifest/search index presence),
  `totals`, `entries[]` (path, size, compressedSize, method, role, kind, format, mime,
  extensionMatches, usage and reasons, references, referencedFrom, representations,
  resolutionSensitive, duplicateGroup, image or video properties), `references[]` (value, form,
  status, target, lenient rule, kind, representation, location, layers, rewritable), `duplicates[]`,
  `diagnostics[]` (see [diagnostics.md](diagnostics.md)), `media`.
- `optimize --dry-run` → `elpx-optimizer/dry-run` with `plan` (`elpx-optimizer/plan`: input hash,
  normalized options and hash, engine versions and capabilities, `operations[]`, `skipped[]` with
  stable reason codes, `risks[]`, `estimate` explicitly labelled as an estimate, `planHash`).
- `optimize` → `elpx-optimizer/report`: `status` (`optimized`, `partial`, `no-improvement`,
  `failed`, `cancelled`, `invalid-input`), tool/engine versions, input and output sha256, options,
  plan hash, measured `sizes`, `operations[]` (`applied`, `reverted`, `failed` with before/after sizes,
  lossy flag, conversions, checks passed), `skipped[]`, `diagnostics.before/introduced/resolved`,
  `validations[]`, `risks[]`. No absolute paths and no educational content.
- `validate` → `elpx-optimizer/validation`: `verdict` (`valid`, `valid-with-warnings`, `invalid`,
  `unusable`), `checks[]` (`name`, `status`: `passed` | `failed` | `not-run`, `ok` = passed, `detail`;
  checks that could not run because the project could not be analyzed that far are `not-run` and
  shown with "–" in text output), `diagnostics[]`.
- `doctor` → `elpx-optimizer/doctor`: runtime, versions, capabilities, checks.

## Installation

The CLI runs on Node ≥ 22 or Bun ≥ 1.3. Video needs ffmpeg and ffprobe (with libx264); images need
sharp, which ships prebuilt libvips binaries for common platforms.

### From a checkout

```bash
bun install --frozen-lockfile
bun scripts/build-cli.ts                     # dist/cli/elpx-optimizer.mjs + package.json
node dist/cli/elpx-optimizer.mjs doctor
# or install the packed CLI: (cd dist/cli && npm pack) && npm install -g dist/cli/elpx-optimizer-cli-*.tgz
```

### Ubuntu Server (22.04/24.04)

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg nodejs npm   # Node 22+ (e.g. NodeSource) or Bun
npm install -g ./elpx-optimizer-cli-0.1.0.tgz                      # from the CI artifact or a local build
elpx-optimizer doctor
```

### macOS (Homebrew)

```bash
brew install ffmpeg node        # or: brew install oven-sh/bun/bun
npm install -g ./elpx-optimizer-cli-0.1.0.tgz
elpx-optimizer doctor
```

### Windows

Native Windows has not been tested. Use Docker (Docker Desktop):

```powershell
docker build --target cli -t elpx-optimizer-cli .
docker run --rm -v "${PWD}:/work" elpx-optimizer-cli optimize /work/curso.elpx
```

### Docker CLI image

The `cli` target (Alpine, Bun, ffmpeg, sharp) runs as a non-root user. Recommended limits:

```bash
docker run --rm --read-only --tmpfs /tmp --memory 2g --cpus 2 --pids-limit 256 \
  -v "$PWD:/work" elpx-optimizer-cli optimize /work/curso.elpx --report /work/informe.json
```

## Security notes

- FFmpeg runs with an argument vector (no shell), a private temporary directory with synthetic file
  names (user names never reach the file system or FFmpeg), a minimal environment, `-nostdin`,
  `-protocol_whitelist file`, a forced demuxer, `-enable_drefs 0`, a time limit, and is killed with
  its whole process group on cancellation or timeout. There is no way to pass FFmpeg arguments.
- The output is written to a temporary file next to the destination and renamed into place only
  after the result was re-read and validated. Disk space is checked before extracting media.
