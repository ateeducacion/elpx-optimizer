# elpx-optimizer

Analyze and shrink [eXeLearning](https://github.com/exelearning/exelearning) projects (`.elpx`).
It recompresses videos, images, audio and PDFs, finds missing, unused and duplicate resources, can
tidy eXeLearning 3 folders and file names, and writes a new `name_optimized.elpx` that stays
editable in eXeLearning. The original file is never modified.

Three ways to use it, one shared core:

- **Web app**: a static HTML/JavaScript/WebAssembly page. **Videos and audio are re-encoded inside
  your browser with ffmpeg.wasm and PDFs are rewritten with qpdf (WebAssembly); the project is never
  uploaded.** The server only serves static files.
- **CLI** (`elpx-optimizer`): Bun or Node, native FFmpeg/ffprobe for video and audio, sharp
  (libvips) for images and the same qpdf (WebAssembly, nothing to install) for PDFs.
- **Agent Skill** (`skills/elpx-optimizer`): lets AI agents inspect, explain and optimize projects through the CLI.

[Leer en español](README.es.md)

## What it does

1. **Analyzes without changing anything**: ZIP structure and integrity (CRC, sizes, ZIP64, hostile
   names), `content.xml`, pages, iDevices, and every reference in the editable (`content.xml`) and
   published (`index.html`, `html/*.html`, `search_index.js`, CSS) representations, including JSON
   inside iDevices, DataGame payloads and the interactive-video JSON.
2. **Reports** an inventory (sizes, formats, video and audio streams, image properties, usage),
   duplicates and structured diagnostics with the page, block, iDevice and field where each problem is.
3. **Plans** explicit, versioned operations (the same plan for `--dry-run` and the web preview).
4. **Optimizes**:
   - videos to H.264/AAC in the same container and extension (duration, audio tracks, languages,
     subtitles, chapters and aspect ratio preserved);
   - JPEG/WebP re-encoded, PNG and lossless WebP recompressed without changing a pixel; images
     larger than the preset's limit (2560, 1920 or 1600 px) downscaled; metadata and colour
     profiles kept;
   - WAV, AIFF and FLAC recordings converted to MP3 and renamed to `.mp3`, with their references
     and `type` attributes rewritten; MP3, M4A and Opus (WebM/Ogg) re-encoded in place only when
     their bitrate is far above the target;
   - PDFs rewritten by qpdf without re-rendering (text, fonts, links, bookmarks, forms and tags are
     kept): streams recompressed and packed into object streams, and, except in the conservative
     preset, images that are not JPEG converted to JPEG where that makes them smaller
     (`--pdf-lossless` turns that off). Encrypted and signed PDFs are left untouched.
5. **Cleans up, only when asked**: safe removal of unreferenced files; exact deduplication; clean
   file names (`Copia de Foto Clase (2).JPG` → `foto-clase.jpg`; on by default in the web app);
   moving files out of eXeLearning 3 editor folders (`content/resources/<ODE-ID>/`) into
   `content/resources/`; and taking out references to files that do not exist (by default they are
   reported, not hidden). Every moved, merged or renamed file is verified by resolving every
   reference of the package again.
6. **Verifies**: every candidate is probed and fully decoded (a PDF must pass `qpdf --check` with no
   warnings and keep its page count); the new package is reopened and re-analyzed against the original. If nothing gets smaller (and nothing was moved or cleaned up),
   you get a byte-for-byte copy (`no-improvement`).

Two real courses, CLI with the balanced preset and no clean-up (before the default image size
limits existed): 210.7 → 65.5 MiB (−68.9 %) for one whose audio was mostly WAV, and
128.2 → 91.1 MiB (−28.9 %) for one with 255 Opus voice recordings and large photos. With clean file
names and the current defaults the first one goes to 64.7 MiB (−69.3 %). In the browser, with the
web app's defaults, the two courses shrink by 69.3 % and 31.7 % in 96 s and 141 s of processing
([docs/web.md](docs/web.md#measured-cases)). The CLI results still import and re-export in
eXeLearning with no differences, and the compatibility check with eXeLearning's own importer and
exporters passes on all 17 of its cases.

## Quick start

### Web app

Each release is deployed to the repository's GitHub Pages site and published as a Docker image:

```bash
docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer   # open http://localhost:8080
```

From a checkout:

```bash
bun install
bun run build:web                 # writes the static site to dist/web
bun src/cli/bin.ts serve          # or any static web server; open http://127.0.0.1:8080
```

Any static host works (nginx, Apache, GitHub Pages, S3...). The app uses relative paths, so it
can live in a subdirectory. See [docs/web.md](docs/web.md) for browsers, memory limits, the
optional multi-thread core (COOP/COEP headers) and the privacy guarantees.

### CLI

With Docker, nothing else to install (the image includes FFmpeg, sharp and qpdf):

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli inspect /work/curso.elpx
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx --dry-run
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx \
  --remove-unused safe --deduplicate exact
```

From a checkout (Node ≥ 22 or Bun ≥ 1.3, plus ffmpeg/ffprobe for video and audio; PDFs need nothing
extra, qpdf comes from npm as WebAssembly):

```bash
bun install && bun run build:cli
node dist/cli/elpx-optimizer.mjs doctor
node dist/cli/elpx-optimizer.mjs inspect "curso.elpx" --json
node dist/cli/elpx-optimizer.mjs validate "curso.elpx" --json
node dist/cli/elpx-optimizer.mjs optimize "curso.elpx" --preset balanced --dry-run --json
node dist/cli/elpx-optimizer.mjs optimize "curso.elpx" --preset balanced \
  --remove-unused safe --deduplicate exact --flatten legacy --normalize-names slug \
  --output "curso_optimized.elpx" --report "curso_optimization.json"
```

Installation on Ubuntu, macOS and Windows, the release package, every flag, the JSON documents and
exit codes: [docs/cli.md](docs/cli.md).

### Agent Skill

`skills/elpx-optimizer` follows the [Agent Skills specification](https://agentskills.io/specification).
Download `elpx-optimizer-skill.zip` from a release (the CLI is bundled) or build it with
`make build-skill`; see [docs/skill.md](docs/skill.md).

## Releases

Every published GitHub release ([releases](https://github.com/ateeducacion/elpx-optimizer/releases)):

- pushes `ghcr.io/ateeducacion/elpx-optimizer` (web app, nginx) and
  `ghcr.io/ateeducacion/elpx-optimizer-cli` (CLI with ffmpeg, sharp and qpdf), tagged `latest`,
  `X.Y.Z` and `X.Y`, for `linux/amd64` and `linux/arm64`;
- deploys the web app to GitHub Pages (single-thread FFmpeg: Pages cannot send the COOP/COEP
  headers the multi-thread core needs; the single-thread qpdf build used for PDFs does not need
  them);
- attaches `elpx-optimizer-cli-X.Y.Z.tgz`, `elpx-optimizer-skill.zip` and
  `elpx-optimizer-web.tar.gz` to the release.

The images can also be built locally: `docker build --target web -t elpx-optimizer-web .` and
`docker build --target cli -t elpx-optimizer-cli .`.

## Presets

| Preset (id)                    | Video                     | Images                      | Audio files      | PDFs                                    |
| ------------------------------ | ------------------------- | --------------------------- | ---------------- | --------------------------------------- |
| Conservative (`conservative`)  | H.264 CRF 20, up to 1080p | JPEG q90, WebP q90, 2560 px | MP3/AAC 192 kb/s | lossless                                |
| Balanced (`balanced`, default) | H.264 CRF 23, up to 1080p | JPEG q82, WebP q82, 1920 px | MP3/AAC 128 kb/s | lossless + images to JPEG where smaller |
| Maximum (`aggressive`)         | H.264 CRF 28, up to 720p  | JPEG q72, WebP q75, 1600 px | MP3/AAC 96 kb/s  | lossless + images to JPEG where smaller |

The pixel sizes are the longest side beyond which images are downscaled (`--image-max-dimension`
changes it, `none` disables it). The CLI also accepts `--preset maximum`; plans and reports use the
id `aggressive`. Audio bitrates are for stereo; mono uses half (at least 64 kb/s) and Opus half of
those. Re-encoding video, audio and JPEG is lossy. PNG and lossless WebP are compressed without loss.
PDFs have no quality setting: the presets only decide whether their images may become JPEG (never
already-JPEG ones, which are not re-encoded).
Clean-up options are off by default in the CLI; the web app turns on clean file names. Details,
advanced options and quality risks: [docs/profiles.md](docs/profiles.md).

## Documentation

- [Architecture](docs/architecture.md) — portable core, adapters, references, restructuring, plan/execute/verify.
- [Web app](docs/web.md) — in-browser processing, interface, browsers, limits, deployment, privacy.
- [CLI](docs/cli.md) — commands, options, JSON, exit codes, installation.
- [Agent Skill](docs/skill.md) — installation and tested mechanisms.
- [Presets and quality](docs/profiles.md) — what changes and what is kept, audio, clean-up options.
- [Diagnostics](docs/diagnostics.md) — stable codes.
- [eXeLearning format review](docs/upstream-review.md) — verified against upstream at `406a2158`.
- [Design decisions](docs/decisions.md) — reuse of upstream code, Pixo evaluation, ZIP handling,
  flattening, audio conversion, reference removal, interface, PDF engine, dependency updates.
- [Testing](docs/testing.md) — suites, coverage, E2E, compatibility check with eXeLearning.
- [Security](SECURITY.md), [Contributing](CONTRIBUTING.md), [Agents](AGENTS.md),
  [Third-party notices](THIRD-PARTY-NOTICES.md).

## License

AGPL-3.0-or-later. Bundled third-party components keep their licenses; the web build ships
FFmpeg (GPL-2.0-or-later, via ffmpeg.wasm) and qpdf (Apache-2.0, via qpdf-wasm), see
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
The ATE logo belongs to the Área de Tecnología Educativa of the Government of the Canary Islands
and is not covered by the project's license.
