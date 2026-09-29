# Design decisions

Each decision records the options considered and the evidence. Upstream facts come from
[upstream-review.md](upstream-review.md) (eXeLearning `406a2158623da1862e9f50fdfd5e358b818c9aa8`,
`v4.0.5-16`).

## D1. Minimal changes to the existing package instead of an eXeLearning round trip

Options: (a) import with upstream's importer into Yjs and re-export; (b) edit the package in place.

Chosen: (b). A re-export is a re-render with the current runtime: it replaces themes, libraries and
iDevice runtimes, rewrites every asset path, drops unread metadata keys and has known bugs (the
backslash swallowed in JSON at `BaseExporter.ts:1039`, the accumulating `screenshot.png` in CLI
round trips). In-place editing keeps every unchanged entry byte-for-byte (compressed bytes copied)
and changes only media bytes and, for deduplication, moves, renames and removed broken references,
the exact bytes of the references involved (and entry names).
Upstream's importer and exporters are used instead as an **independent check** (`make compat`,
`test/compat`, 17 cases including flatten, reference-removal and audio runs, all compatible at the
time of writing): the optimized package must import with the same pages, blocks, components, IDs,
texts and properties (asset references normalized to the original content they point to), with no
new missing assets, and must re-export to ELPX and HTML5.

## D2. Formats and extensions are preserved

Changing a file's format would require rewriting its references in `content.xml` (HTML and JSON,
including escaped layers), every page, `search_index.js`, the manifest, DataGame link anchors and
the interactive-video JSON (whose MIME type is derived from the extension). Keeping the format makes
recompression reference-neutral, so images and videos keep their format and extension (clean file
names, D16, only lower-case the extension).

The one exception is uncompressed or lossless audio (D12): once the restructuring planner could
move files with verified rewrites (D9), the same machinery made a WAV → MP3 rename safe, and
leaving those recordings alone left most of the size of audio-heavy projects untouched.

## D3. Pixo (eXeLearning's image optimizer) evaluated, jSquash chosen for the browser

eXeLearning vendors Pixo (`public/libs/pixo`, MIT, crate version not recorded) in
`ImageOptimizerWorker.js`. Facts: it has encoders only (no decoder: upstream decodes with
`createImageBitmap` + `OffscreenCanvas`, which applies colour conversion and drops EXIF/ICC); its
default policy converts any PNG without transparency to JPEG and renames `.png` to `.jpg`, which is
incompatible with D2.

Measured with `bun scripts/bench-image-encoders.ts` on the same decoded pixels:

| Input                       | Encoder                   | Bytes | Quality                                           |
| --------------------------- | ------------------------- | ----- | ------------------------------------------------- |
| photo-exif-icc.jpg JPEG q82 | Pixo (eXeLearning)        | 12352 | 36.08 dB                                          |
| photo-exif-icc.jpg JPEG q82 | MozJPEG via jSquash (web) | 6986  | 35.64 dB                                          |
| photo-exif-icc.jpg JPEG q82 | sharp mozjpeg (CLI)       | 6366  | 35.62 dB                                          |
| alpha-text.png (120483 B)   | Pixo lossless             | 32988 | RGB of 100/30000 fully transparent pixels changed |
| alpha-text.png (120483 B)   | OxiPNG via jSquash (web)  | 31123 | pixel-identical                                   |
| alpha-text.png (120483 B)   | sharp libpng (CLI)        | 46712 | pixel-identical                                   |

At the same nominal quality Pixo's JPEG is ~1.8× larger than MozJPEG (quality scales are not
identical, PSNR differs by ~0.4 dB); its PNG "lossless" mode is visually lossless but not bit-exact.
The browser engine uses the jSquash builds of MozJPEG, OxiPNG, libwebp and a Rust resizer
(Apache-2.0 wrappers; codecs under their own licenses) behind the same `MediaEngine` contract, with
our own metadata re-injection. Pixo could be plugged in as an alternative encoder later.

## D4. ffmpeg.wasm 0.12.15 + core 0.12.10, single-thread by default

