# elpx-optimizer

Analiza y reduce el tamaño de proyectos de [eXeLearning](https://github.com/exelearning/exelearning)
(`.elpx`). Recomprime vídeos, imágenes y audio, detecta recursos ausentes, sin uso y duplicados, puede
ordenar las carpetas de eXeLearning 3 y los nombres de archivo, y genera un `nombre_optimized.elpx`
nuevo que se sigue pudiendo editar en eXeLearning. El archivo original no se modifica nunca.

Tres formas de usarlo con un único núcleo compartido:

- **Web**: una página estática HTML/JavaScript/WebAssembly. **Los vídeos y el audio se recodifican
  dentro de tu navegador con ffmpeg.wasm; el proyecto no se sube a ningún servidor.** El servidor
  solo entrega archivos estáticos.
- **CLI** (`elpx-optimizer`): Bun o Node, con FFmpeg/ffprobe nativos para vídeo y audio y sharp
  (libvips) para imágenes.
- **Agent Skill** (`skills/elpx-optimizer`): permite a agentes de IA inspeccionar, explicar y optimizar
  proyectos a través del CLI.

[Read in English](README.md)

## Qué hace

1. **Analiza sin modificar nada**: estructura e integridad del ZIP (CRC, tamaños, ZIP64, nombres
   peligrosos), `content.xml`, páginas, iDevices y todas las referencias de la representación editable
   (`content.xml`) y la publicada (`index.html`, `html/*.html`, `search_index.js`, CSS), incluido el JSON
   de los iDevices, los datos de los juegos (DataGame) y el JSON del vídeo interactivo.
2. **Informa** del inventario (tamaños, formatos, pistas de vídeo y audio, propiedades de imágenes, uso),
   de los duplicados y de diagnósticos estructurados con la página, el bloque, el iDevice y el campo
   afectados.
3. **Planifica** operaciones explícitas y versionadas (el mismo plan en `--dry-run` y en la vista previa web).
4. **Optimiza**:
   - vídeo a H.264/AAC en el mismo contenedor y extensión (se conservan duración, pistas de audio,
     idiomas, subtítulos, capítulos y relación de aspecto);
   - JPEG/WebP recodificados y PNG/WebP sin pérdida recomprimidos sin cambiar ni un píxel; las
     imágenes mayores que el límite del nivel (2560, 1920 o 1600 px) se reducen; se mantienen
     metadatos y perfiles de color;
   - grabaciones WAV, AIFF y FLAC convertidas a MP3 y renombradas a `.mp3`, reescribiendo sus
     referencias y sus atributos `type`; los MP3, M4A y Opus (WebM/Ogg) solo se recodifican, con el
     mismo nombre, cuando su tasa de bits está muy por encima del objetivo.
5. **Limpia, solo si se pide**: elimina de forma segura archivos sin ninguna referencia; unifica
   duplicados exactos; limpia los nombres de archivo (`Copia de Foto Clase (2).JPG` →
   `foto-clase.jpg`; activado por defecto en la web); saca los archivos de las carpetas del editor de
   eXeLearning 3
   (`content/resources/<ID-ODE>/`) a `content/resources/`; y quita las referencias a archivos que no
   existen (por defecto se informa de ellas, no se ocultan). Cada archivo movido, unificado o
   renombrado se comprueba volviendo a resolver todas las referencias del paquete.
6. **Verifica**: cada resultado se inspecciona y se decodifica entero; el paquete nuevo se vuelve a abrir
   y a analizar y se compara con el original. Si no se consigue reducir el tamaño (y no se ha movido ni
   limpiado nada), se entrega una copia idéntica (`no-improvement`).

Dos cursos reales, con el CLI en el nivel equilibrado y sin limpieza (antes de que existieran los
límites de tamaño de imagen por defecto): de 210,7 a 65,5 MiB (−68,9 %) uno con el audio casi todo en
WAV, y de 128,2 a 91,1 MiB (−28,9 %) otro con 255 grabaciones de voz en Opus y fotos grandes. Con
nombres limpios y los valores por defecto actuales, el primero queda en 64,7 MiB (−69,3 %). Los
resultados se siguen importando y reexportando en eXeLearning sin diferencias.

## Inicio rápido

### Web

Cada versión publicada se despliega en el sitio de GitHub Pages del repositorio y como imagen Docker:

```bash
docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer   # abre http://localhost:8080
```

Desde el código fuente:

```bash
bun install
bun run build:web                 # genera la web estática en dist/web
bun src/cli/bin.ts serve          # o cualquier servidor estático; abre http://127.0.0.1:8080
```

Sirve en cualquier alojamiento estático (nginx, Apache, GitHub Pages, S3...), también en un
subdirectorio. Navegadores, límites de memoria, núcleo multihilo opcional (cabeceras COOP/COEP) y
privacidad: [docs/web.md](docs/web.md) (en inglés).

### CLI

Con Docker no hace falta instalar nada más (la imagen incluye FFmpeg y sharp):

```bash
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli inspect /work/curso.elpx
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx --dry-run
docker run --rm -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli optimize /work/curso.elpx \
  --remove-unused safe --deduplicate exact
```

Desde el código fuente (Node ≥ 22 o Bun ≥ 1.3, más ffmpeg/ffprobe para vídeo y audio):

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

Instalación en Ubuntu, macOS y Windows, el paquete de cada versión, todas las opciones, los JSON y los
códigos de salida: [docs/cli.md](docs/cli.md) (en inglés).

### Agent Skill

`skills/elpx-optimizer` sigue la [especificación Agent Skills](https://agentskills.io/specification).
Descarga `elpx-optimizer-skill.zip` de una versión publicada (incluye el CLI) o genérala con
`make build-skill`; ver [docs/skill.md](docs/skill.md).

## Versiones publicadas

Cada versión publicada en GitHub ([releases](https://github.com/ateeducacion/elpx-optimizer/releases)):

- sube `ghcr.io/ateeducacion/elpx-optimizer` (web, nginx) y `ghcr.io/ateeducacion/elpx-optimizer-cli`
  (CLI con ffmpeg y sharp), con las etiquetas `latest`, `X.Y.Z` y `X.Y`, para `linux/amd64` y
  `linux/arm64`;
- despliega la web en GitHub Pages (FFmpeg de un solo hilo: Pages no puede enviar las cabeceras
  COOP/COEP que necesita el núcleo multihilo);
- adjunta `elpx-optimizer-cli-X.Y.Z.tgz`, `elpx-optimizer-skill.zip` y `elpx-optimizer-web.tar.gz`.

Las imágenes también se pueden construir en local: `docker build --target web -t elpx-optimizer-web .`
y `docker build --target cli -t elpx-optimizer-cli .`.

## Niveles

| Nivel (id)                            | Vídeo                     | Imágenes                    | Archivos de audio |
| ------------------------------------- | ------------------------- | --------------------------- | ----------------- |
| Conservador (`conservative`)          | H.264 CRF 20, hasta 1080p | JPEG q90, WebP q90, 2560 px | MP3/AAC 192 kb/s  |
| Equilibrado (`balanced`, por defecto) | H.264 CRF 23, hasta 1080p | JPEG q82, WebP q82, 1920 px | MP3/AAC 128 kb/s  |
| Máximo (`aggressive`)                 | H.264 CRF 28, hasta 720p  | JPEG q72, WebP q75, 1600 px | MP3/AAC 96 kb/s   |

Los píxeles son el lado mayor a partir del cual se reducen las imágenes (`--image-max-dimension` lo
cambia y `none` lo desactiva; en la web, «Tamaño máximo de las imágenes»). El CLI también acepta
`--preset maximum`; los planes e informes usan el id `aggressive`. Las tasas de audio son para
estéreo; el mono usa la mitad (como mínimo 64 kb/s) y Opus la mitad de esas. Recodificar vídeo, audio
y JPEG implica pérdida de calidad. PNG y WebP sin pérdida se comprimen sin perder nada. Si un
resultado no es válido o no ahorra lo suficiente, se conserva el original. Las opciones de limpieza
están desactivadas por defecto en el CLI; la web activa la limpieza de nombres. Detalles:
[docs/profiles.md](docs/profiles.md) (en inglés).

## Privacidad

La web no tiene API: el proyecto se lee en tu navegador y la descarga se genera allí mismo. Las pruebas
E2E comprueban que la página solo pide sus propios archivos estáticos (GET) y nunca envía el proyecto,
sus nombres ni su contenido. Las vistas previas de imágenes, audio y vídeo se extraen también en el
navegador. El CLI funciona sin red. Los informes no incluyen rutas absolutas ni el contenido educativo.

## Licencia

AGPL-3.0-or-later. Los componentes de terceros mantienen sus licencias; la web incluye FFmpeg
(GPL-2.0-or-later, mediante ffmpeg.wasm). Ver [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). El
logotipo del ATE es propiedad del Área de Tecnología Educativa del Gobierno de Canarias y no está
cubierto por la licencia del proyecto.
