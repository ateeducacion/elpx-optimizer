/**
 * Structured diagnostics with stable codes. Every interface (CLI, web,
 * skill) shows the same codes; docs/diagnostics.md documents them.
 */

export type Severity = 'fatal' | 'error' | 'warning' | 'info';

/** Broad category, used to group diagnostics in reports and the UI. */
export type DiagnosticCategory =
  | 'structure'
  | 'security'
  | 'missing-resource'
  | 'ambiguous-reference'
  | 'unsupported-format'
  | 'external-reference'
  | 'processing'
  | 'integrity'
  | 'packaging'
  | 'information';

/** Where a diagnostic originates. All fields are optional. */
export interface SourceLocation {
  readonly entry?: string;
  readonly pageId?: string;
  readonly pageName?: string;
  readonly blockId?: string;
  readonly ideviceId?: string;
  readonly ideviceType?: string;
  readonly field?: string;
  readonly jsonPath?: string;
  readonly element?: string;
  readonly attribute?: string;
  readonly line?: number;
}

export interface Diagnostic {
  readonly code: string;
  readonly severity: Severity;
  readonly category: DiagnosticCategory;
  readonly message: string;
  /** ZIP path of the affected resource, if any. */
  readonly resource?: string;
  readonly location?: SourceLocation;
  /** Whether the optimizer can repair it automatically (it never does so silently). */
  readonly repairable: boolean;
  readonly details?: Readonly<Record<string, unknown>>;
}

interface CodeInfo {
  readonly severity: Severity;
  readonly category: DiagnosticCategory;
  readonly repairable?: boolean;
  readonly description: string;
}