Latest published versions (`@ffmpeg/ffmpeg` 0.12.15 of 2025-01-07, `@ffmpeg/core` and
`@ffmpeg/core-mt` 0.12.10). The single-thread core needs neither SharedArrayBuffer nor COOP/COEP,
so any static host works; the multi-thread core is loaded only when the page is cross-origin
isolated, SharedArrayBuffer exists, the device has ≥ 4 cores (and ≥ 4 GiB when reported) and the
user did not disable it. The `FFmpeg` class is given explicit same-origin `coreURL`, `wasmURL`,
`workerURL` and `classWorkerURL`: its worker otherwise falls back to an unpkg.com CDN URL. Its
`ffprobe()` returns a non-zero code even on success, so the JSON output is authoritative.

## D5. Own ZIP reader and writer (with fflate for DEFLATE)

Generic libraries (fflate's `unzip`, JSZip) read whole archives into memory or do not expose the
checks we need (local vs central header cross-checks, overlap detection, per-chunk inflate
accounting, ZIP64 cross-validation, raw copy of compressed bytes). fflate is used for streaming
DEFLATE/INFLATE only. The reader and writer are tested against Python's `zipfile` (including
forced ZIP64 and archives with more than 65535 entries) and hostile crafted archives.

## D6. Strict, entity-free XML parser with offsets

`content.xml` must be parsed without resolving entities or DTDs (XXE and billion-laughs protection)
and edited in place, which requires raw offsets of text, CDATA and attributes. Well-formedness is
checked strictly; any DOCTYPE internal subset is rejected (upstream never writes one); external
DTDs (`content.dtd`) are never loaded.

## D7. Minimal escaping when rewriting references

eXeLearning resolves `{{context_path}}` references by literal text matching on `htmlView` and JSON
strings. A rewrite to `foto&amp;x.jpg` is correct HTML but does not resolve in eXeLearning; the
independent compatibility check found this. Rewritten references keep `&` raw unless it would be
read as a character reference, and references in `content.xml` to names that cannot be written so
that both eXeLearning and browsers agree are not rewritten (the duplicate is kept).

## D8. Upstream code reuse

No upstream source is copied into the product. Reused knowledge: reference regexes and resolution
order, the DataGame `escape()`+XOR 146 codec (reimplemented from `common.js`), the manifest format,
the ZIP compression policy (deflate text, store media) and import limits. Upstream fixtures are
copied with provenance in `test/fixtures/upstream/PROVENANCE.md`; the upstream importer/exporters
run only in the compatibility check, from a pinned checkout fetched by `scripts/fetch-upstream.sh`.

## D9. Flattening only eXeLearning 3 ODE-ID folders, with verified per-reference rewrites

eXeLearning 3.0 stored each upload in `content/resources/<ODE-ID>/`, one folder per iDevice, named
with a 14-digit timestamp and 6 upper-case letters or digits (upstream-review §2). eXeLearning 4
imports those folders as if the user had made them (§8.1, §16 D7), so they survive every re-export.
Two tools already flatten packages:

- `scripts/flatten-elpx.ts` in eXeLearning flattens only ODE-ID folders, but by global string
  replacement in `content.xml`, `index.html` and `html/*.html`. It leaves `search_index.js` and
  `libs/elpx-manifest.js` pointing to the old paths (upstream-review §5, §6.5, §16 D10), writes the
  short placeholder `{{context_path}}/<file>`, re-deflates every entry and, by default, overwrites
  its input.
