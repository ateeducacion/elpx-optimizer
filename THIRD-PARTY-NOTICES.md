# Third-party notices

elpx-optimizer is licensed under AGPL-3.0-or-later (see `LICENSE`). It uses and, in its builds,
redistributes the following components under their own licenses. License texts are available in
`node_modules/<package>` after installation, and the web build copies them to `dist/web/licenses/`
(see below), where the app's licenses panel links to them.

## Web app (bundled into `dist/web`)

| Component                         | Version | License                          | Notes                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------- | ------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| @ffmpeg/ffmpeg (ffmpeg.wasm)      | 0.12.15 | MIT                              | JavaScript API and worker.                                                                                                                                                                                                                                                                                                                                           |
| @ffmpeg/types                     | 0.12.4  | MIT                              |                                                                                                                                                                                                                                                                                                                                                                      |
| @ffmpeg/core                      | 0.12.10 | GPL-2.0-or-later                 | FFmpeg compiled to WebAssembly (single-thread). Includes libx264 and libx265 (GPL-2.0-or-later), libvpx (BSD-3-Clause), LAME (LGPL-2.0-or-later, used to encode MP3 audio), libopus (Opus audio), libvorbis, libogg, libtheora (BSD), libwebp (BSD-3-Clause), zlib, FreeType (FTL/GPL-2.0), FriBidi (LGPL-2.1-or-later), HarfBuzz (MIT), libass (ISC), zimg (WTFPL). |
| @ffmpeg/core-mt                   | 0.12.10 | GPL-2.0-or-later                 | Multi-thread build of the same, loaded only under cross-origin isolation.                                                                                                                                                                                                                                                                                            |
| @jsquash/jpeg                     | 1.6.0   | Apache-2.0                       | MozJPEG / libjpeg-turbo codec: IJG License, BSD-3-Clause and zlib licenses (`codec/LICENSE.codec.md`).                                                                                                                                                                                                                                                               |
| @jsquash/oxipng                   | 2.3.0   | Apache-2.0                       | OxiPNG: MIT.                                                                                                                                                                                                                                                                                                                                                         |
| @jsquash/png                      | 3.1.1   | Apache-2.0                       | Codec: BSD-3-Clause.                                                                                                                                                                                                                                                                                                                                                 |
| @jsquash/webp                     | 1.5.0   | Apache-2.0                       | libwebp: BSD-3-Clause.                                                                                                                                                                                                                                                                                                                                               |
| @jsquash/resize                   | 2.1.1   | Apache-2.0                       | resize crate (MIT), hqx (Apache-2.0), magic-kernel (MIT).                                                                                                                                                                                                                                                                                                            |
| @neslinesli93/qpdf-wasm           | 0.3.0   | ISC (wrapper), Apache-2.0 (qpdf) | qpdf 12.2.0 compiled to WebAssembly (single-thread), rewrites PDFs in a worker. Includes zlib 1.2.12 (Zlib) and libjpeg-turbo (IJG, BSD-3-Clause, Zlib). Shipped as `dist/web/assets/qpdf-*.wasm` and `pdf.worker-*.js`; notices in `qpdf-wasm-NOTICES.txt`.                                                                                                         |
| bootstrap                         | 5.3.8   | MIT                              | CSS compiled from its Sass sources into the app's stylesheet (only the modules the interface uses); its JavaScript is not included.                                                                                                                                                                                                                                  |
| bootstrap-icons                   | 1.13.1  | MIT                              | Individual SVG icons embedded as text in the app's JavaScript.                                                                                                                                                                                                                                                                                                       |
| wasm-feature-detect               | 1.9.0   | Apache-2.0                       |                                                                                                                                                                                                                                                                                                                                                                      |
| @fontsource/atkinson-hyperlegible | 5.3.0   | OFL-1.1                          | Atkinson Hyperlegible font (Braille Institute).                                                                                                                                                                                                                                                                                                                      |
| fflate                            | 0.8.3   | MIT                              | DEFLATE/INFLATE.                                                                                                                                                                                                                                                                                                                                                     |
| parse5                            | 8.0.1   | MIT                              | HTML parser.                                                                                                                                                                                                                                                                                                                                                         |
| entities                          | 8.1.0   | BSD-2-Clause                     | HTML character references.                                                                                                                                                                                                                                                                                                                                           |
| @noble/hashes                     | 2.4.0   | MIT                              | SHA-256.                                                                                                                                                                                                                                                                                                                                                             |

**GPL source availability.** The FFmpeg WebAssembly binaries in `dist/web/assets/ffmpeg-core-*.wasm`
are the unmodified npm artefacts `@ffmpeg/core@0.12.10` and `@ffmpeg/core-mt@0.12.10`. Their
corresponding source (build scripts and the exact FFmpeg and library sources) is published at
https://github.com/ffmpegwasm/ffmpeg.wasm (tag `v0.12.10`); FFmpeg's own source is at
https://ffmpeg.org/download.html. Anyone who hosts the web app redistributes these binaries and
must keep this notice and the license texts available.

