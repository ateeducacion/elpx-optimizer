# elpx-optimizer

Analyze and shrink [eXeLearning](https://github.com/exelearning/exelearning) projects (`.elpx`).
It recompresses videos and images, finds missing, unused and duplicate resources, and writes a
new `name_optimized.elpx` that stays editable in eXeLearning. The original file is never modified.

Three ways to use it, one shared core:

- **Web app**: a static HTML/JavaScript/WebAssembly page. **Videos are re-encoded inside your
  browser with ffmpeg.wasm; the project is never uploaded.** The server only serves static files.
- **CLI** (`elpx-optimizer`): Bun or Node, native FFmpeg/ffprobe for video and sharp (libvips) for images.
- **Agent Skill** (`skills/elpx-optimizer`): lets AI agents inspect, explain and optimize projects through the CLI.

[Leer en español](README.es.md)

## What it does

1. **Analyzes without changing anything**: ZIP structure and integrity (CRC, sizes, ZIP64, hostile
   names), `content.xml`, pages, iDevices, and every reference in the editable (`content.xml`) and
   published (`index.html`, `html/*.html`, `search_index.js`, CSS) representations, including JSON
   inside iDevices, DataGame payloads and the interactive-video JSON.
2. **Reports** an inventory (sizes, formats, video streams, image properties, usage), duplicates and
   structured diagnostics with the page, block, iDevice and field where each problem is.
3. **Plans** explicit, versioned operations (the same plan for `--dry-run` and the web preview).
4. **Optimizes**: videos to H.264/AAC in the same container and extension (duration, audio tracks,
   languages, subtitles, chapters and aspect ratio preserved); JPEG/WebP re-encoded, PNG and lossless
   WebP recompressed without changing a pixel; metadata and colour profiles kept. Optional safe
   removal of unreferenced files and exact deduplication with reference rewriting.
5. **Verifies**: every candidate is probed and fully decoded; the new package is reopened and
   re-analyzed against the original. If nothing gets smaller, you get a byte-for-byte copy
   (`no-improvement`).

## Quick start

### Web app

```bash
bun install
bun run build:web                 # writes the static site to dist/web
bun src/cli/bin.ts serve          # or any static web server; open http://127.0.0.1:8080
```

Any static host works (nginx, Apache, GitHub Pages, S3...). The app uses relative paths, so it
can live in a subdirectory. See [docs/web.md](docs/web.md) for browsers, memory limits, the
optional multi-thread core (COOP/COEP headers) and the privacy guarantees.

### CLI

```bash
bun install && bun run build:cli
node dist/cli/elpx-optimizer.mjs doctor
node dist/cli/elpx-optimizer.mjs inspect "curso.elpx" --json
node dist/cli/elpx-optimizer.mjs validate "curso.elpx" --json
node dist/cli/elpx-optimizer.mjs optimize "curso.elpx" --preset balanced --dry-run --json
node dist/cli/elpx-optimizer.mjs optimize "curso.elpx" --preset balanced \
  --remove-unused safe --deduplicate exact \
  --output "curso_optimized.elpx" --report "curso_optimization.json"
```

Installation on Ubuntu, macOS and Windows (Docker), every flag, the JSON documents and exit codes:
[docs/cli.md](docs/cli.md).

### Agent Skill

`skills/elpx-optimizer` follows the [Agent Skills specification](https://agentskills.io/specification).
Build the distributable version (with the CLI bundled) with `make build-skill`; see [docs/skill.md](docs/skill.md).

### Docker

```bash
docker build --target web -t elpx-optimizer-web .   # static site (nginx, no ffmpeg, no API)
docker run --rm -p 8080:8080 elpx-optimizer-web
docker build --target cli -t elpx-optimizer-cli .   # CLI with ffmpeg and sharp
docker run --rm -v "$PWD:/work" elpx-optimizer-cli optimize /work/curso.elpx
```

## Presets

| Preset             | Video                     | Images                                                    |
| ------------------ | ------------------------- | --------------------------------------------------------- |
| conservative       | H.264 CRF 20, up to 1080p | JPEG q90, WebP q90                                        |
| balanced (default) | H.264 CRF 23, up to 1080p | JPEG q82, WebP q82                                        |
| aggressive         | H.264 CRF 28, up to 720p  | JPEG q72, WebP q75, images larger than 1920 px downscaled |

Re-encoding video and JPEG is lossy. PNG and lossless WebP are never lossy. Details, advanced
options and quality risks: [docs/profiles.md](docs/profiles.md).

## Documentation

- [Architecture](docs/architecture.md) — portable core, adapters, references, plan/execute/verify.
- [Web app](docs/web.md) — in-browser processing, browsers, limits, deployment, privacy.
- [CLI](docs/cli.md) — commands, options, JSON, exit codes, installation.
- [Agent Skill](docs/skill.md) — installation and tested mechanisms.
- [Presets and quality](docs/profiles.md) — what changes and what is kept.
- [Diagnostics](docs/diagnostics.md) — stable codes.
- [eXeLearning format review](docs/upstream-review.md) — verified against upstream at `406a2158`.
- [Design decisions](docs/decisions.md) — reuse of upstream code, Pixo evaluation, ZIP handling.
- [Testing](docs/testing.md) — suites, coverage, E2E, compatibility check with eXeLearning.
- [Security](SECURITY.md), [Contributing](CONTRIBUTING.md), [Agents](AGENTS.md),
  [Third-party notices](THIRD-PARTY-NOTICES.md).

## License

AGPL-3.0-or-later. Bundled third-party components keep their licenses; the web build ships
FFmpeg (GPL-2.0-or-later, via ffmpeg.wasm), see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
