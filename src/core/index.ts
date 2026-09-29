/**
 * Portable core of elpx-optimizer. It does not import node:*, Bun, DOM
 * globals, sharp or the eXeLearning editor; platform capabilities are
 * injected through ByteSource/ByteSink, ResourceStore, MediaEngine and
 * OutputTarget adapters.
 */
export { analyzeArchive, type AnalyzeOptions } from './analyze/analyze.js';
export type { Analysis, AnalysisResult, InventoryEntry, ReferenceRecord, DuplicateGroup } from './analyze/model.js';
export { buildOptimizationPlan, type OptimizationPlan, type PlanOperation, type SkippedResource } from './plan/plan.js';
export { normalizeOptions, type OptionsInput, type NormalizedOptions } from './plan/options.js';
export { optimizeArchive, type Platform, type OutputTarget, type OptimizeOutcome } from './optimize/optimize.js';
export { validateArchive, summarizeValidation, type ValidationResult, type ValidationCheck, type CheckStatus } from './validate/validate.js';
export { buildReport, renderReportText, formatBytes, type OptimizationReport, type RunStatus } from './report/report.js';
export { NATIVE_LIMITS, BROWSER_LIMITS, resolveLimits, type Limits } from './limits.js';
export { ElpxError, CancelledError, isElpxError } from './errors.js';
export { DIAGNOSTIC_CODES, type Diagnostic } from './diagnostics.js';
export type { MediaEngine, EngineInfo, ResourceStore, StoredResource, ProgressEvent } from './media/engine.js';
export { TOOL_NAME, TOOL_VERSION, UPSTREAM_SHA } from './version.js';
