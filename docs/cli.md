# CLI

```
elpx-optimizer <command> [options]
```

| Command         | What it does                                                                                                                                                                                                 |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `doctor`        | Runtime, ffmpeg/ffprobe (version, video and audio encoders, a real 0.5 s libx264 encode + probe and a separate 0.3 s audio encode + probe, `audio-encode`), sharp/libvips (a real encode), static web build. |
| `inspect FILE`  | Full analysis without changes. Uses ffprobe for videos and audio when available (`--no-probe` to skip); inspecting never requires FFmpeg.                                                                    |
| `validate FILE` | Integrity (ZIP, CRC, `content.xml`), references and download manifest, as a verdict.                                                                                                                         |
| `optimize FILE` | Builds the plan (`--dry-run` stops there) and runs it, writing `<name>_optimized.elpx`.                                                                                                                      |
| `serve`         | Serves the static web app (`dist/web`). GET/HEAD only: no upload or processing API.                                                                                                                          |

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
elpx-optimizer optimize "curso.elpx" --flatten legacy --dry-run      # eXeLearning 3 folders → content/resources/
elpx-optimizer optimize "curso.elpx" --normalize-names slug          # "Copia de Foto Clase (2).JPG" → foto-clase.jpg
elpx-optimizer optimize "curso.elpx" --preset maximum                # same as --preset aggressive
elpx-optimizer optimize "curso.elpx" --missing-references remove     # opt-in: take out references to missing files
elpx-optimizer optimize "curso.elpx" --no-video --image-quality 85 --strip-metadata
elpx-optimizer optimize "curso.elpx" --audio-bitrate 96              # WAV/AIFF/FLAC → MP3 at 96 kb/s stereo
elpx-optimizer optimize "curso.elpx" --no-audio                      # leave every audio file as it is
elpx-optimizer optimize "curso.elpx" --exclude "content/resources/intro.mp4" --video-max-resolution 720
elpx-optimizer serve --host 127.0.0.1 --port 8080
elpx-optimizer serve --base /tools/elpx/ --isolation      # subdirectory + COOP/COEP (multi-thread core)
```

## optimize options

| Option                                    | Values                                                                                                                                                                                                                                             | Default                                   |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `--output PATH`                           | output file; must not be the input (also checked through symlinks/hard links)                                                                                                                                                                      | `<name>_optimized.elpx` next to the input |
| `--overwrite`                             | allow replacing an existing output (never the input)                                                                                                                                                                                               | refuse                                    |
| `--report PATH`                           | also write the JSON report (the plan for `--dry-run`)                                                                                                                                                                                              | —                                         |
| `--dry-run`                               | print the plan only                                                                                                                                                                                                                                | —                                         |
| `--preset`                                | `conservative`, `balanced`, `aggressive` (`maximum` is an alias: the web app calls it "Maximum"; plans and reports say `aggressive`)                                                                                                               | `balanced`                                |
| `--config FILE`                           | JSON with the same keys as the web app (`{"preset": ..., "video": {...}, "images": {...}, "audio": {...}, "removeUnused": ..., "deduplicate": ..., "flatten": ..., "missingReferences": ..., "normalizeNames": ..., "exclude": [...]}`); flags win | —                                         |
| `--no-video`, `--no-images`, `--no-audio` | skip a media type                                                                                                                                                                                                                                  | enabled                                   |
| `--remove-unused`                         | `off`, `safe` (only resources with no reference of any kind)                                                                                                                                                                                       | `off`                                     |
| `--deduplicate`                           | `off`, `exact` (byte-identical binary media, references rewritten)                                                                                                                                                                                 | `off`                                     |
| `--flatten`                               | `off`, `legacy` (move files out of eXeLearning 3 folders `content/resources/<ODE-ID>/` into `content/resources/`, references rewritten)                                                                                                            | `off`                                     |
| `--normalize-names`                       | `off`, `slug` (clean file names: lower case, no spaces, accents or copy markers; references rewritten)                                                                                                                                             | `off` (the web app turns it on)           |
| `--missing-references`                    | `keep`, `remove` (take out references to files that do not exist)                                                                                                                                                                                  | `keep`                                    |
| `--exclude PATH`                          | ZIP path to leave untouched (repeatable)                                                                                                                                                                                                           | —                                         |
| `--video-crf`                             | 16–35                                                                                                                                                                                                                                              | 20 / 23 / 28 by preset                    |
| `--video-max-resolution`                  | 360, 480, 720, 1080, 1440, 2160 (short side) or `original`                                                                                                                                                                                         | 1080 / 1080 / 720                         |
| `--video-audio-bitrate`                   | 64–320 kb/s, for audio tracks inside videos that must be converted                                                                                                                                                                                 | 192 / 128 / 96                            |
| `--video-x264-preset`                     | `ultrafast` … `veryslow`                                                                                                                                                                                                                           | `slow` / `medium` / `medium`              |
| `--video-force`                           | re-encode sources that already look efficient                                                                                                                                                                                                      | off                                       |
| `--video-drop-data-streams`               | allow dropping timecode/telemetry streams                                                                                                                                                                                                          | off (such videos are kept)                |
| `--image-quality`                         | JPEG quality 30–100                                                                                                                                                                                                                                | 90 / 82 / 72                              |
| `--webp-quality`                          | 30–100                                                                                                                                                                                                                                             | 90 / 82 / 75                              |
| `--image-max-dimension`                   | long side in pixels, or `none`                                                                                                                                                                                                                     | 2560 / 1920 / 1600                        |
| `--no-png`                                | do not recompress PNG                                                                                                                                                                                                                              | recompress (lossless)                     |
| `--strip-metadata`                        | remove EXIF/XMP/IPTC/text (ICC kept; EXIF kept when it holds a rotation)                                                                                                                                                                           | keep                                      |
| `--image-force`                           | re-encode images that already look efficient                                                                                                                                                                                                       | off                                       |
| `--include-screenshot`                    | also optimize `screenshot.png` (lossless only)                                                                                                                                                                                                     | off                                       |
| `--audio-bitrate`                         | 64–320 kb/s, MP3/AAC stereo target; mono uses half (at least 64), Opus half of those (see profiles.md)                                                                                                                                             | 192 / 128 / 96                            |
| `--audio-force`                           | re-encode MP3/M4A/Opus files even when their bitrate is below 1.4 × the target                                                                                                                                                                     | off                                       |
| `--min-savings-percent`                   | minimum saving to replace a resource                                                                                                                                                                                                               | 5                                         |
| `--min-savings-bytes`                     | minimum saving in bytes (videos: at least 10240)                                                                                                                                                                                                   | 1024                                      |
| `--threads`                               | FFmpeg encoder threads                                                                                                                                                                                                                             | min(4, cores − 1)                         |
| `--image-concurrency`                     | parallel image jobs; also the number of audio files encoded at once                                                                                                                                                                                | min(4, cores − 1)                         |
| `--timeout-video`                         | seconds per video or audio file                                                                                                                                                                                                                    | 7200                                      |
| `--max-archive-size`, `--max-video-size`  | bytes (the video limit also applies to audio files)                                                                                                                                                                                                | 16 GiB, 8 GiB                             |
| `--temp-dir`                              | parent of the private temporary directory                                                                                                                                                                                                          | OS temp dir                               |
| `--ffmpeg`, `--ffprobe`                   | tool paths (also `ELPX_OPTIMIZER_FFMPEG`, `ELPX_OPTIMIZER_FFPROBE`)                                                                                                                                                                                | `PATH`                                    |

What each option changes, and when files are left alone, is described in
[profiles.md](profiles.md). In short:

- **Audio**: WAV, AIFF and FLAC become MP3 and are **renamed** to `.mp3`; their references (and
  the `type` attribute of the element that holds them) are rewritten and verified. A file whose
  references cannot all follow the new name is left unchanged. MP3, M4A and Opus (WebM/Ogg) keep
  their format and name. `--no-audio` leaves every audio file untouched.
- **`--flatten legacy`**: only folders named like eXeLearning 3 ODE-IDs (14 digits and 6 upper-case
  letters or digits) are flattened; folders created by the user are never touched. `inspect` reports
  such folders with the `legacy-resource-folders` diagnostic.
- **`--normalize-names slug`**: only file names change (folders and `custom/` are untouched); a
  taken name gets `-2`, `-3`…; files with dynamic or lenient references, inside HTML/script bundles
  or holding references themselves keep their names.
- **`--missing-references remove`** is an explicit opt-in: by default a missing file is reported and
  its references stay as they are. With it, broken images and media players are deleted, links keep
  their text, and references that cannot be taken out safely (in CSS or in running text) are listed
  with the reason.

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
  `v4`/`v3`, title, pages, components, iDevice types, screenshot/manifest/search index presence,
  `legacyFolders` with the number of eXeLearning 3 editor `folders` and the `files` in them),
  `totals` (including `videoBytes`, `imageBytes` and `audioBytes`), `entries[]` (path, size,
  compressedSize, method, role, kind, format, mime, extensionMatches, usage and reasons, references,
  referencedFrom, representations, resolutionSensitive, duplicateGroup, image or video/audio
  properties), `references[]` (value, form, status, target, lenient rule, kind, representation,
  location, layers, rewritable), `duplicates[]`, `diagnostics[]` (see
  [diagnostics.md](diagnostics.md)), `media`.
- `optimize --dry-run` → `elpx-optimizer/dry-run` with `plan` (`elpx-optimizer/plan`: input hash,
  normalized options and hash, engine versions and capabilities, `operations[]`, `skipped[]` with
  stable reason codes, `risks[]`, `estimate` explicitly labelled as an estimate, `planHash`).
- `optimize` → `elpx-optimizer/report`: `status` (`optimized`, `partial`, `no-improvement`,
  `failed`, `cancelled`, `invalid-input`), tool/engine versions, input and output sha256, options,
  plan hash, measured `sizes`, `operations[]` (`applied`, `reverted`, `failed` with before/after sizes,
  lossy flag, conversions, checks passed, `detail`), `skipped[]`, `diagnostics.before/introduced/resolved`,
  `validations[]`, `risks[]`. No absolute paths and no educational content.
- `validate` → `elpx-optimizer/validation`: `verdict` (`valid`, `valid-with-warnings`, `invalid`,
  `unusable`), `checks[]` (`name`, `status`: `passed` | `failed` | `not-run`, `ok` = passed, `detail`;
  checks that could not run because the project could not be analyzed that far are `not-run` and
  shown with "–" in text output), `diagnostics[]`.
- `doctor` → `elpx-optimizer/doctor`: runtime, versions, `capabilities` (`inspect`, `validate`,
  `video`, `audio` with its encoders among `libmp3lame`, `aac` and `libopus`, `image`, `web`), checks.

Plan operations (`op`), in the plan and, with their outcome, in the report:

| `op`                       | Fields besides `id`                                                                  | Meaning                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `transcode-video`          | `path`, `size`, `lossy`, `conversions`, `job`, `estimatedBytes`                      | Re-encode a video in its own container.                                                                             |
| `recompress-image`         | `path`, `size`, `lossy`, `conversions`, `job`, `estimatedBytes`                      | Recompress an image in its own format.                                                                              |
| `transcode-audio`          | `path`, `size`, `lossy`, `conversions`, `job`, `to` (when renamed), `estimatedBytes` | Convert WAV/AIFF/FLAC to MP3 (`to` is the new `.mp3` path) or re-encode MP3/M4A/Opus in place.                      |
| `remove-unused`            | `path`, `size`, `reason`                                                             | Remove a file with no reference of any kind.                                                                        |
| `deduplicate`              | `keep`, `remove[]`, `size`, `references`                                             | Keep one of several identical files and point the others' references to it.                                         |
| `move-resource`            | `path`, `to`, `size`, `references`                                                   | Move a file out of an eXeLearning 3 folder (`--flatten legacy`), with its clean name when `--normalize-names slug`. |
| `rename-resource`          | `path`, `to`, `size`, `references`                                                   | Give a file a clean name in its folder (`--normalize-names slug`).                                                  |
| `remove-missing-reference` | `path`, `references`, `actions` (`element`, `attribute`, `value`), `entries[]`       | Take out the references to one missing file (`--missing-references remove`).                                        |
| `rewrite-references`       | `path`, `edits`, `reason`                                                            | Text entry (`content.xml`, a page, `search_index.js`…) whose references change.                                     |
| `update-manifest`          | `path`, `reason`                                                                     | Regenerate `libs/elpx-manifest.js` after files are removed, merged, moved or renamed.                               |

`skipped[]` entries have a `kind` (`video`, `image`, `audio`, `unused`, `duplicate`, `flatten`,
`rename`, `missing-reference`), a `reason` code and a human-readable `detail`. Moving or renaming
files and taking out broken references are changes the user asked for: when they apply, the new
package is delivered even if it is not smaller (it is not replaced by a `no-improvement` copy).

## Installation

The CLI runs on Node ≥ 22 or Bun ≥ 1.3. Video and audio need ffmpeg and ffprobe (with libx264 for
video, libmp3lame for MP3); images need sharp, which ships prebuilt libvips binaries for common
platforms.

### Docker (no local dependencies)

Each GitHub release publishes two images on the GitHub Container Registry, for `linux/amd64` and
`linux/arm64`, tagged `latest`, `X.Y.Z` and `X.Y`:

- `ghcr.io/ateeducacion/elpx-optimizer-cli`: the CLI (Alpine, Bun, ffmpeg, sharp), non-root, working
  directory `/work`;
- `ghcr.io/ateeducacion/elpx-optimizer`: the static web app on nginx (port 8080, see [web.md](web.md)).

```bash
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli doctor
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli inspect /work/curso.elpx
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx --dry-run
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx \
  --remove-unused safe --deduplicate exact
