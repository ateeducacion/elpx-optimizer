import type { ByteSource } from '../io/byte-source.js';
import type { Diagnostic } from '../diagnostics.js';
import { analyzeArchive, type AnalyzeOptions } from '../analyze/analyze.js';
import type { AnalysisResult } from '../analyze/model.js';

/**
 * Validation verdict for a package: structural integrity (ZIP, CRC,
 * content.xml), reference integrity and packaging coherence. It is the same
 * analysis used before optimizing, summarized as pass/fail.
 */

/** Outcome of one check; checks the analysis never reached are "not-run" (and not ok). */
export type CheckStatus = 'passed' | 'failed' | 'not-run';

export interface ValidationCheck {
  readonly name: string;
  /** True only when the check ran and passed. */
  readonly ok: boolean;
  readonly status: CheckStatus;
  readonly detail: string;
}
export interface ValidationResult {
  readonly schema: 'elpx-optimizer/validation';
  readonly schemaVersion: 1;
  /** fatal problems prevent reliable use; errors are real defects (e.g. missing files). */
  readonly verdict: 'valid' | 'valid-with-warnings' | 'invalid' | 'unusable';
  readonly input: AnalysisResult['input'];
  readonly package?: AnalysisResult['package'];
  readonly counts: Readonly<Record<'fatal' | 'error' | 'warning' | 'info', number>>;
  readonly checks: readonly ValidationCheck[];
  readonly diagnostics: readonly Diagnostic[];
}

/** Validates an archive. */
export async function validateArchive(source: ByteSource, options: AnalyzeOptions): Promise<ValidationResult> {
  const analysis = await analyzeArchive(source, options);
  return summarizeValidation(analysis.result);
}

/** Where an analysis stopped, derived from its fatal diagnostic ("complete" when it did not stop). */
type StopPoint = 'complete' | 'not-a-zip' | 'zip' | 'not-a-project' | 'legacy-content' | 'content-unreadable' | 'content-invalid' | 'entry-data';

function stopPoint(r: AnalysisResult): StopPoint {
  if (r.ok) return 'complete';
  const fatal = r.diagnostics.find((d) => d.severity === 'fatal');
  const code = fatal?.code ?? '';
  if (code === 'not-a-zip') return 'not-a-zip';
  if (fatal?.location?.entry === 'content.xml') {
    if (code === 'legacy-elp') return 'legacy-content';
    return code.startsWith('zip-') ? 'content-unreadable' : 'content-invalid';
  }
  // CRC and size errors are only found by the integrity pass, after content.xml was parsed.
  if (code === 'zip-integrity') return 'entry-data';
  if (code === 'legacy-elp' || code === 'not-an-elpx') return 'not-a-project';
  return 'zip';
}

/** Turns an analysis result into a validation verdict. */
export function summarizeValidation(r: AnalysisResult): ValidationResult {
  const counts = { fatal: 0, error: 0, warning: 0, info: 0 };
  for (const d of r.diagnostics) counts[d.severity]++;
  const has = (code: string): boolean => r.diagnostics.some((d) => d.code === code);
  const at = stopPoint(r);
  const check = (name: string, ran: boolean, failed: boolean, detail: string): ValidationCheck => {
    const status: CheckStatus = !ran ? 'not-run' : failed ? 'failed' : 'passed';
    return { name, ok: status === 'passed', status, detail: ran ? detail : `Not checked: the project could not be analyzed this far (${detail})` };
  };
  const complete = at === 'complete';
  const parsed = complete || at === 'entry-data';
  const checks = [
    check(
      'zip-structure',
      at !== 'not-a-zip',
      at === 'zip' || at === 'content-unreadable' || at === 'entry-data',
      'Central directory, local headers, names, sizes and CRCs',
    ),
    check(
      'eXeLearning-project',
      at !== 'zip',
      at === 'not-a-zip' || at === 'not-a-project' || at === 'legacy-content',
      'content.xml present with an <ode> root',
    ),
    check('content-xml', parsed || at === 'legacy-content' || at === 'content-invalid', at === 'content-invalid', 'Well-formed, no entity declarations'),
    check('ode-structure', parsed, has('ode-structure'), 'Pages, blocks and components have ids, names and types'),
    check('local-references', complete, has('missing-resource'), 'Every local reference points to an existing file'),
    check(
      'unambiguous-references',
      complete,
      has('ambiguous-reference') || has('lenient-resolution'),
      'References resolve to exactly one file without lenient rules',
    ),
    check('download-manifest', complete, has('manifest-invalid') || has('manifest-stale'), 'libs/elpx-manifest.js matches the entries (when present)'),
  ];
  const verdict: ValidationResult['verdict'] = !r.ok ? 'unusable' : counts.error > 0 ? 'invalid' : counts.warning > 0 ? 'valid-with-warnings' : 'valid';
  return {
    schema: 'elpx-optimizer/validation',
    schemaVersion: 1,
    verdict,
    input: r.input,
    ...(r.package ? { package: r.package } : {}),
    counts,
    checks,
    diagnostics: r.diagnostics,
  };
}
