# Web app

The web app is a static HTML/JavaScript/WebAssembly site (`dist/web`). **It re-encodes videos and
audio and recompresses images inside the visitor's browser; the project is never uploaded.** The
server only delivers the app's own static files; there is no API. Visiting it from another
computer still processes the files in that visitor's browser.

## Flow

A stepper at the top shows the four steps: Project, Options, Plan, Result (Proyecto, Opciones,
Plan, Resultado in Spanish; the language follows the browser, Spanish by default).

1. **Project.** Drop an `.elpx` on the page or choose it with the file button (keyboard: Tab to the
   button, Enter). The pipeline worker reads the file locally (ranged `Blob` slices, never the whole
   file at once), analyzes it and, if it has videos or audio that can be re-encoded, loads FFmpeg (a
   separate status line shows the engine loading, about 32 MB the first time) and probes them with
   ffprobe.wasm.
2. **Options.** On the left, the review: title, variant, pages and size; a size breakdown (video,
   images, audio, other); a notice when files sit in eXeLearning 3 folders or when references point
   to files that do not exist; issues with their location; and a sortable inventory with video,
   audio and image properties, usage, a preview button and a checkbox per resource to keep it as
   original. On the right, the options: preset (Conservador/Conservative, Equilibrado/Balanced,
   Máximo/Maximum, which is the `aggressive` preset); maximum image size (by level, 1280, 1600,
   1920, 2560 px or no limit); clean-up switches: remove unused files, merge duplicates, clean file
   names (on by default, with the number of files that would be renamed and one example) and, only
   when the project needs them, "flatten eXeLearning 3 folders" and "remove broken references"; all
   but clean names are off by default; advanced video, audio and image settings; single/multi-thread
   FFmpeg.
3. **Plan.** The exact operations (grouped by type, including moves, clean names, audio conversions
   and removed references), what stays unchanged and why, risks, and an estimate labelled as such.
4. **Result.** While optimizing: real progress from the engines (engine load, extraction, processed
   video or audio time, validation, packaging, verification; indeterminate when a fraction is not
   reliable, never 100 % before the final validation), with Cancel always available. Then: measured
   sizes, applied/discarded/failed operations, download of `name_optimized.elpx` and of the JSON
   report. "Optimize another project" releases the downloads (Object URLs revoked).

## Interface

- Bootstrap 5.3.8 compiled locally from Sass (`src/web/theme.scss`, only the modules in use), with
  the indigo of the Área de Tecnología Educativa (ATE) as primary colour and the Atkinson
  Hyperlegible font. Icons are Bootstrap Icons 1.13.1, bundled as SVG text. Nothing is loaded from a
  CDN and the Content-Security-Policy is the same as before (see [decisions](decisions.md) D13).
- Dark mode follows the system setting (`prefers-color-scheme`, applied through `data-bs-theme`).
- Previews: images and videos open in a dialog (with a button to download that file), audio plays
  and pauses inline from its row. The worker extracts only that entry (a zero-copy slice for stored
  entries) and the page shows it through a `blob:` URL; the project's HTML and JavaScript are still
  never rendered (D15).
- Side panels (native `<dialog>` elements): licenses of the app and of every bundled component, with
  the texts served from `licenses/` on the same site; and how to use the CLI (the ghcr.io Docker
  images first, then a local installation) and the Agent Skill. The header links to `SKILL.md` on
  GitHub.
- The footer carries the ATE logo with "Hecho por el Área de Tecnología Educativa del Gobierno de
  Canarias" ("Made by the Educational Technology Area of the Government of the Canary Islands") and
  a link to the source code on GitHub.

## How processing runs

- The page renders and talks to a module Web Worker (the pipeline). ZIP reading, analysis, image
  codecs and packaging run there; the page stays responsive.
- FFmpeg runs in its own nested worker created by `@ffmpeg/ffmpeg` 0.12.15 with the pinned
  `@ffmpeg/core` 0.12.10. Inputs are mounted with WORKERFS (read from the Blob on demand, not copied
  into the WebAssembly heap); outputs are written to MEMFS, copied out and deleted right away.
  One video or audio file at a time. The core includes LAME and libopus, so WAV, AIFF and FLAC
  recordings become MP3 in the browser too (renamed to `.mp3`, references rewritten, as in the CLI)
  and Opus recordings can be re-encoded.
- Cancelling terminates the FFmpeg worker (the codec really stops); if the pipeline worker does not
  confirm within 3 s it is terminated too and recreated. A new job can start without reloading.
- Images use WebAssembly codecs (jSquash: MozJPEG, OxiPNG, libwebp, resize) in a pool of dedicated
  image workers: one per spare core, at most 4 (1 when the core count is unknown, at most 1 on devices
  reporting ≤ 2 GiB and 2 on ≤ 4 GiB). Workers start on demand and stay loaded for the next job (so
  a second project can be processed even if the server is no longer reachable); a cancelled job
  terminates its worker, and all workers end with the page. On a 10-core Mac eight 12 MP JPEGs take
  3.8 s with the pool instead of 11.4 s in a single worker.
