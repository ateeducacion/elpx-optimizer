# Presets, options and quality

Every lossy operation is marked `lossy` in the plan and the report. When a result is invalid, not
smaller by at least the configured minimum (5 % and 1 KiB for images, 5 % and 10 KiB for videos by
default) or fails any check, the original file is kept.

## Video

|                                                              | conservative                           | balanced          | aggressive        |
| ------------------------------------------------------------ | -------------------------------------- | ----------------- | ----------------- |
| Codec                                                        | H.264 (libx264), yuv420p, High profile | same              | same              |
| Quality                                                      | CRF 20                                 | CRF 23            | CRF 28            |
| Max resolution (short side, no upscaling)                    | 1080                                   | 1080              | 720               |
| x264 preset native / browser                                 | slow / faster                          | medium / veryfast | medium / veryfast |
| Audio that must be converted                                 | AAC 192 kb/s                           | AAC 128 kb/s      | AAC 96 kb/s       |
| Left alone when already efficient (H.264/HEVC/VP9/AV1 below) | 0.05 bits/pixel/frame                  | 0.08              | 0.12              |

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
containers other than MP4/M4V/MOV/WebM (no format change is made), audio-only files.

## Images

|                       | conservative                                                   | balanced | aggressive          |
| --------------------- | -------------------------------------------------------------- | -------- | ------------------- |
| JPEG                  | q90 (lossy)                                                    | q82      | q72                 |
| Lossy WebP            | q90, only when resized or forced                               | q82      | q75                 |
| PNG, lossless WebP    | recompressed without changing pixels (verified pixel by pixel) | same     | same                |
| Downscale larger than | —                                                              | —        | 1920 px (long side) |

- Format and extension never change.
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

## Risks to explain to users

- Lossy re-encoding reduces quality; artefacts may show in screen recordings with small text,
  fine textures or fast motion. Use `conservative` or exclude those files.
- Aggressive downscaling can make details unreadable in large diagrams or screenshots.
- Repeated optimization of the same file adds generation loss; efficient sources are skipped to
  limit it, but there is no guarantee of binary idempotence for lossy encoders.
- The `size` recorded by the file-attachment iDevice becomes stale when a file is recompressed
  (cosmetic).
