#!/usr/bin/env bun
/** Writes docs/diagnostics.md from the diagnostic catalogue in src/core/diagnostics.ts. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DIAGNOSTIC_CODES } from '../src/core/diagnostics.ts';

const rows = Object.entries(DIAGNOSTIC_CODES).map(([code, info]) => `| \`${code}\` | ${info.severity} | ${info.category} | ${info.description} |`);
const text = `# Diagnostics

Generated from \`src/core/diagnostics.ts\` (\`bun scripts/generate-diagnostics-doc.ts\`). Codes are
stable. Each diagnostic has \`code\`, \`severity\`, \`category\`, \`message\`, optional \`resource\`
(ZIP path), \`location\` (\`entry\`, \`pageId\`, \`pageName\`, \`blockId\`, \`ideviceId\`,
\`ideviceType\`, \`field\`, \`jsonPath\`, \`element\`, \`attribute\`, \`line\`), \`repairable\` and
\`details\`.

Severities: \`fatal\` — the project cannot be analyzed reliably and nothing is optimized; \`error\` —
a real defect (for example a missing file); \`warning\` — something that may not work everywhere;
\`info\` — facts worth knowing. Pre-existing problems never block optimization unless fatal; the
result must not add new ones.

A missing resource is never "repaired" by deleting its reference, and an unchecked external link is
not a missing file.

| Code | Default severity | Category | Meaning |
| --- | --- | --- | --- |
${rows.join('\n')}

## Skip reasons in plans

Videos: \`video-disabled\`, \`engine-unavailable\`, \`engine-capability\`, \`unsupported-container\`,
\`no-video-stream\`, \`multiple-video-streams\`, \`attached-picture\`, \`alpha-channel\`, \`high-bit-depth\`,
\`hdr\`, \`interlaced\`, \`unsupported-rotation\`, \`unsupported-subtitle\`, \`unsupported-data-stream\`,
\`unsupported-audio\`, \`unknown-duration\`, \`exceeds-size-limit\`, \`exceeds-resolution-limit\`,
\`exceeds-duration-limit\`, \`already-efficient\`, \`not-probed\`, \`excluded\`.

Images: \`images-disabled\`, \`engine-unavailable\`, \`engine-capability\`, \`unsupported-format\`,
\`vector-image\`, \`animated\`, \`multi-image\`, \`corrupt\`, \`extension-mismatch\`, \`cmyk\`,
\`high-bit-depth\`, \`exceeds-size-limit\`, \`exceeds-resolution-limit\`, \`already-efficient\`,
\`png-disabled\`, \`excluded\`, \`kept\`.
`;
writeFileSync(join(import.meta.dir, '..', 'docs', 'diagnostics.md'), text);
console.log('docs/diagnostics.md written');
