# Diagnostics

Generated from `src/core/diagnostics.ts` (`bun scripts/generate-diagnostics-doc.ts`). Codes are
stable. Each diagnostic has `code`, `severity`, `category`, `message`, optional `resource`
(ZIP path), `location` (`entry`, `pageId`, `pageName`, `blockId`, `ideviceId`,
`ideviceType`, `field`, `jsonPath`, `element`, `attribute`, `line`), `repairable` and
`details`.

Severities: `fatal` — the project cannot be analyzed reliably and nothing is optimized; `error` —
a real defect (for example a missing file); `warning` — something that may not work everywhere;
`info` — facts worth knowing. Pre-existing problems never block optimization unless fatal; the
result must not add new ones.

A missing resource is never "repaired" by deleting its reference, and an unchecked external link is
not a missing file.

| Code                        | Default severity | Category            | Meaning                                                                                                      |
| --------------------------- | ---------------- | ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `not-a-zip`                 | fatal            | unsupported-format  | The file is not a ZIP archive (and therefore not an .elpx project).                                          |
| `legacy-elp`                | fatal            | unsupported-format  | Legacy eXeLearning 2.x .elp project; convert it with eXeLearning first.                                      |
| `not-an-elpx`               | fatal            | unsupported-format  | The ZIP archive is not an eXeLearning project (no content.xml).                                              |
| `zip-structure`             | fatal            | structure           | The ZIP structure is corrupt or inconsistent.                                                                |
| `zip-security`              | fatal            | security            | The archive contains unsafe entries (traversal, links, duplicates...).                                       |
| `zip-unsupported`           | fatal            | unsupported-format  | Encryption, split archives or unsupported compression methods.                                               |
| `zip-limit`                 | fatal            | security            | A configured size, count or ratio limit was exceeded.                                                        |
| `zip-integrity`             | fatal            | integrity           | Entry data is corrupt (CRC or size mismatch).                                                                |
| `zip-name-encoding`         | info             | information         | An entry name without the UTF-8 flag was decoded heuristically.                                              |
| `zip-case-collision`        | warning          | structure           | Two entries differ only in letter case (they collide on some systems).                                       |
| `zip-unaccounted-bytes`     | info             | structure           | Bytes not referenced by the central directory; they are not preserved.                                       |
| `zip-archive-comment`       | info             | information         | The archive comment is not preserved.                                                                        |
| `content-xml-invalid`       | fatal            | structure           | content.xml is not well-formed XML.                                                                          |
| `xml-security`              | fatal            | security            | content.xml uses forbidden constructs (entity declarations, external entities).                              |
| `content-xml-not-ode`       | fatal            | structure           | content.xml does not have an <ode> root element.                                                             |
| `ode-structure`             | error            | structure           | The ODE structure is incomplete (missing ids, names or orders).                                              |
| `ode-missing-nav`           | warning          | structure           | content.xml has no pages (odeNavStructures missing or empty).                                                |
| `ode-duplicate-id`          | warning          | structure           | The same page/block/component id appears more than once.                                                     |
| `ode-orphan-page`           | warning          | structure           | A page points to a parent page that does not exist.                                                          |
| `json-properties-malformed` | warning          | structure           | jsonProperties is not valid JSON; it is kept verbatim and treated as opaque.                                 |
| `content-dtd-missing`       | info             | structure           | The DOCTYPE refers to content.dtd but the file is absent.                                                    |
| `screenshot-invalid`        | warning          | integrity           | screenshot.png is not a valid PNG; eXeLearning will drop it on the next export.                              |
| `pp-screenshot-duplicate`   | info             | information         | content.xml embeds a base64 copy of the screenshot (pp_screenshot) that eXeLearning ignores.                 |
| `missing-resource`          | error            | missing-resource    | A local resource is referenced but not present in the package.                                               |
| `lenient-resolution`        | warning          | ambiguous-reference | The reference only resolves through a lenient rule (file name only, case or Unicode normalization).          |
| `ambiguous-reference`       | warning          | ambiguous-reference | The reference could designate more than one resource.                                                        |
| `asset-uri-unmapped`        | warning          | ambiguous-reference | An internal asset:// reference has no verifiable mapping in the package.                                     |
| `stale-editor-path`         | info             | ambiguous-reference | An editor upload path (files/tmp/...) remains; eXeLearning rewrites it only at render time.                  |
| `root-relative-reference`   | warning          | ambiguous-reference | A reference starts with "/" and depends on where the package is hosted.                                      |
| `external-reference`        | info             | external-reference  | External URL (not downloaded, not checked).                                                                  |
| `dynamic-reference`         | info             | ambiguous-reference | A possible reference found in script or obfuscated data; the resource is protected.                          |
| `percent-encoded-reference` | info             | information         | The reference is percent-encoded; eXeLearning looks paths up literally and may not resolve it in the editor. |
| `reference-editable-only`   | info             | information         | Referenced from content.xml but not from the exported HTML pages.                                            |
| `reference-published-only`  | info             | information         | Referenced from the exported HTML pages but not from content.xml.                                            |
| `extension-mismatch`        | warning          | unsupported-format  | The file content does not match its extension.                                                               |
| `unsupported-media`         | info             | unsupported-format  | The media format is not optimized.                                                                           |
| `manifest-invalid`          | warning          | packaging           | libs/elpx-manifest.js is not in the known data format; it is treated as opaque.                              |
| `manifest-stale`            | warning          | packaging           | libs/elpx-manifest.js lists files that are absent or omits existing ones.                                    |
| `duplicate-content`         | info             | information         | Byte-identical resources exist under different names.                                                        |
| `opaque-bundle`             | info             | information         | A resource folder with HTML/JS is treated as an opaque bundle; its files are protected.                      |
| `media-probe-failed`        | warning          | processing          | The media file could not be inspected.                                                                       |
| `media-engine-unavailable`  | info             | processing          | A media engine capability is unavailable in this environment.                                                |
| `processing-failed`         | warning          | processing          | An optimization failed; the original resource was kept.                                                      |
| `limits-host-policy`        | warning          | packaging           | The package exceeds eXeLearning hosted import limits (200 MiB per entry, 500 MiB total, 10000 entries).      |
| `output-regression`         | fatal            | integrity           | The optimized package failed a final validation; it was not delivered.                                       |

## Skip reasons in plans

Videos: `video-disabled`, `engine-unavailable`, `engine-capability`, `unsupported-container`,
`no-video-stream`, `multiple-video-streams`, `attached-picture`, `alpha-channel`, `high-bit-depth`,
`hdr`, `interlaced`, `unsupported-rotation`, `unsupported-subtitle`, `unsupported-data-stream`,
`unsupported-audio`, `unknown-duration`, `exceeds-size-limit`, `exceeds-resolution-limit`,
`exceeds-duration-limit`, `already-efficient`, `not-probed`, `excluded`.

Images: `images-disabled`, `engine-unavailable`, `engine-capability`, `unsupported-format`,
`vector-image`, `animated`, `multi-image`, `corrupt`, `extension-mismatch`, `cmyk`,
`high-bit-depth`, `exceeds-size-limit`, `exceeds-resolution-limit`, `already-efficient`,
`png-disabled`, `excluded`, `kept`.
