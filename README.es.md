# elpx-optimizer

[![Cobertura](https://codecov.io/gh/ateeducacion/elpx-optimizer/graph/badge.svg)](https://codecov.io/gh/ateeducacion/elpx-optimizer)
[![GitHub Pages](https://img.shields.io/github/deployments/ateeducacion/elpx-optimizer/github-pages?label=GitHub%20Pages&logo=github)](https://ateeducacion.github.io/elpx-optimizer/)
[![ghcr.io](https://img.shields.io/github/v/release/ateeducacion/elpx-optimizer?label=ghcr.io&logo=docker&logoColor=white)](https://github.com/orgs/ateeducacion/packages?repo_name=elpx-optimizer)
[![npm](https://img.shields.io/npm/v/elpx-optimizer?logo=npm)](https://www.npmjs.com/package/elpx-optimizer)
[![Docker Hub](https://img.shields.io/docker/pulls/ateeducacion/elpx-optimizer?label=Docker%20Hub%20pulls&logo=docker&logoColor=white)](https://hub.docker.com/r/ateeducacion/elpx-optimizer)

Reduce el tamaño de proyectos de [eXeLearning](https://github.com/exelearning/exelearning) (`.elpx`):
recomprime vídeos, imágenes, audio y PDF, detecta recursos ausentes, sin uso y duplicados, y genera
un `nombre_optimized.elpx` nuevo que se sigue pudiendo editar en eXeLearning. El archivo original no
se modifica nunca.

[Read in English](README.md)

## Cómo usarlo

- **Web**: <https://ateeducacion.github.io/elpx-optimizer/>. Todo se procesa en tu navegador; el
  proyecto no se sube a ningún servidor.
- **CLI** con Docker (incluye FFmpeg, sharp y qpdf; también en Docker Hub como `ateeducacion/elpx-optimizer`):

  ```bash
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer optimize /work/curso.elpx --dry-run
  docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer optimize /work/curso.elpx
  ```

- **Web en tu propio servidor**: la web estática de una
  [versión publicada](https://github.com/ateeducacion/elpx-optimizer/releases) en cualquier
  alojamiento estático.
- **Agent Skill**: `elpx-optimizer-skill.zip` de una versión publicada permite a agentes de IA
  inspeccionar y optimizar proyectos a través del CLI.

Instalar el CLI sin Docker (paquete npm, Node o Bun), todas las opciones y la salida JSON:
[docs/cli.md](docs/cli.md) (en inglés).

## Qué hace

- **Recomprime** vídeos (H.264/AAC), imágenes (JPEG, PNG y WebP, con tamaño máximo), audio (los WAV,
  AIFF y FLAC pasan a MP3) y PDF (los reescribe qpdf; los firmados y cifrados no se tocan).
- **Detecta** recursos ausentes, sin uso y duplicados. Si se le pide, quita los archivos sin uso,
  unifica los duplicados, ordena las carpetas de eXeLearning 3, limpia los nombres de archivo y
  retira las referencias a archivos que no existen.
- **Comprueba** cada resultado y conserva el original si no es válido o no ocupa menos; el paquete
  nuevo se vuelve a analizar.

Tres niveles: conservador, equilibrado (el predeterminado) y máximo. Qué cambia cada uno:
[docs/profiles.md](docs/profiles.md) (en inglés).

## Documentación

[Web](docs/web.md) · [CLI](docs/cli.md) · [Agent Skill](docs/skill.md) ·
[Niveles y calidad](docs/profiles.md) · [Arquitectura](docs/architecture.md) ·
[Diagnósticos](docs/diagnostics.md) · [Decisiones de diseño](docs/decisions.md) ·
[Pruebas](docs/testing.md) · [Publicación en npm](docs/npm.md) ·
[Revisión del formato de eXeLearning](docs/upstream-review.md) (en inglés)

Desarrollo: `bun install` y `make help`; ver [CONTRIBUTING.md](CONTRIBUTING.md) y
[AGENTS.md](AGENTS.md). Seguridad: [SECURITY.md](SECURITY.md).

## Licencia

AGPL-3.0-or-later. Los componentes de terceros conservan sus licencias; la web incluye FFmpeg
(GPL-2.0-or-later) y qpdf (Apache-2.0): ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). El
logotipo del ATE pertenece al Área de Tecnología Educativa del Gobierno de Canarias y no está cubierto
por la licencia del proyecto.
