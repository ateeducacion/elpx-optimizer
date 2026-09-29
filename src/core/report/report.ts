import { diagnosticKey, type Diagnostic } from '../diagnostics.js';
import type { Analysis } from '../analyze/model.js';
import type { EngineInfo } from '../media/engine.js';
import type { OptimizationPlan, SkippedResource } from '../plan/plan.js';
import { REPORT_SCHEMA_VERSION, TOOL_NAME, TOOL_VERSION, UPSTREAM_VERSION } from '../version.js';

/**
 * Versioned JSON report shared by all interfaces, and its human rendering.
 * It never contains absolute paths or the educational content itself.
 */

export type RunStatus = 'optimized' | 'partial' | 'no-improvement' | 'failed' | 'cancelled' | 'invalid-input' | 'dry-run';

export interface OperationResult {
  readonly id: string;
  readonly op: string;
  readonly path: string;
  readonly status: 'applied' | 'skipped' | 'reverted' | 'failed';
  readonly before?: number;
  readonly after?: number;
  readonly lossy?: boolean;
  readonly conversions?: readonly string[];
  readonly engine?: string;
  readonly detail?: string;
  /** Validations the candidate passed (e.g. probe, full decode, browser playback). */
  readonly checks?: readonly string[];
}

export interface Validation {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface OptimizationReport {
  readonly schema: 'elpx-optimizer/report';
  readonly schemaVersion: number;
  readonly status: RunStatus;
  readonly error?: string;
  readonly tool: { readonly name: string; readonly version: string; readonly upstream: string };
  readonly engine: { readonly engine: string; readonly versions: Readonly<Record<string, string>> };
  readonly input: { readonly name: string; readonly size: number; readonly sha256: string };
  readonly output?: { readonly name: string; readonly size: number; readonly sha256: string };
  readonly options: OptimizationPlan['options'] | undefined;
  readonly planHash: string | undefined;
  readonly sizes: { readonly before: number; readonly after: number; readonly saved: number; readonly savedPercent: number };
  readonly operations: readonly OperationResult[];
  readonly skipped: readonly SkippedResource[];
  readonly diagnostics: {
    readonly before: { readonly counts: Readonly<Record<string, number>>; readonly items: readonly Diagnostic[] };
    readonly introduced: readonly Diagnostic[];
    readonly resolved: readonly Diagnostic[];
  };
  readonly validations: readonly Validation[];
  readonly risks: readonly string[];
}

export interface ReportInput {
  readonly status: RunStatus;
  readonly plan: OptimizationPlan | undefined;
  readonly engineInfo: EngineInfo | undefined;
  readonly analysis: Analysis;
  readonly results: readonly OperationResult[];
  readonly validations: readonly Validation[];
  readonly output?: { name: string; size: number; sha256: string };
  readonly after?: Analysis;
  readonly error?: string;
}

/** Counts diagnostics by severity. */
function counts(list: readonly Diagnostic[]): Record<string, number> {
  const out: Record<string, number> = { fatal: 0, error: 0, warning: 0, info: 0 };
  for (const d of list) out[d.severity] = (out[d.severity] ?? 0) + 1;
  return out;
}

/** Builds the report object. */
export function buildReport(input: ReportInput): OptimizationReport {
  const before = input.analysis.result;
  const beforeSize = before.input.size;
  const afterSize = input.output?.size ?? beforeSize;
  const saved = input.output ? beforeSize - afterSize : 0;
  let introduced: Diagnostic[] = [];
  let resolved: Diagnostic[] = [];
  if (input.after?.result.ok) {
    const bk = new Set(before.diagnostics.map(diagnosticKey));
    const ak = new Set(input.after.result.diagnostics.map(diagnosticKey));
    introduced = input.after.result.diagnostics.filter((d) => !bk.has(diagnosticKey(d)) && d.severity !== 'info');
    resolved = before.diagnostics.filter((d) => !ak.has(diagnosticKey(d)) && d.severity !== 'info');
  }
  const results =
    input.status === 'no-improvement'
      ? input.results.map((r) =>
          r.status === 'applied' ? { ...r, status: 'reverted' as const, detail: `${r.detail ? `${r.detail}; ` : ''}not delivered: no net size reduction` } : r,
        )
      : input.results;
  return {
    schema: 'elpx-optimizer/report',
    schemaVersion: REPORT_SCHEMA_VERSION,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
    tool: { name: TOOL_NAME, version: TOOL_VERSION, upstream: UPSTREAM_VERSION },
    engine: { engine: input.engineInfo?.engine ?? 'none', versions: input.engineInfo?.versions ?? {} },
    input: before.input,
    ...(input.output ? { output: input.output } : {}),
    options: input.plan?.options,
    planHash: input.plan?.planHash,
    sizes: { before: beforeSize, after: afterSize, saved, savedPercent: beforeSize > 0 ? Math.round((saved / beforeSize) * 10000) / 100 : 0 },
    operations: results,
    skipped: input.plan?.skipped ?? [],
    diagnostics: { before: { counts: counts(before.diagnostics), items: before.diagnostics }, introduced, resolved },
    validations: input.validations,
    risks: input.plan?.risks ?? [],
  };
}

/** Formats a byte count for humans (binary units). */
export function formatBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Math.abs(n);
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${n < 0 ? '-' : ''}${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}

const STATUS_TEXT: Record<RunStatus, string> = {
  optimized: 'Optimized',
  partial: 'Optimized with some operations failed (originals kept for those)',
  'no-improvement': 'No improvement: the original was kept (byte-for-byte copy delivered)',
  failed: 'Failed: nothing was delivered',
  cancelled: 'Cancelled: nothing was delivered',
  'invalid-input': 'Invalid input: the project could not be analyzed reliably',
  'dry-run': 'Dry run: nothing was changed',
};

/** Renders a report as plain text (used by the CLI and the skill). */
export function renderReportText(report: OptimizationReport): string {
  const lines: string[] = [];
  lines.push(`${STATUS_TEXT[report.status]}`);
  if (report.error) lines.push(`  ${report.error}`);
  lines.push(`Input:  ${report.input.name} (${formatBytes(report.input.size)}, sha256 ${report.input.sha256.slice(0, 12)}…)`);
  if (report.output) lines.push(`Output: ${report.output.name} (${formatBytes(report.output.size)}, sha256 ${report.output.sha256.slice(0, 12)}…)`);
  if (report.output) lines.push(`Saved:  ${formatBytes(report.sizes.saved)} (${report.sizes.savedPercent}%) — measured on the final file`);
  const byStatus = (s: OperationResult['status']): OperationResult[] => report.operations.filter((o) => o.status === s);
  for (const [label, status] of [
    ['Applied', 'applied'],
    ['Reverted', 'reverted'],
    ['Failed', 'failed'],
  ] as const) {
    const list = byStatus(status);
    if (list.length === 0) continue;
    lines.push(`${label} (${list.length}):`);
    for (const o of list.slice(0, 50)) {
      const sizes = o.before !== undefined && o.after !== undefined ? ` ${formatBytes(o.before)} → ${formatBytes(o.after)}` : '';
      lines.push(`  - ${o.op} ${o.path}${sizes}${o.lossy ? ' [lossy]' : ''}${o.detail ? ` — ${o.detail}` : ''}`);
    }
    if (list.length > 50) lines.push(`  … ${list.length - 50} more`);
  }
  if (report.skipped.length > 0) {
    lines.push(`Left unchanged (${report.skipped.length}):`);
    for (const s of report.skipped.slice(0, 30)) lines.push(`  - ${s.path}: ${s.reason} (${s.detail})`);
    if (report.skipped.length > 30) lines.push(`  … ${report.skipped.length - 30} more`);
  }
  const c = report.diagnostics.before.counts;
  lines.push(`Diagnostics in the input: ${c['fatal'] ?? 0} fatal, ${c['error'] ?? 0} errors, ${c['warning'] ?? 0} warnings, ${c['info'] ?? 0} info`);
  if (report.diagnostics.introduced.length > 0) lines.push(`New diagnostics: ${report.diagnostics.introduced.length}`);
  const failedChecks = report.validations.filter((v) => !v.ok);
  lines.push(`Validations: ${report.validations.length - failedChecks.length}/${report.validations.length} passed`);
  for (const v of failedChecks) lines.push(`  ✗ ${v.name}: ${v.detail ?? ''}`);
  for (const r of report.risks) lines.push(`Note: ${r}`);
  return `${lines.join('\n')}\n`;
}