**qpdf.** `dist/web/assets/qpdf-*.wasm` is the unmodified npm artefact of
`@neslinesli93/qpdf-wasm@0.3.0` (`dist/qpdf.wasm`), built from qpdf 12.2.0
(https://github.com/qpdf/qpdf, Apache-2.0, with its NOTICE and LICENSE in `qpdf-wasm-NOTICES.txt`),
zlib 1.2.12 and libjpeg-turbo; the build scripts are at https://github.com/neslinesli93/qpdf-wasm.
The npm package itself declares the ISC license.

**License files in the web build.** `vite build` copies these texts into `dist/web/licenses/`:
`elpx-optimizer-AGPL-3.0.txt` (this project), `THIRD-PARTY-NOTICES.txt` (this file),
`ffmpeg-core-GPL-2.0.txt`, `ffmpeg.wasm-MIT.txt`, `qpdf-wasm-NOTICES.txt`,
`mozjpeg-libjpeg-turbo.txt`, `libwebp.txt`, `png-codec.txt`, `oxipng.txt`, `resize.txt`, `hqx.txt`,
`magic-kernel.txt`, `jsquash-Apache-2.0.txt`, `atkinson-hyperlegible-OFL-1.1.txt`,
`bootstrap-MIT.txt`, `bootstrap-icons-MIT.txt`, `fflate-MIT.txt`, `parse5-MIT.txt`,
`entities-BSD-2-Clause.txt`, `noble-hashes-MIT.txt` and `wasm-feature-detect-Apache-2.0.txt` (the
list is `licensesPlugin` in `vite.config.ts`).

**Build-time only.** Sass (`sass` 1.105.0, MIT) compiles Bootstrap and the app's theme during the
build. It is not redistributed: only the resulting CSS is part of `dist/web`.

**ATE logo.** `src/web/assets/ate-logo.png`, shown in the footer and in the licenses panel of the
web app, is the logo of the Área de Tecnología Educativa (ATE) of the Gobierno de Canarias and
belongs to it. It is not covered by the project's license.

## CLI and skill

| Component                               | Version  | License                          | Notes                                                                                                                                                                                     |
| --------------------------------------- | -------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| sharp                                   | 0.35.5   | Apache-2.0                       | Loaded at run time (external to the bundle).                                                                                                                                              |
| @img/sharp-libvips-*                    | 1.3.4    | LGPL-3.0-or-later                | Prebuilt libvips (with mozjpeg, libpng, libwebp, lcms2...) installed by sharp per platform.                                                                                               |
| @img/colour, detect-libc, semver        | —        | MIT, Apache-2.0, ISC             | sharp dependencies.                                                                                                                                                                       |
| @neslinesli93/qpdf-wasm                 | 0.3.0    | ISC (wrapper), Apache-2.0 (qpdf) | qpdf 12.2.0 as WebAssembly (with zlib and libjpeg-turbo, as above). Installed from npm with the CLI and run at run time by `qpdf-runner.mjs` in a child process (external to the bundle). |
| fflate, parse5, entities, @noble/hashes | as above | as above                         | Bundled into `dist/cli/elpx-optimizer.mjs`.                                                                                                                                               |
| FFmpeg / ffprobe                        | system   | LGPL/GPL depending on the build  | Not distributed with the CLI; installed by the user or in the Docker `cli` image (Alpine `ffmpeg` package).                                                                               |

## eXeLearning

eXeLearning (https://github.com/exelearning/exelearning) is AGPL-3.0-or-later. No eXeLearning source
code is included in the product. The fixtures in `test/fixtures/upstream/` come from the eXeLearning
repository at `406a2158623da1862e9f50fdfd5e358b818c9aa8` under its license (see
`test/fixtures/upstream/PROVENANCE.md`). The compatibility check downloads and runs eXeLearning at that
commit in `.cache/` (not distributed).

## Docker images and release assets

Published on every release as `ghcr.io/ateeducacion/elpx-optimizer` (target `web`) and
`ghcr.io/ateeducacion/elpx-optimizer-cli` (target `cli`); they redistribute:

- `web`: the web build above on `nginxinc/nginx-unprivileged` (nginx: BSD-2-Clause; Alpine packages
  under their licenses).
- `cli`: the CLI bundle, sharp and qpdf-wasm on `oven/bun` (Bun: MIT, with bundled components under
  their licenses) and Alpine's `ffmpeg` package (GPL build).

The release assets `elpx-optimizer-web.tar.gz` (the web build, with `licenses/`),
`elpx-optimizer-cli-X.Y.Z.tgz` and `elpx-optimizer-skill.zip` (the CLI bundle and `qpdf-runner.mjs`;
sharp and qpdf-wasm are installed from npm by the user) carry the components listed in the
corresponding sections.
