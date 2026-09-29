# Third-party notices

elpx-optimizer is licensed under AGPL-3.0-or-later (see `LICENSE`). It uses and, in its builds,
redistributes the following components under their own licenses. License texts are copied into the
web build (`dist/web/licenses/`) and are available in `node_modules/<package>` after installation.

## Web app (bundled into `dist/web`)

| Component                         | Version | License          | Notes                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @ffmpeg/ffmpeg (ffmpeg.wasm)      | 0.12.15 | MIT              | JavaScript API and worker.                                                                                                                                                                                                                                                                                                    |
| @ffmpeg/types                     | 0.12.4  | MIT              |                                                                                                                                                                                                                                                                                                                               |
| @ffmpeg/core                      | 0.12.10 | GPL-2.0-or-later | FFmpeg compiled to WebAssembly (single-thread). Includes libx264 and libx265 (GPL-2.0-or-later), libvpx (BSD-3-Clause), LAME (LGPL-2.0-or-later), libopus, libvorbis, libogg, libtheora (BSD), libwebp (BSD-3-Clause), zlib, FreeType (FTL/GPL-2.0), FriBidi (LGPL-2.1-or-later), HarfBuzz (MIT), libass (ISC), zimg (WTFPL). |
| @ffmpeg/core-mt                   | 0.12.10 | GPL-2.0-or-later | Multi-thread build of the same, loaded only under cross-origin isolation.                                                                                                                                                                                                                                                     |
| @jsquash/jpeg                     | 1.6.0   | Apache-2.0       | MozJPEG / libjpeg-turbo codec: IJG License, BSD-3-Clause and zlib licenses (`codec/LICENSE.codec.md`).                                                                                                                                                                                                                        |
| @jsquash/oxipng                   | 2.3.0   | Apache-2.0       | OxiPNG: MIT.                                                                                                                                                                                                                                                                                                                  |
| @jsquash/png                      | 3.1.1   | Apache-2.0       | Codec: BSD-3-Clause.                                                                                                                                                                                                                                                                                                          |
| @jsquash/webp                     | 1.5.0   | Apache-2.0       | libwebp: BSD-3-Clause.                                                                                                                                                                                                                                                                                                        |
| @jsquash/resize                   | 2.1.1   | Apache-2.0       | resize crate (MIT), hqx (Apache-2.0), magic-kernel (MIT).                                                                                                                                                                                                                                                                     |
| wasm-feature-detect               | 1.9.0   | Apache-2.0       |                                                                                                                                                                                                                                                                                                                               |
| @fontsource/atkinson-hyperlegible | 5.3.0   | OFL-1.1          | Atkinson Hyperlegible font (Braille Institute).                                                                                                                                                                                                                                                                               |
| fflate                            | 0.8.3   | MIT              | DEFLATE/INFLATE.                                                                                                                                                                                                                                                                                                              |
| parse5                            | 8.0.1   | MIT              | HTML parser.                                                                                                                                                                                                                                                                                                                  |
| entities                          | 8.1.0   | BSD-2-Clause     | HTML character references.                                                                                                                                                                                                                                                                                                    |
| @noble/hashes                     | 2.4.0   | MIT              | SHA-256.                                                                                                                                                                                                                                                                                                                      |

**GPL source availability.** The FFmpeg WebAssembly binaries in `dist/web/assets/ffmpeg-core-*.wasm`
are the unmodified npm artefacts `@ffmpeg/core@0.12.10` and `@ffmpeg/core-mt@0.12.10`. Their
corresponding source (build scripts and the exact FFmpeg and library sources) is published at
https://github.com/ffmpegwasm/ffmpeg.wasm (tag `v0.12.10`); FFmpeg's own source is at
https://ffmpeg.org/download.html. Anyone who hosts the web app redistributes these binaries and
must keep this notice and the license texts available.

## CLI and skill

| Component                               | Version  | License                         | Notes                                                                                                       |
| --------------------------------------- | -------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| sharp                                   | 0.35.5   | Apache-2.0                      | Loaded at run time (external to the bundle).                                                                |
| @img/sharp-libvips-*                    | 1.3.4    | LGPL-3.0-or-later               | Prebuilt libvips (with mozjpeg, libpng, libwebp, lcms2...) installed by sharp per platform.                 |
| @img/colour, detect-libc, semver        | —        | MIT, Apache-2.0, ISC            | sharp dependencies.                                                                                         |
| fflate, parse5, entities, @noble/hashes | as above | as above                        | Bundled into `dist/cli/elpx-optimizer.mjs`.                                                                 |
| FFmpeg / ffprobe                        | system   | LGPL/GPL depending on the build | Not distributed with the CLI; installed by the user or in the Docker `cli` image (Alpine `ffmpeg` package). |

## eXeLearning

eXeLearning (https://github.com/exelearning/exelearning) is AGPL-3.0-or-later. No eXeLearning source
code is included in the product. The fixtures in `test/fixtures/upstream/` come from the eXeLearning
repository at `406a2158623da1862e9f50fdfd5e358b818c9aa8` under its license (see
`test/fixtures/upstream/PROVENANCE.md`). The compatibility check downloads and runs eXeLearning at that
commit in `.cache/` (not distributed).

## Docker images

- `web`: `nginxinc/nginx-unprivileged` (nginx: BSD-2-Clause; Alpine packages under their licenses).
- `cli`: `oven/bun` (Bun: MIT, with bundled components under their licenses) and Alpine's `ffmpeg`
  package (GPL build).