/** Catalogue of every diagnostic code. */
export const DIAGNOSTIC_CODES = {
  'not-a-zip': { severity: 'fatal', category: 'unsupported-format', description: 'The file is not a ZIP archive (and therefore not an .elpx project).' },
  'legacy-elp': { severity: 'fatal', category: 'unsupported-format', description: 'Legacy eXeLearning 2.x .elp project; convert it with eXeLearning first.' },
  'not-an-elpx': { severity: 'fatal', category: 'unsupported-format', description: 'The ZIP archive is not an eXeLearning project (no content.xml).' },
  'zip-structure': { severity: 'fatal', category: 'structure', description: 'The ZIP structure is corrupt or inconsistent.' },
  'zip-security': { severity: 'fatal', category: 'security', description: 'The archive contains unsafe entries (traversal, links, duplicates...).' },
  'zip-unsupported': { severity: 'fatal', category: 'unsupported-format', description: 'Encryption, split archives or unsupported compression methods.' },
  'zip-limit': { severity: 'fatal', category: 'security', description: 'A configured size, count or ratio limit was exceeded.' },
  'zip-integrity': { severity: 'fatal', category: 'integrity', description: 'Entry data is corrupt (CRC or size mismatch).' },
  'zip-name-encoding': { severity: 'info', category: 'information', description: 'An entry name without the UTF-8 flag was decoded heuristically.' },
  'zip-case-collision': { severity: 'warning', category: 'structure', description: 'Two entries differ only in letter case (they collide on some systems).' },
  'zip-unaccounted-bytes': { severity: 'info', category: 'structure', description: 'Bytes not referenced by the central directory; they are not preserved.' },
  'zip-archive-comment': { severity: 'info', category: 'information', description: 'The archive comment is not preserved.' },
  'content-xml-invalid': { severity: 'fatal', category: 'structure', description: 'content.xml is not well-formed XML.' },
  'xml-security': { severity: 'fatal', category: 'security', description: 'content.xml uses forbidden constructs (entity declarations, external entities).' },
  'content-xml-not-ode': { severity: 'fatal', category: 'structure', description: 'content.xml does not have an <ode> root element.' },
  'ode-structure': { severity: 'error', category: 'structure', description: 'The ODE structure is incomplete (missing ids, names or orders).' },
  'ode-missing-nav': { severity: 'warning', category: 'structure', description: 'content.xml has no pages (odeNavStructures missing or empty).' },
  'ode-duplicate-id': { severity: 'warning', category: 'structure', description: 'The same page/block/component id appears more than once.' },
  'ode-orphan-page': { severity: 'warning', category: 'structure', description: 'A page points to a parent page that does not exist.' },
  'json-properties-malformed': {
    severity: 'warning',
    category: 'structure',
    description: 'jsonProperties is not valid JSON; it is kept verbatim and treated as opaque.',
  },
  'content-dtd-missing': { severity: 'info', category: 'structure', description: 'The DOCTYPE refers to content.dtd but the file is absent.' },
  'screenshot-invalid': {
    severity: 'warning',
    category: 'integrity',
    description: 'screenshot.png is not a valid PNG; eXeLearning will drop it on the next export.',
  },
  'pp-screenshot-duplicate': {
    severity: 'info',
    category: 'information',
    description: 'content.xml embeds a base64 copy of the screenshot (pp_screenshot) that eXeLearning ignores.',
  },
  'missing-resource': { severity: 'error', category: 'missing-resource', description: 'A local resource is referenced but not present in the package.' },
  'lenient-resolution': {
    severity: 'warning',
    category: 'ambiguous-reference',
    description: 'The reference only resolves through a lenient rule (file name only, case or Unicode normalization).',
  },
  'ambiguous-reference': { severity: 'warning', category: 'ambiguous-reference', description: 'The reference could designate more than one resource.' },
  'asset-uri-unmapped': {
    severity: 'warning',
    category: 'ambiguous-reference',
    description: 'An internal asset:// reference has no verifiable mapping in the package.',
  },
  'stale-editor-path': {
    severity: 'info',
    category: 'ambiguous-reference',
    description: 'An editor upload path (files/tmp/...) remains; eXeLearning rewrites it only at render time.',
  },
  'root-relative-reference': {
    severity: 'warning',
    category: 'ambiguous-reference',
    description: 'A reference starts with "/" and depends on where the package is hosted.',
  },
  'external-reference': { severity: 'info', category: 'external-reference', description: 'External URL (not downloaded, not checked).' },
  'dynamic-reference': {
    severity: 'info',
    category: 'ambiguous-reference',
    description: 'A possible reference found in script or obfuscated data; the resource is protected.',
  },
  'percent-encoded-reference': {
    severity: 'info',
    category: 'information',
    description: 'The reference is percent-encoded; eXeLearning looks paths up literally and may not resolve it in the editor.',
  },
  'reference-editable-only': { severity: 'info', category: 'information', description: 'Referenced from content.xml but not from the exported HTML pages.' },
  'reference-published-only': { severity: 'info', category: 'information', description: 'Referenced from the exported HTML pages but not from content.xml.' },
  'extension-mismatch': { severity: 'warning', category: 'unsupported-format', description: 'The file content does not match its extension.' },
  'unsupported-media': { severity: 'info', category: 'unsupported-format', description: 'The media format is not optimized.' },
  'manifest-invalid': {
    severity: 'warning',
    category: 'packaging',
    description: 'libs/elpx-manifest.js is not in the known data format; it is treated as opaque.',
  },
  'manifest-stale': { severity: 'warning', category: 'packaging', description: 'libs/elpx-manifest.js lists files that are absent or omits existing ones.' },
  'duplicate-content': { severity: 'info', category: 'information', description: 'Byte-identical resources exist under different names.' },
  'opaque-bundle': {
    severity: 'info',
    category: 'information',
    description: 'A resource folder with HTML/JS is treated as an opaque bundle; its files are protected.',
  },
  'media-probe-failed': { severity: 'warning', category: 'processing', description: 'The media file could not be inspected.' },
  'media-engine-unavailable': { severity: 'info', category: 'processing', description: 'A media engine capability is unavailable in this environment.' },
  'processing-failed': { severity: 'warning', category: 'processing', description: 'An optimization failed; the original resource was kept.' },
  'limits-host-policy': {
    severity: 'warning',
    category: 'packaging',
    description: 'The package exceeds eXeLearning hosted import limits (200 MiB per entry, 500 MiB total, 10000 entries).',
  },
  'output-regression': { severity: 'fatal', category: 'integrity', description: 'The optimized package failed a final validation; it was not delivered.' },
} as const satisfies Record<string, CodeInfo>;

export type DiagnosticCode = keyof typeof DIAGNOSTIC_CODES;

/** Creates a diagnostic with the catalogue defaults for its code. */
export function diagnostic(
  code: DiagnosticCode,
  message: string,
  extra: { resource?: string; location?: SourceLocation; details?: Record<string, unknown>; severity?: Severity } = {},
): Diagnostic {
  const info: CodeInfo = DIAGNOSTIC_CODES[code];
  return {
    code,
    severity: extra.severity ?? info.severity,
    category: info.category,
    message,
    repairable: info.repairable ?? false,
    ...(extra.resource !== undefined ? { resource: extra.resource } : {}),
    ...(extra.location !== undefined ? { location: extra.location } : {}),
    ...(extra.details !== undefined ? { details: extra.details } : {}),
  };
}

/** Stable identity for comparing diagnostics before and after optimization. */
export function diagnosticKey(d: Diagnostic): string {
  const l = d.location ?? {};
  return [d.code, d.resource ?? '', l.entry ?? '', l.ideviceId ?? '', l.field ?? '', l.jsonPath ?? '', l.attribute ?? ''].join('|');
}

/** Orders diagnostics by severity, then code and resource. */
export function sortDiagnostics(list: readonly Diagnostic[]): Diagnostic[] {
  const rank: Record<Severity, number> = { fatal: 0, error: 1, warning: 2, info: 3 };
  return [...list].sort((a, b) => rank[a.severity] - rank[b.severity] || a.code.localeCompare(b.code) || (a.resource ?? '').localeCompare(b.resource ?? ''));
}