```

The output (`curso_optimized.elpx`) is written next to the input in the mounted folder. Recommended
limits for untrusted projects:

```bash
docker run --rm --read-only --tmpfs /tmp --memory 2g --cpus 2 --pids-limit 256 \
  -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx --report /work/informe.json
```

To build the same image from a checkout: `docker build --target cli -t elpx-optimizer-cli .`.

### From a release

Every GitHub release (https://github.com/ateeducacion/elpx-optimizer/releases) also carries
`elpx-optimizer-cli-X.Y.Z.tgz` (the CLI package), `elpx-optimizer-skill.zip` (the Agent Skill, see
[skill.md](skill.md)) and `elpx-optimizer-web.tar.gz` (the static web app).

```bash
npm install -g ./elpx-optimizer-cli-X.Y.Z.tgz      # installs sharp from npm
elpx-optimizer doctor
```

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
npm install -g ./elpx-optimizer-cli-X.Y.Z.tgz                      # from a release or a local build
elpx-optimizer doctor
```

### macOS (Homebrew)

```bash
brew install ffmpeg node        # or: brew install oven-sh/bun/bun
npm install -g ./elpx-optimizer-cli-X.Y.Z.tgz
elpx-optimizer doctor
```

### Windows

Native Windows has not been tested. Use Docker (Docker Desktop), from PowerShell:

```powershell
docker run --rm -v "${PWD}:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx
```

## Security notes

- FFmpeg runs with an argument vector (no shell), a private temporary directory with synthetic file
  names (user names never reach the file system or FFmpeg), a minimal environment, `-nostdin`,
  `-protocol_whitelist file`, a forced demuxer, `-enable_drefs 0` for MP4-family inputs, a time
  limit, and is killed with its whole process group on cancellation or timeout. Audio files are
  processed under the same rules. There is no way to pass FFmpeg arguments.
- The output is written to a temporary file next to the destination and renamed into place only
  after the result was re-read and validated. Disk space is checked before extracting media.
