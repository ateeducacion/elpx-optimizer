# elpx-optimizer

[![npm](https://img.shields.io/npm/v/elpx-optimizer?logo=npm)](https://www.npmjs.com/package/elpx-optimizer)
[![Docker Hub](https://img.shields.io/docker/pulls/ateeducacion/elpx-optimizer?label=Docker%20Hub%20pulls&logo=docker&logoColor=white)](https://hub.docker.com/r/ateeducacion/elpx-optimizer)
[![GitHub Pages](https://img.shields.io/github/deployments/ateeducacion/elpx-optimizer/github-pages?label=web&logo=github)](https://ateeducacion.github.io/elpx-optimizer/)
[![Cobertura](https://codecov.io/gh/ateeducacion/elpx-optimizer/graph/badge.svg)](https://codecov.io/gh/ateeducacion/elpx-optimizer)

[![elpx-optimizer](src/web/public/social-card.png)](https://ateeducacion.github.io/elpx-optimizer/)

Aligera los proyectos de [eXeLearning](https://github.com/exelearning/exelearning) (`.elpx`): vídeos,
imágenes, audio y PDF más ligeros, en un proyecto que se sigue pudiendo editar en eXeLearning. El
original no se toca.

[Read in English](README.md)

## Web

**[ateeducacion.github.io/elpx-optimizer](https://ateeducacion.github.io/elpx-optimizer/)**: suelta
tu `.elpx` y descarga el resultado. Todo se procesa en tu navegador; no se sube nada.

## Línea de órdenes

```bash
npx elpx-optimizer optimize curso.elpx
```

```bash
docker run --rm -u $(id -u) -v "$PWD:/work" ateeducacion/elpx-optimizer optimize curso.elpx
```

Los dos crean `curso_optimized.elpx` junto al original. Añade `--dry-run` para ver antes el plan.
`npx` necesita Node.js 22 y FFmpeg para vídeo y audio; la imagen de Docker lo incluye todo.
[Todas las opciones →](docs/cli.md) (en inglés)

## Qué hace

- **Recomprime** vídeos, imágenes, audio y PDF, y solo se queda con la versión nueva si es válida y
  más pequeña.
- **Encuentra** archivos que faltan, sin uso o duplicados; si se lo pides, los quita, los unifica y
  les da nombres limpios.
- **Renueva** la miniatura del proyecto a partir de su primera página o de una imagen que elijas.
- **Verifica** el paquete completo otra vez antes de entregártelo.

También como [Agent Skill](docs/skill.md) para asistentes de IA.

## Más

[Niveles y calidad](docs/profiles.md) · [Web](docs/web.md) · [CLI](docs/cli.md) ·
[Arquitectura](docs/architecture.md) · [Diagnósticos](docs/diagnostics.md) ·
[Decisiones de diseño](docs/decisions.md) · [Pruebas](docs/testing.md) · [npm](docs/npm.md) ·
[Formato de eXeLearning](docs/upstream-review.md) · [Contribuir](CONTRIBUTING.md) ·
[Seguridad](SECURITY.md) (documentación en inglés)

AGPL-3.0-or-later. Los componentes de terceros conservan sus licencias; ver
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Hecho por el Área de Tecnología Educativa del
Gobierno de Canarias, cuyo logotipo no está cubierto por la licencia del proyecto.