- The output is a Blob made of the unchanged entries (zero-copy slices of the input File), the new
  media and the rewritten text; it is re-read and fully validated before the download is enabled.
- Candidates are checked with ffprobe.wasm (streams, duration, size), fully decoded with ffmpeg.wasm
  and played in a detached `<video>` element when the browser supports the format (compared with the
  original's playability).

## Single-thread and multi-thread

The single-thread core is the baseline: it needs neither `SharedArrayBuffer` nor special headers
and works on any static host. The multi-thread core (`@ffmpeg/core-mt`) is used only when:

- the page is cross-origin isolated (`crossOriginIsolated === true`), which requires the server to
  send `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`;
- `SharedArrayBuffer` exists, the device reports ≥ 4 cores (and ≥ 4 GiB of memory when it reports it);
- the user did not untick "Use multi-thread FFmpeg" (or `?threads=single`).

It then uses `min(4, cores − 1)` encoder threads. `elpx-optimizer serve --isolation` and the Docker
web image with `ELPX_ISOLATION=on` send the headers. Without them, single-thread is used; video
compression is never disabled.

## Browsers

Tested with Playwright 1.63 (`test/e2e`), the full flow including in-browser video re-encoding:

| Browser                         | Single-thread (no isolation)             | Multi-thread (isolated) |
| ------------------------------- | ---------------------------------------- | ----------------------- |
| Chromium 153 (Playwright build) | ✓ all E2E tests                          | ✓                       |
| Firefox (Playwright build)      | ✓ recompression and no-improvement flows | not tested              |
| WebKit 26.6 (Playwright build)  | ✓ recompression and no-improvement flows | not tested              |

Requirements: WebAssembly, module workers, nested workers, `Blob`/`File` APIs, `ImageData` in
workers. Playback checks depend on the browser's codecs (some builds cannot play H.264; the check is
then reported as unsupported and not used to reject the result). Mobile browsers were not tested;
the UI is responsive and usable at 390 px width.

## Limits and memory

Browser defaults (`BROWSER_LIMITS` in `src/core/limits.ts`): archive ≤ 8 GiB, video ≤ 1 GiB,
≤ 3840×2160, ≤ 2 h, image ≤ 64 MiB and 40 megapixels, text entries ≤ 64 MiB. `?maxVideoMiB=N`
lowers the video limit (for small devices). Larger videos are kept as they are and the plan says so.

The ffmpeg.wasm FAQ mentions a 2 GB input limit; with WORKERFS the input is not copied into the
WebAssembly heap, but the encoder state and the **output** live in the 32-bit heap, together with
decoded frames. That is why the default video limit is 1 GiB and resolution is capped at 4K; these
are not promises that any file up to those sizes works on every device. Out-of-memory and abort
errors are caught, reported ("the browser ran out of memory for this video; the original is kept")
and the next job reloads FFmpeg. For larger files use the CLI.

### Measured cases

