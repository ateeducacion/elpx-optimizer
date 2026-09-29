# elpx-optimizer

Analiza y reduce el tamaño de proyectos de [eXeLearning](https://github.com/exelearning/exelearning)
(`.elpx`). Recomprime vídeos e imágenes, detecta recursos ausentes, sin uso y duplicados, y genera un
`nombre_optimized.elpx` nuevo que se sigue pudiendo editar en eXeLearning. El archivo original no se
modifica nunca.

Tres formas de usarlo con un único núcleo compartido:

- **Web**: una página estática HTML/JavaScript/WebAssembly. **Los vídeos se recodifican dentro de tu
  navegador con ffmpeg.wasm; el proyecto no se sube a ningún servidor.** El servidor solo entrega
  archivos estáticos.
- **CLI** (`elpx-optimizer`): Bun o Node, con FFmpeg/ffprobe nativos para vídeo y sharp (libvips) para imágenes.
- **Agent Skill** (`skills/elpx-optimizer`): permite a agentes de IA inspeccionar, explicar y optimizar
  proyectos a través del CLI.

[Read in English](README.md)

## Qué hace

1. **Analiza sin modificar nada**: estructura e integridad del ZIP (CRC, tamaños, ZIP64, nombres
   peligrosos), `content.xml`, páginas, iDevices y todas las referencias de la representación editable
   (`content.xml`) y la publicada (`index.html`, `html/*.html`, `search_index.js`, CSS), incluido el JSON
   de los iDevices, los datos de los juegos (DataGame) y el JSON del vídeo interactivo.
2. **Informa** del inventario (tamaños, formatos, pistas de vídeo, propiedades de imágenes, uso), de los
   duplicados y de diagnósticos estructurados con la página, el bloque, el iDevice y el campo afectados.
3. **Planifica** operaciones explícitas y versionadas (el mismo plan en `--dry-run` y en la vista previa web).
4. **Optimiza**: vídeo a H.264/AAC en el mismo contenedor y extensión (se conservan duración, pistas de
   audio, idiomas, subtítulos, capítulos y relación de aspecto); JPEG/WebP recodificados y PNG/WebP sin
   pérdida recomprimidos sin cambiar ni un píxel; se mantienen metadatos y perfiles de color. Opcionalmente,
   elimina de forma segura archivos sin ninguna referencia y unifica duplicados exactos reescribiendo sus
   referencias.
5. **Verifica**: cada resultado se inspecciona y se decodifica entero; el paquete nuevo se vuelve a abrir
   y a analizar y se compara con el original. Si no se consigue reducir el tamaño, se entrega una copia
   idéntica (`no-improvement`).

## Inicio rápido

### Web

```bash
bun install
bun run build:web                 # genera la web estática en dist/web
bun src/cli/bin.ts serve          # o cualquier servidor estático; abre http://127.0.0.1:8080
```

Sirve en cualquier alojamiento estático (nginx, Apache, GitHub Pages, S3...), también en un
subdirectorio. Navegadores, límites de memoria, núcleo multihilo opcional (cabeceras COOP/COEP) y
privacidad: [docs/web.md](docs/web.md).

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

Instalación en Ubuntu, macOS y Windows (Docker), todas las opciones, los JSON y los códigos de salida:
[docs/cli.md](docs/cli.md) (en inglés).

### Agent Skill

`skills/elpx-optimizer` sigue la [especificación Agent Skills](https://agentskills.io/specification).
La versión distribuible (con el CLI incluido) se genera con `make build-skill`; ver [docs/skill.md](docs/skill.md).

### Docker

```bash
docker build --target web -t elpx-optimizer-web .   # web estática (nginx, sin ffmpeg ni API)
docker run --rm -p 8080:8080 elpx-optimizer-web
docker build --target cli -t elpx-optimizer-cli .   # CLI con ffmpeg y sharp
docker run --rm -v "$PWD:/work" elpx-optimizer-cli optimize /work/curso.elpx
```

## Niveles

| Nivel                     | Vídeo                     | Imágenes                                                 |
| ------------------------- | ------------------------- | -------------------------------------------------------- |
| conservador               | H.264 CRF 20, hasta 1080p | JPEG q90, WebP q90                                       |
| equilibrado (por defecto) | H.264 CRF 23, hasta 1080p | JPEG q82, WebP q82                                       |
| agresivo                  | H.264 CRF 28, hasta 720p  | JPEG q72, WebP q75, imágenes de más de 1920 px reducidas |

Recodificar vídeo y JPEG implica pérdida de calidad. PNG y WebP sin pérdida nunca pierden calidad.
Si un resultado no es válido o no ahorra lo suficiente, se conserva el original. Detalles:
[docs/profiles.md](docs/profiles.md).

## Privacidad

La web no tiene API: el proyecto se lee en tu navegador y la descarga se genera allí mismo. Las pruebas
E2E comprueban que la página solo pide sus propios archivos estáticos (GET) y nunca envía el proyecto,
sus nombres ni su contenido. El CLI funciona sin red. Los informes no incluyen rutas absolutas ni el
contenido educativo.

## Licencia

AGPL-3.0-or-later. Los componentes de terceros mantienen sus licencias; la web incluye FFmpeg
(GPL-2.0-or-later, mediante ffmpeg.wasm). Ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
