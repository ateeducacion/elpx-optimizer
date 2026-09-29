# elpx-optimizer

[![Coverage](https://codecov.io/gh/ateeducacion/elpx-optimizer/graph/badge.svg)](https://codecov.io/gh/ateeducacion/elpx-optimizer)
[![GitHub Pages](https://img.shields.io/github/deployments/ateeducacion/elpx-optimizer/github-pages?label=GitHub%20Pages&logo=github)](https://ateeducacion.github.io/elpx-optimizer/)
[![ghcr.io](https://img.shields.io/github/v/release/ateeducacion/elpx-optimizer?label=ghcr.io&logo=docker&logoColor=white)](https://github.com/orgs/ateeducacion/packages?repo_name=elpx-optimizer)

Shrinks [eXeLearning](https://github.com/exelearning/exelearning) projects (`.elpx`): it recompresses
videos, images, audio and PDFs, finds missing, unused and duplicate resources, and writes a new
`name_optimized.elpx` that stays editable in eXeLearning. The original file is never modified.

[Leer en español](README.es.md)

## Use it

- **Web app**: <https://ateeducacion.github.io/elpx-optimizer/>. Everything runs in your browser;
  the project is never uploaded.
- **CLI** with Docker (FFmpeg, sharp and qpdf included):

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/course.elpx --dry-run
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/course.elpx
  ```

- **Web app on your own server**: `docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer`,
  or the static build from a [release](https://github.com/ateeducacion/elpx-optimizer/releases) on
  any static host.
- **Agent Skill**: `elpx-optimizer-skill.zip` from a release lets AI agents inspect and optimize
  projects through the CLI.

Installing the CLI without Docker (npm package, Node or Bun), every option and the JSON output:
[docs/cli.md](docs/cli.md).

## What it does

- **Recompresses** videos (H.264/AAC), images (JPEG, PNG, WebP, with a maximum size), audio (WAV,
  AIFF and FLAC become MP3) and PDFs (rewritten with qpdf; signed and encrypted ones are left alone).
- **Finds** missing, unused and duplicate resources. On request it removes unused files, merges
  duplicates, moves eXeLearning 3 folders, cleans file names and takes out references to missing
  files.
- **Verifies** every result and keeps the original when a result is not valid or not smaller; the
  new package is analyzed again.

Three presets: conservative, balanced (default) and maximum. What each one changes:
[docs/profiles.md](docs/profiles.md).

## Documentation

[Web app](docs/web.md) · [CLI](docs/cli.md) · [Agent Skill](docs/skill.md) ·
[Presets and quality](docs/profiles.md) · [Architecture](docs/architecture.md) ·
[Diagnostics](docs/diagnostics.md) · [Design decisions](docs/decisions.md) ·
[Testing](docs/testing.md) · [eXeLearning format review](docs/upstream-review.md)

Development: `bun install` and `make help`; see [CONTRIBUTING.md](CONTRIBUTING.md) and
[AGENTS.md](AGENTS.md). Security: [SECURITY.md](SECURITY.md).

## License

AGPL-3.0-or-later. Third-party components keep their licenses; the web build ships FFmpeg
(GPL-2.0-or-later) and qpdf (Apache-2.0): see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The
ATE logo belongs to the Área de Tecnología Educativa of the Government of the Canary Islands and is
not covered by the project's license.