- [elpx-flattener](https://github.com/erseco/elpx-flattener) (a single web page) flattens **every**
  subfolder of `content/resources/`, including folders the user created, with the same kind of
  string replacement in the same three kinds of files.

Chosen: only folders whose name has exactly the ODE-ID pattern (`core/format/legacy-folders.ts`),
because a user folder is information (eXeLearning 4's file manager stores it as `folderPath` and
re-applies it on export). Each reference is rewritten through its own encoding layers, in every
representation (`content.xml`, pages, `search_index.js`, plain-JSON DataGame data, interactive-video
JSON), the manifest is regenerated, and the result is accepted only if every reference of the
package resolves again exactly as intended (architecture: "Restructuring"). A file that is referenced
dynamically, leniently or ambiguously, or that holds references itself, stays. Collisions follow
file-system rules (case and Unicode normalization) with `name_2.ext`, and identical copies merge.

Evidence from the compatibility check: eXeLearning's own CLI importer at the pinned SHA does not
resolve the eXeLearning 3 short placeholders `{{context_path}}/<ODE-ID>/<file>` (it maps only the
full ZIP path and the bare file name, §8.1), so they stay as unconverted placeholders. On the
upstream v3 fixture (`Un contenido de ejemplo para probar estilos y catalogación.elpx`) 7 such
placeholders remain after importing the original and 0 after importing the flattened package, with
the same pages, blocks and components.

## D10. Rewritten `{{context_path}}` references use the long form

When a file moves or is renamed, a `{{context_path}}` reference in `content.xml` or
`search_index.js` is written as `{{context_path}}/content/resources/<path>`, whatever form it had.
It is the only form eXeLearning 4's exporter writes (upstream-review §8.1, §16 D1), and both the
browser and the CLI importers resolve it by exact lookup. The short form with a folder is not
resolved by the CLI importer, and the short form without one only through a file-name alias. Legacy
`resources/…` references keep that form, and page-relative URLs in the exported HTML stay relative.

## D11. Taking out references to missing files is an explicit opt-in

The default stays "a missing resource is reported, not repaired by deleting its references": a
missing file is often an authoring error the author can fix by adding the file, and silently
deleting the reference would hide it. `--missing-references remove` (`missingReferences: "remove"`,
a switch shown in the web app only when the project has such references) exists for authors who
prefer a clean package over a broken image or player.

The removal is conservative: a whole element goes only when it is a void element (`<img>`,
`<source>`, `<track>`, `<embed>`, `<input>`, `<link>`, `<param>`) or an empty `<video>`, `<audio>`,
`<iframe>`, `<object>` or `<script>`, and only when every reference it holds is being removed;
otherwise just the attribute goes, so link text, captions and other sources remain. `srcset` loses
only its broken candidates, and a JSON value becomes an empty string rather than a missing key, so
iDevice data keeps its shape. References in stylesheets and in running text are left with a reason:
removing them would mean editing CSS or prose, which cannot be done without guessing. The
compatibility check imports the result with eXeLearning's importer and requires identical pages,
blocks and components (ids, types, order) and no new missing or unresolved asset.

## D12. WAV, AIFF and FLAC become MP3, with references and `type` attributes rewritten

Options: (a) leave audio alone (skip every recording whose format would change); (b) convert to a
compressed format and rename the file. (a) leaves most of the size of audio-heavy courses
untouched: in a real 210.7 MiB course, 174 MiB were audio, 162 MiB of it in 106 WAV files, and
runs without audio support reduced the package by about 9 % ([web.md](web.md#measured-cases)). Chosen (b) with MP3, which every browser and
eXeLearning's audio players accept and which both engines can encode (native ffmpeg with
libmp3lame; LAME inside `@ffmpeg/core` for the web).

The rename is handled by the restructuring planner like a move: every reference is rewritten and
verified, and a reference that cannot follow (dynamic, lenient, ambiguous, not rewritable) keeps the
original file unchanged. An element's `type` attribute is rewritten too (`audio/wav` becomes
`audio/mpeg`), because browsers use the declared type to choose a source and a stale one would be
wrong metadata for the new file; a `type` that cannot be edited blocks the conversion rather than
leaving it wrong. MP3, M4A and Opus are re-encoded in place only when their bitrate is at least 1.4 × the
target, to avoid generation loss for little gain. In that same course the CLI, with every option at
its default (balanced, no clean-up), went from 210.7 MiB to 65.5 MiB (−68.9 %) in 59 s on a
10-core Mac (122 audio files: 106 WAV converted to MP3, 16 MP3 re-encoded); converting the audio
alone gave 69.6 MiB.

Opus is handled the same way as MP3 and M4A, in place and in its own container: eXeLearning's audio
recorder writes mono Opus in WebM at about 130 kb/s or more, four times the 32 kb/s balanced mono
target. Opus is re-encoded at half
the MP3 target (at least 48 kb/s stereo) or a quarter for mono (at least 32 kb/s), since it needs
about half the bitrate of MP3 for the same quality; Vorbis is left alone. Many browser recordings
carry no duration in their header, which would normally skip them (`unknown-duration`); for Opus they
are still re-encoded, with FFmpeg's `-xerror` so any read error fails the job, a full decode, and a
required known duration in the result. In a real 128.2 MiB course with 255 such recordings (185
without a duration; the others at 129–136 kb/s), the CLI with default options produced 91.1 MiB
(−28.9 %, together with 111 recompressed images) in 106 s.

Both courses' outputs were checked by hand with the `test/compat` harness: eXeLearning's own import,
ELPX and HTML5 re-export and re-import, with no differences.

## D13. Bootstrap 5.3 compiled locally from Sass, only the parts in use

Options: (a) Bootstrap from a CDN; (b) the prebuilt `bootstrap.min.css`; (c) compile the Sass
sources at build time. (a) breaks the Content-Security-Policy (`style-src 'self'`) and the rule that
the app makes no third-party requests. (b) ships every component. Chosen (c): `src/web/theme.scss`
sets the theme variables (the indigo of the ATE logo as `$primary`, Atkinson Hyperlegible,
`$min-contrast-ratio: 4.5`, dark-mode backgrounds) and imports only the modules the interface uses;
`sass` is a build-time dependency and is not redistributed. Dark mode follows the system through
Bootstrap's `data-bs-theme`. Bootstrap Icons are imported as SVG text (`?raw`) and turned into
elements with `DOMParser`; only the app's own icon files are parsed that way, never project data.
Bootstrap's JavaScript is not used (D14). The CSP did not change.

## D14. Native `<dialog>` instead of Bootstrap's JavaScript

The licenses panel, the CLI and skill help panel and the preview window are `<dialog>` elements
opened with `showModal()`. The browser provides the top layer, focus containment, Escape to close
and an inert page behind; a click on the backdrop closes them, as Bootstrap's offcanvas and modal
do. This avoids shipping and initializing Bootstrap's JavaScript components for three dialogs.

## D15. Previews of media only, extracted on demand

Options: (a) no previews; (b) render the project's pages; (c) show individual images, audio and
video. (b) would render and run project HTML and JavaScript, which the app never does. Chosen (c):
the page asks the pipeline worker for one entry; the worker returns a Blob typed with the entry's
MIME type (a zero-copy slice of the input File when the entry is stored, as media usually are;
inflated up to 256 MiB otherwise). The page shows it through a `blob:` URL in an `<img>`,
`<video>` or audio element (images and video in a dialog, audio played and paused from its row in
the table) and revokes the URL afterwards. Other kinds of entries are refused by the worker. SVG images are shown
through `<img>`, where their scripts do not run. Nothing leaves the browser.

## D16. Clean file names, off in the CLI and on in the web app

Projects collect file names such as `Copia de Foto Clase (2).JPG`: spaces, accents, upper-case
extensions and the markers operating systems add to copies. Names with spaces are fragile in
eXeLearning itself (its exporter's `asset://` rewrite stops at whitespace, upstream-review §8.1).
`--normalize-names slug` (`normalizeNames: "slug"`) renames user files the way WordPress's
`sanitize_title` does: lower case, accents removed, only `a`–`z`, `0`–`9` and hyphens, copy markers
("Copia de", "Copy of", "- copia", "copy 2", "(2)", "[3]") removed, extension in lower case, so that
name becomes `foto-clase.jpg`. A taken name gets `-2`, `-3`… (WordPress's convention, rather than
the `_2` used when flattening, which follows upstream's `flatten-elpx.ts`).

Only the file name changes: folders are information the author chose (D9), and `custom/` files are
protected. The rename goes through the same planner and verification as moves, so a file with a
dynamic, lenient or ambiguous reference, or one that holds references itself, keeps its name.

The core and the CLI keep names unless asked, because renaming is a visible change to someone who
scripts around the files. The web app turns it on by default, with a switch that says how many files
would be renamed and shows one example, because its users are authors tidying a project for
publication. On the 210.7 MiB course of D12, clean names renamed 202 files and the package went to
64.7 MiB (−69.3 %) with every validation passing (10/10), and eXeLearning's own import, re-export and
re-import (the `test/compat` harness, run by hand) found no differences.

## D17. Default image size limits and the "Maximum" preset name

Downscaling used to happen only in the aggressive preset (1920 px). The defaults are now 2560 px
(conservative), 1920 px (balanced) and 1600 px (aggressive) on the long side: eXeLearning's content
column is far narrower than that, even on high-density screens, so larger images add bytes without
visible detail. Images used by resolution-sensitive iDevices are still never resized, and
`--image-max-dimension none` (a "no limit" choice in the web app) keeps every size.

The web app shows the aggressive preset as "Máximo" / "Maximum", which describes what users choose it
for. The id stays `aggressive` in options, plans and reports so saved configurations and scripts keep
working; the CLI accepts `--preset maximum` as an alias.
