# Presets, options and quality

There are three presets. Their ids are `conservative`, `balanced` (the default) and `aggressive`;
the web app shows the last one as "Máximo" / "Maximum", and the CLI also accepts
`--preset maximum` as an alias (plans and reports always say `aggressive`).

Every lossy operation is marked `lossy` in the plan and the report. When a result is invalid, not
smaller by at least the configured minimum (5 % and 1 KiB for images and audio, 5 % and 10 KiB for
videos by default) or fails any check, the original file is kept.

## Video

|                                                              | conservative                           | balanced          | aggressive (Maximum) |
| ------------------------------------------------------------ | -------------------------------------- | ----------------- | -------------------- |
| Codec                                                        | H.264 (libx264), yuv420p, High profile | same              | same                 |
| Quality                                                      | CRF 20                                 | CRF 23            | CRF 28               |
| Max resolution (short side, no upscaling)                    | 1080                                   | 1080              | 720                  |
| x264 preset native / browser                                 | slow / faster                          | medium / veryfast | medium / veryfast    |
| Audio that must be converted                                 | AAC 192 kb/s                           | AAC 128 kb/s      | AAC 96 kb/s          |
| Left alone when already efficient (H.264/HEVC/VP9/AV1 below) | 0.05 bits/pixel/frame                  | 0.08              | 0.12                 |

Always preserved: container and extension (MP4/M4V/MOV stay MP4-family, WebM stays WebM with VP9 +
Opus natively), frame rate and timeline (no trimming or speed change; duration checked within
max(0.25 s, 3 frames)), display aspect (anamorphic sources become square pixels with the same
aspect), orientation (a rotation flag is applied to the pixels), all audio streams with their
languages (AAC/MP3 copied, others converted to AAC as stated in the plan), `mov_text`/WebVTT
subtitles, chapters and container metadata.

Kept unchanged (with the reason in the plan): alpha channels, HDR or more than 8 bits per sample,
interlaced video, rotations that are not multiples of 90°, cover art, several video streams,
subtitle formats the container cannot carry, timecode/telemetry data streams (unless
`--video-drop-data-streams`), unknown duration, files above the size/resolution/duration limits,
containers other than MP4/M4V/MOV/WebM (no format change is made for video). Audio-only files are
handled by the audio policy below.

## Images

|                                   | conservative                                                   | balanced | aggressive (Maximum) |
| --------------------------------- | -------------------------------------------------------------- | -------- | -------------------- |
| JPEG                              | q90 (lossy)                                                    | q82      | q72                  |
| Lossy WebP                        | q90, only when resized or forced                               | q82      | q75                  |
| PNG, lossless WebP                | recompressed without changing pixels (verified pixel by pixel) | same     | same                 |
| Downscale larger than (long side) | 2560 px                                                        | 1920 px  | 1600 px              |

- Format and extension never change (only the case of the extension, with clean file names).
- The size limits reflect where images are shown: eXeLearning's content column is far narrower
  than 1920 px, even on high-density screens. `--image-max-dimension N` (options
  `images.maxDimension`) sets another limit and `none` (JSON `null`) disables it; the web app
  offers "by level", 1280, 1600, 1920, 2560 px and "no limit". A PNG or lossless WebP larger than
  the limit is resized and then compressed losslessly; the resize is the only change and is listed
  in the plan's conversions.
- A JPEG whose estimated quality (from its quantization tables) is not above the target is skipped
  as already efficient, which avoids generation loss.
- Skipped: animated PNG/WebP/GIF, JPEGs with extra images (MPF), CMYK/YCCK JPEGs, 16-bit images,
  SVG (never rasterized), other formats, files whose content does not match the extension, corrupt
  files, and `screenshot.png` unless `--include-screenshot` (then lossless only, it must stay a PNG).
- Images used by resolution-sensitive iDevices (magnifier, hidden image, puzzle, map, before/after,
  identify, image gallery) are never resized.
- Metadata: ICC colour profiles are always kept (no colour conversion is done). EXIF (including the
  orientation, pixels are not rotated), XMP, IPTC and PNG text chunks are kept unless
  `--strip-metadata`; even then EXIF is kept when it carries a rotation.

## Audio

|                                     | conservative | balanced | aggressive (Maximum) |
| ----------------------------------- | ------------ | -------- | -------------------- |
| MP3 / AAC, stereo                   | 192 kb/s     | 128 kb/s | 96 kb/s              |
| MP3 / AAC, mono (half, at least 64) | 96 kb/s      | 64 kb/s  | 64 kb/s              |
| Opus, stereo (half, at least 48)    | 96 kb/s      | 64 kb/s  | 48 kb/s              |
| Opus, mono (a quarter, at least 32) | 48 kb/s      | 32 kb/s  | 32 kb/s              |

