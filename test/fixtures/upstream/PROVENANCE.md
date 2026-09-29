# Upstream fixture provenance

These files are byte-identical copies of test fixtures from the eXeLearning
repository. They are used here as real-world inputs for format detection,
reference scanning and round-trip tests.

- Source repository: https://github.com/exelearning/exelearning
- Commit: `406a2158623da1862e9f50fdfd5e358b818c9aa8` (branch `main`,
  committed 2026-09-28T16:23:45+02:00, `git describe`: `v4.0.5-16-g406a2158`)
- License: GNU Affero General Public License v3.0 (AGPL-3.0), per the
  upstream `LICENSE` file at the repository root of that commit. No
  per-file license headers or separate fixture licenses were found; the
  fixtures are distributed under the repository license.
- Copied on: 2026-09-29. Verified with `shasum -a 256` against the upstream
  working tree after copying.

## Variant terms used below

- **v4**: current eXeLearning 4 `.elpx`. `content.xml` starts with
  `<!DOCTYPE ode SYSTEM "content.dtd">` and
  `<ode xmlns="http://www.intef.es/xsd/ode" version="2.0">`, pretty-printed,
  `htmlView`/`jsonProperties` wrapped in CDATA, `content.dtd` in the archive,
  `odeResources` has `exe_version`. Assets live flat in `content/resources/<file>`.
- **v3.0-era**: `content.xml` written by eXeLearning 3.0.x (PHP/Symfony web
  version). Single-line XML, bare `<ode>` root (no DOCTYPE, no namespace, no
  `version`), `htmlView`/`jsonProperties` entity-escaped (no CDATA), no
  `content.dtd`, `odeResources` has `odeVersionName` and `isDownload`.
  Assets live in `content/resources/<14-digit-timestamp + 6 letters>/<file>`
  and are referenced as `{{context_path}}/<folder>/<file>`. The same element
  vocabulary as v4 (`odeNavStructures` / `odePagStructures` / `odeComponents`).
- **legacy**: eXeLearning 2.x `.elp`. `contentv3.xml` with root
  `<instance xmlns="http://www.exelearning.org/content/v0.3" ... version="0.3">`,
  plus binary `content.data` (starts with bytes `03 80 09 82` followed by
  `reference`) and `content.xsd`; resources stored flat at the archive root.

## Files