Headless Chromium 153 (Playwright), Apple Silicon Mac with 10 cores and 16 GB, the built `dist/web`
served by `elpx-optimizer serve`, balanced preset, `scripts/measure-web.mjs` (analysis includes loading
FFmpeg; peak memory is the resident size of that browser's processes only). Synthetic videos are
`testsrc2` patterns encoded almost losslessly by native FFmpeg, so they compress far better than real
footage; the two real projects are private eXeLearning courses that are not part of the repository.

| Input                                                    | Core              | Analysis | Optimization | Result                 | Peak browser memory |
| -------------------------------------------------------- | ----------------- | -------- | ------------ | ---------------------- | ------------------- |
| 720p, 40 s H.264 lossless (82 MB package)                | single            | 1.8 s    | 34.9 s       | video 78.5 → 13.4 MiB  | 0.8 GiB             |
| same                                                     | multi (COOP/COEP) | 1.8 s    | 19.9 s       | same                   | 1.1 GiB             |
| 1080p, 60 s H.264 CRF 10 (218 MB package)                | single            | 3.9 s    | 96.6 s       | video 207.6 → 37.9 MiB | 0.9 GiB             |
| same                                                     | multi             | 3.8 s    | 65.1 s       | same                   | 1.2 GiB             |
| 2160p (4K), 10 s H.264 CRF 14 (117 MB), scaled to 1080p  | single            | 2.3 s    | 28.9 s       | video 111.4 → 2.6 MiB  | 0.9 GiB             |
| same                                                     | multi             | 2.9 s    | 13.4 s       | same                   | 1.4 GiB             |
| Real course, 128 MB (389 resources, large photos, audio) | single            | 3.3 s    | 40.0 s       | package −26 %          | 2.3 GiB             |
| same                                                     | multi             | 3.9 s    | 42.0 s       | same                   | 2.4 GiB             |
| Real course, 211 MB (174 MB of WAV audio, not optimized) | single            | 4.8 s    | 47.5 s       | package −9 %           | 1.2 GiB             |
| same                                                     | multi             | 4.9 s    | 60.5 s       | same                   | 1.3 GiB             |

This table predates audio processing: the two real courses were measured while audio files were
kept as they were (the 211 MB course's WAV files and the 128 MB course's Opus recordings). With
audio support, the CLI with default options on the same machine takes the 211 MB course from
210.7 MiB to 65.5 MiB (−68.9 %) in 59 s and the 128 MB course from 128.2 MiB to 91.1 MiB (−28.9 %)
in 106 s (see [decisions](decisions.md) D12).

Before audio support, the CLI processed the same real courses in about 7 s (211 MB) and 19 s
(128 MB) with native FFmpeg and libvips on the same machine. Peak memory
grows with photo size times the number of image workers (up to 4) and with the video's output size;
devices with less memory should use fewer workers (automatic when the browser reports its memory),
`?threads=single` and, if needed, `?maxVideoMiB=N`, or the CLI. Videos near the 1 GiB limit were not
measured; they may fail on devices with little memory, in which case the original is kept.

## Deployment

`dist/web` is self-contained: every JavaScript file, worker, WebAssembly binary and font is emitted
into `dist/web/assets` with content hashes and loaded with relative URLs, so it works at the site
root or in any subdirectory (tested under `/tools/elpx/`). No CDN is used at run time.

Ways to deploy it:

- **Docker image** published on every release (`linux/amd64` and `linux/arm64`, tags `latest`,
  `X.Y.Z`, `X.Y`): nginx as an unprivileged user, static files only.

  ```bash
  docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer                       # http://localhost:8080
  docker run --rm -p 8080:8080 -e ELPX_ISOLATION=on ghcr.io/ateeducacion/elpx-optimizer  # + COOP/COEP (multi-thread)
  ```

- **GitHub Pages**: the release workflow (`.github/workflows/release.yml`) builds the site and
  deploys it to the repository's Pages site on every published release. Pages cannot send the
  COOP/COEP headers, so the page is not cross-origin isolated there and always uses the
  single-thread FFmpeg core (video is still compressed, more slowly).
- **Any static host** with the `elpx-optimizer-web.tar.gz` asset of a release (the contents of
  `dist/web`), or from a checkout:

  ```bash
  bun install --frozen-lockfile
  bun run build:web                                 # → dist/web (~64 MB, two 32 MB FFmpeg cores)
  elpx-optimizer serve --root dist/web --port 8080  # or nginx/Apache/any static host
  docker build --target web -t elpx-optimizer-web . && docker run -p 8080:8080 elpx-optimizer-web
  ```

Server requirements: serve `.wasm` as `application/wasm` and `.js`/`.mjs` as JavaScript; allow only
GET/HEAD; optional COOP/COEP for multi-thread. The app is not guaranteed to work from `file://`
(module workers and WASM loading need HTTP/HTTPS); it has not been tested that way.

### Social previews

`index.html` carries a description, Open Graph and Twitter card metadata (Spanish, with an English
alternate locale), a favicon (`favicon.svg`, `apple-touch-icon.png`) and a 1200×630 social card,
`src/web/public/social-card.png`. The card is generated by `scripts/make-social-card.ts` (after
`bun run build:web`), which optimizes `test/fixtures/elpx/legacy-folders.elpx` in headless Chromium
and captures the real result step. Social networks need absolute image URLs: set `ELPX_SITE_URL` to
the public address when building (`ELPX_SITE_URL=https://example.org/elpx/ bun run build:web`) and
`og:image`, `twitter:image` and `og:url` point there; without it the image URLs are relative to the
page. The release workflow sets it to the Pages address.

## Privacy

- No API, no analytics, no third-party requests. `index.html` carries a Content-Security-Policy that
  limits scripts, workers, WASM compilation and connections to the same origin and forbids forms.
- The E2E suite records every request made by the page and its workers and fails if anything other
  than a GET of a file that exists in `dist/web` is requested (local `blob:` URLs excepted), including
  any request body.
- After the components are loaded once, a second optimization works with the network blocked (tested).
  This is not an offline/PWA mode: reloading the page needs the server.
- Nothing is stored persistently (no IndexedDB, OPFS or localStorage); temporary Blobs are released
  when a job finishes or is cancelled and Object URLs are revoked.
- The project's HTML and JavaScript are never rendered or executed; names and messages from the
  project are inserted as text only. Previews show only images, audio and video, through `blob:`
  URLs of the extracted entry (images in `<img>`, where SVG scripts do not run).
