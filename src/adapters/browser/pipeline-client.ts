import type { AnalysisResult } from '../../core/analyze/model.js';
import type { ProgressEvent } from '../../core/media/engine.js';
import type { OptionsInput } from '../../core/plan/options.js';
import type { OptimizationPlan } from '../../core/plan/plan.js';
import type { OptimizationReport } from '../../core/report/report.js';
import type { ThreadingPreference } from './ffmpeg-loader.js';
import type { ClientMessage, EngineStatus, WorkerMessage } from './protocol.js';

/** Minimal Worker interface (a real Worker, or a fake in tests). */
export interface WorkerLike {
  postMessage(message: ClientMessage): void;
  terminate(): void;
  onmessage: ((e: { data: WorkerMessage }) => void) | null;
  onerror: ((e: { message?: string }) => void) | null;
}

export class PipelineError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'PipelineError';
  }
}

export interface OptimizeResult {
  readonly report: OptimizationReport;
  readonly output?: Blob;
  readonly fileName: string;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (e: ProgressEvent) => void;
}

/**
 * Page-side client of the pipeline worker. Cancelling asks the worker to
 * stop (which terminates FFmpeg); if it does not answer within the grace
 * period the worker is terminated and a fresh one is created, and the last
 * file is analyzed again transparently on the next request.
 */
export class PipelineClient {
  private worker: WorkerLike;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private lastFile: File | undefined;
  private lastThreading: ThreadingPreference | undefined;
  private needsReanalysis = false;
  onEngineStatus: ((s: EngineStatus) => void) | undefined;
  onPlaybackCheck: ((blob: Blob, mime: string) => Promise<'playable' | 'not-playable' | 'unsupported'>) | undefined;
  /** Largest video to process, sent with every analysis (undefined: the worker's default). */
  maxVideoBytes: number | undefined;

  constructor(
    private readonly createWorker: () => WorkerLike,
    private readonly cancelGraceMs = 3000,
  ) {
    this.worker = this.spawn();
  }

  private spawn(): WorkerLike {
    const w = this.createWorker();
    w.onmessage = (e) => this.onMessage(e.data);
    w.onerror = (e) => {
      const error = new PipelineError('worker-error', e.message ?? 'The processing worker failed');
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
      this.restart();
    };
    return w;
  }

  private restart(): void {
    this.worker.terminate();
    this.worker = this.spawn();
    this.needsReanalysis = this.lastFile !== undefined;
    this.onEngineStatus?.({ state: 'idle' });
  }

  private onMessage(m: WorkerMessage): void {
    switch (m.type) {
      case 'engine':
        this.onEngineStatus?.(m.status);
        return;
      case 'playback-check': {
        const check = this.onPlaybackCheck ?? (() => Promise.resolve('unsupported' as const));
        void check(m.blob, m.mime).then((result) => this.worker.postMessage({ type: 'playback-result', requestId: m.requestId, result }));
        return;
      }
      case 'progress':
        this.pending.get(m.id)?.onProgress?.(m.event);
        return;
      default: {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        if (m.type === 'error') p.reject(new PipelineError(m.code, m.message));
        else if (m.type === 'cancelled') p.reject(new PipelineError('cancelled', 'Cancelled'));
        else if (m.type === 'analysis') p.resolve(m.result);
        else if (m.type === 'plan') p.resolve(m.plan);
        else p.resolve({ report: m.report, fileName: m.fileName, ...(m.output ? { output: m.output } : {}) });
      }
    }
  }

  private request<T>(build: (id: number) => ClientMessage, onProgress?: (e: ProgressEvent) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, ...(onProgress ? { onProgress } : {}) });
      this.worker.postMessage(build(id));
    });
  }

  /** Analyzes a file (structure, references and, if present, video streams). */
  analyze(file: File, onProgress?: (e: ProgressEvent) => void, threading?: ThreadingPreference): Promise<AnalysisResult> {
    this.lastFile = file;
    this.lastThreading = threading;
    this.needsReanalysis = false;
    const maxVideoBytes = this.maxVideoBytes;
    return this.request(
      (id) => ({ type: 'analyze', id, file, ...(threading ? { threading } : {}), ...(maxVideoBytes !== undefined ? { maxVideoBytes } : {}) }),
      onProgress,
    );
  }

  private async ensureAnalyzed(): Promise<void> {
    if (this.needsReanalysis && this.lastFile) await this.analyze(this.lastFile, undefined, this.lastThreading);
  }

  /** Computes the plan for the current file. */
  async plan(options: OptionsInput): Promise<OptimizationPlan> {
    await this.ensureAnalyzed();
    return this.request((id) => ({ type: 'plan', id, options }));
  }

  /** Executes the confirmed plan. */
  async optimize(planHash: string, onProgress?: (e: ProgressEvent) => void): Promise<OptimizeResult> {
    await this.ensureAnalyzed();
    return this.request((id) => ({ type: 'optimize', id, planHash }), onProgress);
  }

  /** Cancels the running job; guarantees the worker stops within the grace period. */
  cancel(): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    this.worker.postMessage({ type: 'cancel' });
    return new Promise((resolve) => {
      const started = Date.now();
      const check = (): void => {
        if (this.pending.size === 0) {
          resolve();
          return;
        }
        if (Date.now() - started >= this.cancelGraceMs) {
          const error = new PipelineError('cancelled', 'Cancelled');
          for (const p of this.pending.values()) p.reject(error);
          this.pending.clear();
          this.restart();
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }

  /** Stops the worker (page unload). */
  dispose(): void {
    this.worker.terminate();
  }
}