| File | Upstream path | Size (bytes) | SHA-256 | Variant | Notes |
|---|---|---:|---|---|---|
| `un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx` | `test/fixtures/un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion.elpx` | 2179585 | `24ed8bc513d9218ef3ec248500dbc09a3783ac20f10b0eb2c832c3cea8f1e49a` | v4 | Full export: `index.html`, `html/`, `content/`, `theme/`, `libs/`, `idevices/`, `search_index.js`, `screenshot.png`, `content.dtd`, `libs/elpx-manifest.js`. 14 pages, 13 components. iDevices: `text`, `udl-content`, `form`, `rubric`, `scrambled-list`, `interactive-video` (YouTube source, JSON in `#exe-interactive-video-contents`), `download-source-file`. Real media (7 files: jpg, mp3) referenced as `{{context_path}}/00.jpg`. The manifest lists stale `content/resources/<timestamp>/...` paths that are not in the archive. |
| `download-elpx-link.elpx` | `test/fixtures/download-elpx-link.elpx` | 523705 | `bfe6c56ebb589d30c2eefac260e2d43ad01e1fe737fab07ba003dc0b9aee5b44` | v4 | Single `text` iDevice containing `<a href="exe-package:elp" download="exe-package:elp-name">`. Includes `libs/elpx-manifest.js` and `libs/exe_elpx_download/exe_elpx_download.js` even though no `download-source-file` iDevice is present. `screenshot.png` present. |
| `pdf-noext-iframe.elpx` | `test/fixtures/pdf-noext-iframe.elpx` | 1126652 | `7e6bc05a1eccc7166490515f2702cac3e4bfc8effb567fa87c4548d05f33f298` | v4 | Long-form reference `{{context_path}}/content/resources/asset-aaaaaaaa-1111-2222-3333-444444444444` (no file extension; the file is a PDF) inside an `<iframe>`. Built by upstream `test/fixtures/scripts/build-pdf-noext-fixture.mjs`. |
| `missing-asset-refs.elpx` | `test/fixtures/missing-asset-refs.elpx` | 5671 | `166764f9bc6e61ae042d294f9d7b66984c8bbbed2ca2bf8f27371ee81a89ad9e` | v4 (minimal) | Only `content.xml` + `content.dtd` (no `index.html`, no `screenshot.png`). One `classify` iDevice with an obfuscated `clasifica-DataGame` div and `<a href="{{context_path}}/rabbit.svg" class="js-hidden clasifica-LinkImages">` links to files that are not in the archive. |
| `stale-text-template-refs.elpx` | `test/fixtures/stale-text-template-refs.elpx` | 1972 | `cc31f49276fa80b12d1adb8a7c75f33c51c653c7e886195ec573c0370207cf9d` | v4 (minimal) | Only `content.xml` + `content.dtd`. `select-media-files` and `map` iDevices referencing missing `{{context_path}}/20250605150704KZYGBR/imagen1.jpg` and `.../do.mp3`. |
| `damaged-trueorfalse-json.elpx` | `test/fixtures/damaged-trueorfalse-json.elpx` | 2318 | `365cb037f102f1525cc3cf81f273f00ed2abbff2b93904771dedaad4087a53d2` | v4 (minimal) | Only `content.xml` + `content.dtd`. Two `trueorfalse` iDevices with damaged `jsonProperties`, plus one `text`. |
| `Un contenido de ejemplo para probar estilos y catalogación.elpx` | `test/fixtures/export/un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion/un-contenido-de-ejemplo-para-probar-estilos-y-catalogacion_web/Un contenido de ejemplo para probar estilos y catalogación.elpx` | 1317700 | `541930b4abc4526a8dee3dd6a2268a202e101869c1a13194fa9d09549b217518` | v3.0-era | Source package embedded in a 3.0 web export (the download-source-file target). Contains only `content.xml`, `content/` (css, icons, resources) and `custom/`: no `index.html`, no `screenshot.png`, no `content.dtd`. `isDownload=false`. Same content as the v4 fixture above: `interactive-video`, `download-source-file`, media in `content/resources/2025100909060*/`. Non-ASCII file name with spaces. |
| `encoding_test.elp` | `test/fixtures/encoding_test.elp` | 547993 | `9c50e2243e711d4be830733665c1a42f28c38c0876416752aaef8285009bb48f` | v3.0-era (`.elp` extension) | A 3.0 web export with `content.xml`, despite the `.elp` extension: `index.html`, `html/descarga.html`, `custom/`, `idevices/`, `libs/`, `theme/`. `text` + `download-source-file`. Non-ASCII text (`é í ó ú ü Á ... ñ ¡ ¿ & > <`). No `contentv3.xml`, so this is not a legacy package. |
| `download-elpx-link.zip` | `test/fixtures/download-elpx-link.zip` | 658821 | `19a0f623e2571ae3ed1faf1c4e5fa4071dd0ea5632bfb7b1ba5fffc9d8eb1512` | v4 HTML5 web export (`.zip`) | Website export with embedded `content.xml` + `content.dtd` (`exe_version` = `4.0`), `custom/`, `index.html`; no `screenshot.png`, no `libs/elpx-manifest.js`. Useful for "zip that looks like an .elpx" detection. |
| `verdaderofalso.elp` | `test/fixtures/more/verdaderofalso.elp` | 8257 | `b817089a44f3c685d83151de88cd5e7bd9fadcdc71589d4d0dea08196c9207d7` | legacy | `contentv3.xml`, `content.data`, `content.xsd` only. `TrueFalseIdevice`. |
| `old_tema-10-ejemplo.elp` | `test/fixtures/old_tema-10-ejemplo.elp` | 10437 | `b47f0b003fca2956a22e0a5ad5d86e678a25ca1cef0a3938e24cb6492025a01d` | legacy | `contentv3.xml`, `content.data`, `content.xsd` only. `JsIdevice`. |
| `old_epvelp_udl.elp` | `test/fixtures/old_epvelp_udl.elp` | 1123803 | `883d40ad6db2b9d3dc93daaf32a7476da6863976a7fdbc68d2b6c3c52c20ee50` | legacy | `contentv3.xml` + `content.data`, but also `index.html`, other `*.html` pages, CSS/JS/fonts and images at the archive root. Detection edge case: has `index.html` but is still legacy. |

Total: 12 files, 7,506,914 bytes.

## Not copied (too large, available upstream at the same commit)

`test/fixtures/Manual de eXeLearning 3.0.elpx` (v4, 29 MB, 40 iDevice types,
27 DataGame classes), `test/fixtures/todos-los-idevices_dos_informes.elpx`
(v4, 23.7 MB), `test/fixtures/todos-los-idevices.elp` (v3.0-era, 31 MB) and the
`test/fixtures/more/*.elp` legacy projects (5 to 14 MB) cover the full iDevice
catalogue, including plain-JSON DataGame divs (`dragdrop-DataGame`,
`periodic-table-DataGame`) with real assets.