`--audio-bitrate N` (64–320, options key `audio.bitrate`) replaces the stereo MP3/AAC target; the
other targets are derived from it as in the table (Opus needs about half the bitrate of MP3 or AAC
for the same quality).

- **WAV, AIFF and FLAC become MP3** (LAME, `libmp3lame`) at the target bitrate. The file keeps its
  folder and base name and gets the `.mp3` extension (`name_2.mp3`… when that name is taken). Its
  references are rewritten wherever they are (`content.xml`, pages, `search_index.js`, plain-JSON
  DataGame data), the `type` attribute of the element that holds a reference is updated when it
  declares another format (`<source type="audio/wav">` becomes `audio/mpeg`), and the manifest is
  regenerated. Like a move, the rename is verified by resolving every reference again (see
  [architecture](architecture.md#restructuring-flatten-conversions-clean-names-broken-references)).
- A recording is **not converted** when any of its references cannot follow the new name: a
  dynamic reference (in a script or an XOR-obfuscated DataGame), a lenient or ambiguous one, one
  that cannot be rewritten in its encoding, a `type` attribute that cannot be updated, or a file
  that is excluded, protected or uncertain. The plan lists it under `skipped` with the reason.
- **MP3, M4A (AAC) and Opus** (in WebM, as eXeLearning's audio recorder writes mono recordings, or
  in Ogg/`.opus`) keep their codec, container and name. They are re-encoded only when their bitrate
  is at least 1.4 × the target (`already-efficient` otherwise), or always with `--audio-force`. A
  WebM file with no video stream counts as audio.
- Browser recordings (MediaRecorder WebM/Opus) often have no duration in their header. They are
  still re-encoded: FFmpeg stops at the first read error (`-xerror`), and the new file must have a
  duration and decode completely. The plan gives no size estimate for them.
- Other formats and codecs (Vorbis, or anything else inside Ogg or WebM) are left unchanged.
- Channels: mono stays mono; more than two channels are mixed down to stereo. MP3 and AAC keep the
  sample rate when MP3 can carry it, otherwise it is lowered to the next MP3 rate (48, 44.1, 32, 24,
  22.05, 16, 12, 11.025 or 8 kHz); Opus always runs at 48 kHz. Global tags are copied (ID3v2.3 for
  MP3).
- Skipped with the reason in the plan: files that also hold pictures or video (cover art is not
  carried over), several audio streams, no audio stream, unknown duration (except the recordings
  above), files above the video size or duration limits.
- Every candidate is probed (exactly one audio stream and nothing else, expected codec, channels and
  sample rate, duration within max(0.2 s, 0.5 %) of the original) and fully decoded. The browser
  also loads it in a detached `<audio>` element and rejects it when the original played and the new
  file does not. Natively, several audio files are encoded at once (as many as
  `--image-concurrency`); the browser engine runs them one after another.
- `--no-audio` (options `audio.enabled: false`) leaves every audio file untouched.

## Clean-up and restructuring

All of these are off by default in the core and the CLI. The web app turns on clean file names by
default and shows the other switches off.

### `--remove-unused safe`

Removes user resources (`content/resources/**`) that nothing refers to: no reference of any kind in
`content.xml`, pages, `search_index.js`, stylesheets, scripts or obfuscated game data. Files that are
only possibly referenced (lenient or dynamic matches, the same name as a missing reference, inside a
folder with HTML or scripts) stay.

### `--deduplicate exact`

Merges byte-identical media (same size, CRC, SHA-256 and bytes, same format and extension) into
one file and rewrites the references of the others. If a reference cannot be rewritten exactly,
both files stay.

### `--flatten legacy`

eXeLearning 3.0 stored each upload in a folder named after the iDevice, `content/resources/<ODE-ID>/`,
where the ODE-ID is a 14-digit timestamp followed by 6 upper-case letters or digits
(`20251009090601SQPBIF`). eXeLearning 4 keeps those folders as if the user had created them.
`inspect` reports them with the `legacy-resource-folders` diagnostic, and the web app shows a notice
and the switch only when a project has them.

- Only files directly inside a folder with exactly that name pattern are moved, to
  `content/resources/<file>`. Folders created by the user are never flattened, whatever their
  content.
- Name collisions are compared as file systems do (ignoring letter case and Unicode normalization):
  the second file becomes `name_2.ext`, then `name_3.ext`… A byte-identical file that already has
  the target name is merged instead of copied.
- A file stays where it is (with the reason in the plan) when it is excluded, protected or
  uncertain, when any of its references is dynamic, lenient, ambiguous or not rewritable, or when the
  file itself contains references (an HTML or CSS file would break its own relative links).
- Every reference is rewritten in its own encoding: `content.xml` (both the long
  `{{context_path}}/content/resources/<ODE-ID>/f` and the eXeLearning 3 short
  `{{context_path}}/<ODE-ID>/f` placeholders; the long form is written), the pages, `search_index.js`,
  plain-JSON DataGame data and the interactive-video JSON. `libs/elpx-manifest.js` is regenerated and
  editor folders left empty are removed.
- The result is verified by resolving every reference again; a move that does not hold is cancelled.
  Moves are wanted changes: the package is delivered even when it is not smaller.

### `--normalize-names slug`

Gives user files clean names (`normalizeNames: "slug"`, `src/core/refs/slug.ts`), in the spirit of
WordPress's `sanitize_title`: lower case, accents removed, only `a`–`z`, `0`–`9` and hyphens
(spaces, underscores and other characters become single hyphens), and the extension in lower case.
Markers left by copying files are removed first: "Copia de …", "Copy of …" (also German and
French), "… - copia", "… copy 2", "… (2)", "… [3]". For example
`Copia de Foto Clase (2).JPG` becomes `foto-clase.jpg`.

- Only the file name changes; folders are not renamed. Files under `custom/` keep their names.
- A name already taken (compared ignoring case and Unicode normalization) gets `-2`, `-3`…
- A file keeps its name, with the reason in the plan, when it is excluded, protected (inside a
  folder with HTML or scripts), uncertain, referenced dynamically, leniently or ambiguously, or when
  it contains references itself.
- The name is chosen after any flattening or audio conversion, so a moved or converted file gets
  its clean name in the same step. Files that only change name appear as `rename-resource`
  operations; references are rewritten and verified exactly as for moves, and the manifest is
  regenerated.
- Names with spaces are fragile in eXeLearning itself: the exporter's
  `asset:\/\/([^"'\s]+)` rewrite stops at whitespace (upstream-review §8.1). Clean names avoid it.
- Renames are wanted changes: the package is delivered even when it is not smaller.

### `--missing-references remove`

By default a missing file is reported (`missing-resource`) and its references are left as they
are: deleting them silently would hide a defect the author may want to repair by adding the file.
This option is an explicit opt-in for authors who prefer a clean package.

- Broken references are those to package paths that do not exist, `asset://` references with no
  mapping in the package, and `file://`, drive (`C:\…`) or UNC paths. Only references in
  `content.xml`, the pages and `search_index.js` are touched, never those inside the user's own
  files, themes or libraries.
- `<img>`, `<source>`, `<track>`, `<embed>`, `<input>`, `<link>` and `<param>`, and `<video>`,
  `<audio>`, `<iframe>`, `<object>` or `<script>` with nothing inside, are deleted as a whole when
  every reference they hold is being removed. Otherwise only the attribute is removed: a link keeps
  its text, a player with other sources keeps them. Broken `srcset` candidates are dropped and the
  rest kept. A reference that is a JSON string value (an iDevice property, DataGame data) becomes an
  empty string.
- References in stylesheets (`url()`) and inside running text (a placeholder written as prose) are
  not removed; the plan lists them with the reason.
- The final validation still applies: no new missing, ambiguous or structural problem may appear.

## Risks to explain to users

- Lossy re-encoding reduces quality; artefacts may show in screen recordings with small text,
  fine textures or fast motion. Use `conservative` or exclude those files.
- Aggressive downscaling can make details unreadable in large diagrams or screenshots.
- Converting WAV/AIFF/FLAC to MP3 is lossy and renames the file. Links to the old name from outside
  the package (another site, an LMS) do not follow; exclude the file or use `--no-audio` if that
  matters.
- Flattening and clean names change where files live and what they are called inside the package;
  the project opens in eXeLearning with the new paths. Links to the old names from outside the
  package do not follow.
- Repeated optimization of the same file adds generation loss; efficient sources are skipped to
  limit it, but there is no guarantee of binary idempotence for lossy encoders.
- The `size` recorded by the file-attachment iDevice becomes stale when a file is recompressed
  (cosmetic).
