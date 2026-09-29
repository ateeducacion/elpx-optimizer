import type { AnalysisResult } from '../../core/analyze/model.js';
import type { ProgressEvent } from '../../core/media/engine.js';
import type { OptionsInput } from '../../core/plan/options.js';
import type { OptimizationPlan } from '../../core/plan/plan.js';
import type { OptimizationReport } from '../../core/report/report.js';
import type { ThreadingPreference } from './ffmpeg-loader.js';

/** Messages from the page to the pipeline worker. */
export type ClientMessage =
  | {
      readonly type: 'analyze';
      readonly id: number;
      readonly file: File;
      readonly threading?: ThreadingPreference;
      /** Page override of the largest video processed (never above the worker's limit). */
      readonly maxVideoBytes?: number;
    }
  | { readonly type: 'plan'; readonly id: number; readonly options: OptionsInput }
  | { readonly type: 'optimize'; readonly id: number; readonly planHash: string }
  | { readonly type: 'cancel' }
  | { readonly type: 'playback-result'; readonly requestId: number; readonly result: 'playable' | 'not-playable' | 'unsupported' };

/** Engine status shown separately from job progress. */
export interface EngineStatus {
  readonly state: 'idle' | 'loading' | 'ready' | 'error';
  readonly mode?: 'single' | 'multi';
  readonly reason?: string;
  readonly message?: string;
}

/** Messages from the pipeline worker to the page. */
export type WorkerMessage =
  | { readonly type: 'progress'; readonly id: number; readonly event: ProgressEvent }
  | { readonly type: 'engine'; readonly status: EngineStatus }
  | { readonly type: 'analysis'; readonly id: number; readonly result: AnalysisResult }
  | { readonly type: 'plan'; readonly id: number; readonly plan: OptimizationPlan }
  | { readonly type: 'result'; readonly id: number; readonly report: OptimizationReport; readonly output?: Blob; readonly fileName: string }
  | { readonly type: 'error'; readonly id: number; readonly code: string; readonly message: string }
  | { readonly type: 'cancelled'; readonly id: number }
  | { readonly type: 'playback-check'; readonly requestId: number; readonly blob: Blob; readonly mime: string };

/** Safe download name: "<name>_optimized.elpx" without path or reserved characters. */
export function optimizedFileName(inputName: string): string {
  const base = inputName
    .replace(/^[\s\S]*[\\/]/, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\.(elpx|elp|zip)$/i, '')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 180);
  return `${base || 'project'}_optimized.elpx`;
}
