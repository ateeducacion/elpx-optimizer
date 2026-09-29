import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App, type PipelineApi, type UrlApi } from '../../src/web/app.js';
import type { EngineStatus } from '../../src/adapters/browser/protocol.js';
import type { OptimizeResult } from '../../src/adapters/browser/pipeline-client.js';
import type { ThreadingPreference } from '../../src/adapters/browser/ffmpeg-loader.js';
import type { AnalysisResult, InventoryEntry } from '../../src/core/analyze/model.js';
import type { Diagnostic } from '../../src/core/diagnostics.js';
import type { ProgressEvent } from '../../src/core/media/engine.js';
import type { OptionsInput } from '../../src/core/plan/options.js';
import type { OptimizationPlan, PlanOperation } from '../../src/core/plan/plan.js';
import type { OperationResult, OptimizationReport } from '../../src/core/report/report.js';
import { waitFor } from './helpers.js';

// ------------------------------------------------------------------ test data

/** An inventory entry with sensible defaults. */
function entry(path: string, kind: InventoryEntry['kind'], extra: Partial<InventoryEntry> = {}): InventoryEntry {
  return {
    path,
    isDirectory: false,
    size: 1000,
    compressedSize: 1000,
    method: 'stored',
    role: 'user-asset',
    kind,
    format: path.split('.').pop()!,
    mime: '',
    usage: 'used',
    usageReasons: [],
    references: 1,
    referencedFrom: [],
    representations: [],
    resolutionSensitive: false,
    ...extra,
  };
}

/** A diagnostic with defaults. */
function diag(code: string, severity: Diagnostic['severity'], extra: Partial<Diagnostic> = {}): Diagnostic {
  return { code, severity, category: 'information', message: `${code} message`, repairable: false, ...extra };
}

const ENTRIES: InventoryEntry[] = [
  entry('content/resources/media/clase.mp4', 'video', {
    size: 2_000_000,
    usage: 'used',
    video: {
      container: 'mp4',
      duration: 64,
      width: 640,
      height: 360,
      videoCodec: 'h264',
      audio: [{ codec: 'aac', language: 'es' }, { codec: 'opus', language: 'und' }, { codec: 'mp3' }],
      subtitles: 2,
      chapters: 0,
      otherStreams: 0,
    },
  }),
  entry('content/resources/media/raro.mp4', 'video', {
    size: 5000,
    usage: 'uncertain',
    video: { container: 'mp4', audio: [], subtitles: 0, chapters: 0, otherStreams: 0 },
  }),
  entry('content/resources/media/sin-probar.webm', 'video', { size: 7000, usage: 'unreferenced' }),
  entry('content/resources/fotos/foto.jpg', 'image', {
    size: 45_000,
    image: { width: 800, height: 600, animated: false, hasIcc: true, hasExif: true, hasXmp: false },
  }),
  entry('content/resources/fotos/anim.gif', 'image', {
    size: 2300,
    usage: 'protected',
    image: { animated: true, hasIcc: false, hasExif: false, hasXmp: false },
  }),
  entry('content/resources/fotos/sin-info.png', 'image', { size: 100 }),
  entry('content/resources/docs/guia.pdf', 'document', { size: 30_000, usage: 'not-applicable' }),
  entry('screenshot.png', 'image', {
    size: 13_917,
    role: 'package',
    image: { width: 300, height: 200, animated: false, hasIcc: false, hasExif: false, hasXmp: false },
  }),
  entry('content.xml', 'text', { size: 8000, role: 'package' }),
  entry('theme/style.css', 'text', { size: 33, role: 'runtime' }),
];

/** An analysis result with defaults (a healthy v4 project). */
function analysisResult(extra: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    schema: 'elpx-optimizer/analysis',
    schemaVersion: 1,
    tool: { name: 'elpx-optimizer', version: '0.1.0', upstream: 'x' },
    input: { name: 'curso.elpx', size: 3_000_000, sha256: 'abc' },
    ok: true,
    package: {
      variant: 'v4',
      title: 'Mi curso <b>',
      hasDoctype: true,
      pages: 3,
      components: 7,
      ideviceTypes: {},
      hasScreenshot: true,
      hasManifest: true,
      hasSearchIndex: true,
      hasPublishedHtml: true,
    },
    totals: { entries: 10, files: 10, uncompressedBytes: 2_200_000, userAssetBytes: 2_100_000, imageBytes: 60_000, videoBytes: 2_012_000, audioBytes: 0 },
    entries: ENTRIES,
    references: [],
    duplicates: [],
    diagnostics: [
      diag('missing-resource', 'error', { location: { entry: 'content.xml', pageName: 'Inicio', ideviceType: 'text', field: 'html', jsonPath: '$.a' } }),
      diag('lenient-resolution', 'warning', { location: { entry: 'html/juego.html' } }),
      diag('external-reference', 'info'),
      diag('duplicate-content', 'info', { location: {} }),
      diag('media-probed', 'info'),
    ],
    media: { probed: true, engine: 'browser' },
    ...extra,
  };
}

/** A plan operation of each kind. */
const OPS = [
  {
    id: 'v',
    op: 'transcode-video',
    path: 'content/resources/media/clase.mp4',
    size: 2_000_000,
    lossy: true,
    conversions: ['video: h264 → h264', 'audio kept'],
    job: {},
  },
  { id: 'i', op: 'recompress-image', path: 'content/resources/fotos/foto.jpg', size: 45_000, lossy: true, conversions: ['JPEG q82'], job: {} },
  { id: 'r', op: 'remove-unused', path: 'content/resources/sin-uso/viejo.webp', size: 22_000, reason: 'no references' },
  { id: 'd', op: 'deduplicate', keep: 'content/resources/a.jpg', remove: ['content/resources/b.jpg', 'content/resources/c.jpg'], size: 90_000, references: 2 },
  { id: 'w', op: 'rewrite-references', path: 'content.xml', edits: 2, reason: 'references to removed duplicates' },
] as unknown as PlanOperation[];

/** A plan with defaults. */
function planOf(extra: Partial<OptimizationPlan> = {}): OptimizationPlan {
  return {
    planHash: 'plan-1',
    operations: OPS,
    skipped: [{ path: 'content/resources/media/raro.mp4', kind: 'video', reason: 'unknown-duration', detail: 'Duration is unknown' }],
    risks: ['Lossy video re-encoding'],
    estimate: { kind: 'estimate', savedBytes: 1_200_000, note: '' },
    ...extra,
  } as unknown as OptimizationPlan;
}

/** An optimization result with defaults. */
function resultOf(
  status: OptimizationReport['status'],
  output: Blob | undefined,
  operations: OperationResult[] = [],
  sizes = { before: 3_000_000, after: 1_500_000, saved: 1_500_000, savedPercent: 50 },
): OptimizeResult {
  const report = { status, sizes, operations } as unknown as OptimizationReport;
  return { report, fileName: 'curso_optimized.elpx', ...(output ? { output } : {}) };
}

// ------------------------------------------------------------------ doubles

/** A promise with its settle functions exposed. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Pipeline double: each call is answered by the test through a deferred. */
class FakePipeline implements PipelineApi {
  onEngineStatus: ((s: EngineStatus) => void) | undefined;
  readonly analyzeCalls: { file: File; threading: ThreadingPreference | undefined }[] = [];
  readonly planCalls: OptionsInput[] = [];
  readonly optimizeCalls: string[] = [];
  cancelCalls = 0;
  analyzeProgress: ((e: ProgressEvent) => void) | undefined;
  optimizeProgress: ((e: ProgressEvent) => void) | undefined;
  analysis = deferred<AnalysisResult>();
  plans = deferred<OptimizationPlan>();
  optimization = deferred<OptimizeResult>();

  analyze(file: File, onProgress?: (e: ProgressEvent) => void, threading?: ThreadingPreference): Promise<AnalysisResult> {
    this.analyzeCalls.push({ file, threading });
    this.analyzeProgress = onProgress;
    return this.analysis.promise;
  }

  plan(options: OptionsInput): Promise<OptimizationPlan> {
    this.planCalls.push(options);
    return this.plans.promise;
  }

  optimize(planHash: string, onProgress?: (e: ProgressEvent) => void): Promise<OptimizeResult> {
    this.optimizeCalls.push(planHash);
    this.optimizeProgress = onProgress;
    return this.optimization.promise;
  }

  cancel(): Promise<void> {
    this.cancelCalls++;
    return Promise.resolve();
  }
}

/** Object URL double that records creations and revocations. */
class FakeUrls implements UrlApi {
  readonly created: Blob[] = [];
  readonly revoked: string[] = [];

  createObjectURL(blob: Blob): string {
    this.created.push(blob);
    return `blob:test/${this.created.length}`;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
  }
}

// ------------------------------------------------------------------ helpers

let root: HTMLElement;
let pipeline: FakePipeline;
let urls: FakeUrls;
let app: App;

/** Queries one element inside the app, failing when absent. */
function $<T extends Element = HTMLElement>(selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

/** All matches inside the app. */
function $$<T extends Element = HTMLElement>(selector: string): T[] {
  return [...root.querySelectorAll<T>(selector)];
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Button inside the app by its visible text. */
function button(text: string): HTMLButtonElement {
  const b = $$<HTMLButtonElement>('button').find((x) => x.textContent === text);
  if (!b)
    throw new Error(
      `no button "${text}" in ${$$('button')
        .map((x) => x.textContent)
        .join(', ')}`,
    );
  return b;
}

/** Inventory row names in display order. */
function rowNames(): string[] {
  return $$('.inventory tbody th').map((x) => x.textContent!);
}

/** Drives the app to the review step. */
async function toReview(result = analysisResult()): Promise<void> {
  void app.start(new File(['PK'], 'curso.elpx'));
  pipeline.analysis.resolve(result);
  await waitFor(() => app.currentView === 'review', 2000, 'review');
}

/** Drives the app to the plan step with the given plan. */
async function toPlan(plan = planOf()): Promise<void> {
  await toReview();
  $<HTMLFormElement>('form.options').requestSubmit();
  pipeline.plans.resolve(plan);
  await waitFor(() => app.currentView === 'plan', 2000, 'plan');
}

/** Drives the app to the running step. */
async function toRunning(): Promise<void> {
  await toPlan();
  button('Optimize').click();
  await waitFor(() => app.currentView === 'running', 2000, 'running');
}

beforeEach(() => {
  root = document.createElement('div');
  document.body.append(root);
  pipeline = new FakePipeline();
  urls = new FakeUrls();
  app = new App(root, pipeline, 'en', urls);
  app.mount();
});

afterEach(() => {
  root.remove();
  vi.restoreAllMocks();
});

// ------------------------------------------------------------------ tests

describe('App shell', () => {
  it('renders the header, the picker and the footer in the chosen language', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('eXeLearning project optimizer');
    expect($('h1').textContent).toBe('eXeLearning project optimizer');
    expect($('#h-step1').textContent).toBe('1Choose the project');
    expect($('[data-testid="dropzone"]')).toBeTruthy();
    expect($('.app-footer').textContent).toMatch(/AGPL-3.0/);
    const notices = $<HTMLAnchorElement>('.app-footer a');
    expect(notices.getAttribute('href')).toBe('licenses/THIRD-PARTY-NOTICES.txt');
    expect(notices.textContent).toBe('Third-party notices and licenses');
    expect($('[role="status"]').getAttribute('aria-live')).toBe('polite');
    expect(app.currentView).toBe('start');
  });

  it('switches between Spanish and English, keeping the current step', async () => {
    await toReview();
    const toggle = $<HTMLButtonElement>('.link-button');
    expect(toggle.getAttribute('aria-label')).toBe('Switch language to Spanish');
    toggle.click();
    expect(document.documentElement.lang).toBe('es');
    expect($('h1').textContent).toBe('Optimizador de proyectos eXeLearning');
    expect($('#h-step2').textContent).toBe('2Revisa el contenido');
    expect($('.app-footer a').textContent).toBe('Avisos de terceros y licencias');
    expect(app.currentView).toBe('review');
    $<HTMLButtonElement>('.link-button').click();
    expect($('#h-step2').textContent).toBe('2Review the contents');
  });

  it('shows the video engine status', () => {
    const line = $('.engine-line');
    expect(line.textContent).toBe('Video engine: loaded when needed.');
    expect(line.dataset['state']).toBe('idle');
    pipeline.onEngineStatus!({ state: 'loading' });
    expect(line.textContent).toMatch(/^Loading the video engine/);
    pipeline.onEngineStatus!({ state: 'ready', mode: 'single' });
    expect(line.textContent).toBe('Video engine ready (single-thread).');
    pipeline.onEngineStatus!({ state: 'ready', mode: 'multi' });
    expect(line.textContent).toBe('Video engine ready (multi-thread).');
    pipeline.onEngineStatus!({ state: 'error', message: 'no wasm' });
    expect(line.textContent).toBe('The video engine could not be loaded: no wasm');
    pipeline.onEngineStatus!({ state: 'error' });
    expect(line.textContent).toBe('The video engine could not be loaded: ');
    expect(line.dataset['state']).toBe('error');
  });

  it('starts with the thread preference given by the page', async () => {
    root.remove();
    root = document.createElement('div');
    document.body.append(root);
    app = new App(root, pipeline, 'en', urls, { threading: 'single' });
    app.mount();
    await toReview();
    expect(pipeline.analyzeCalls[0]!.threading).toBe('single');
    expect($<HTMLInputElement>('form.options [name="multithread"]').checked).toBe(false);
    expect(app.readOptions($<HTMLFormElement>('form.options'))).toMatchObject({ preset: 'balanced' });
    // Ticking the box again restores automatic selection for the next analysis.
    $<HTMLInputElement>('form.options [name="multithread"]').checked = true;
    app.readOptions($<HTMLFormElement>('form.options'));
    app.reset();
    void app.start(new File(['PK'], 'b.elpx'));
    expect(pipeline.analyzeCalls[1]!.threading).toBe('auto');
  });

  it('uses the real URL API by default', async () => {
    const createObjectURL = vi.spyOn(URL, 'createObjectURL');
    const own = document.createElement('div');
    document.body.append(own);
    const p = new FakePipeline();
    const real = new App(own, p, 'es');
    real.mount();
    void real.start(new File(['PK'], 'x.elpx'));
    p.analysis.resolve(analysisResult());
    await waitFor(() => real.currentView === 'review', 2000);
    own.querySelector<HTMLFormElement>('form.options')!.requestSubmit();
    p.plans.resolve(planOf());
    await waitFor(() => real.currentView === 'plan', 2000);
    [...own.querySelectorAll('button')].find((b) => b.textContent === 'Optimizar')!.click();
    p.optimization.resolve(resultOf('optimized', new Blob(['zip'])));
    await waitFor(() => real.currentView === 'result', 2000);
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    real.reset();
    own.remove();
  });
});

describe('file picker', () => {
  it('starts when a file is chosen, ignoring an empty choice', async () => {
    const input = $<HTMLInputElement>('#file-input');
    expect(input.accept).toBe('.elpx,.elp,.zip,application/zip');
    input.dispatchEvent(new Event('change'));
    expect(pipeline.analyzeCalls).toHaveLength(0);
    const dt = new DataTransfer();
    const file = new File(['PK'], 'elegido.elpx');
    dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('change'));
    expect(pipeline.analyzeCalls).toEqual([{ file, threading: 'auto' }]);
    expect(app.currentView).toBe('analyzing');
  });

  it('accepts a dropped file and highlights the zone while dragging', () => {
    const zone = $('[data-testid="dropzone"]');
    const over = new DragEvent('dragover', { cancelable: true });
    zone.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(zone.classList.contains('is-over')).toBe(true);
    zone.dispatchEvent(new DragEvent('dragleave'));
    expect(zone.classList.contains('is-over')).toBe(false);
    zone.dispatchEvent(new DragEvent('dragover', { cancelable: true }));
    // A drop without files (e.g. text) does nothing.
    const empty = new DragEvent('drop', { cancelable: true });
    zone.dispatchEvent(empty);
    expect(empty.defaultPrevented).toBe(true);
    expect(zone.classList.contains('is-over')).toBe(false);
    zone.dispatchEvent(new DragEvent('drop', { cancelable: true, dataTransfer: new DataTransfer() }));
    expect(pipeline.analyzeCalls).toHaveLength(0);
    const dt = new DataTransfer();
    const file = new File(['PK'], 'soltado.elpx');
    dt.items.add(file);
    zone.dispatchEvent(new DragEvent('drop', { cancelable: true, dataTransfer: dt }));
    expect(pipeline.analyzeCalls[0]!.file).toBe(file);
  });

  it('opens the file dialog from the keyboard (Enter and Space only)', () => {
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => undefined);
    const label = $('label.button');
    expect(label.getAttribute('role')).toBe('button');
    expect(label.getAttribute('tabindex')).toBe('0');
    expect(label.getAttribute('for')).toBe('file-input');
    for (const key of ['Enter', ' ', 'a', 'Tab']) label.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(2);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    label.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
  });
});

describe('analysis', () => {
  it('shows indeterminate and determinate progress while analyzing', async () => {
    void app.start(new File(['PK'], 'grande.elpx'));
    expect($('#h-step2').textContent).toBe('2Review the contents');
    expect($('.step-step2 p').textContent).toBe('Analyzing grande.elpx…');
    const bar = (): HTMLProgressElement => $<HTMLProgressElement>('[data-role="progress"] progress');
    expect(bar().hasAttribute('value')).toBe(false);
    expect(bar().getAttribute('aria-label')).toBe('Reading the project');
    pipeline.analyzeProgress!({ stage: 'read', fraction: 0.25 });
    expect(bar().value).toBe(0.25);
    pipeline.analyzeProgress!({ stage: 'probe', resource: 'content/resources/v.mp4', item: 1, items: 3 });
    expect(bar().hasAttribute('value')).toBe(false);
    expect($('.progress-text').textContent).toBe('Inspecting video — 1 of 3 content/resources/v.mp4');
    pipeline.analyzeProgress!({ stage: 'analyze', fraction: 1.4 });
    expect(bar().value).toBe(1);
    // Stages are only listed while optimizing.
    expect(root.querySelector('[data-role="stages"]')).toBeNull();
  });

  it('moves focus to the step heading and announces the review', async () => {
    await toReview();
    expect(document.activeElement).toBe($('#h-step2'));
    expect($('[role="status"]').textContent).toBe('Review the contents');
  });

  it('shows the project summary, weight, issues and resources', async () => {
    await toReview();
    expect($('.project-meta').textContent).toBe('Mi curso <b> — eXeLearning 4 format, 3 pages · 7 iDevices, 2.9 MB');
    expect(root.querySelector('.project-meta b')).toBeNull();
    const legend = $$('.weight-legend li').map((li) => li.textContent);
    expect(legend).toEqual(['Video 1.9 MB', 'Images 58.6 KB', 'Everything else 125 KB']);
    expect($$('.weight-bar .seg')).toHaveLength(3);
    expect($('.weight-bar').getAttribute('aria-label')).toBe('Video 1.9 MB, Images 58.6 KB, Audio 0 B, Everything else 125 KB');
    const problems = $<HTMLDetailsElement>('details.problems');
    expect(problems.open).toBe(true);
    expect($('details.problems summary').textContent).toBe('Issues: 1 errors, 1 warnings, 3 notes');
    const items = $$('.diagnostics li').map((li) => li.textContent);
    expect(items).toEqual([
      'missing-resource missing-resource message (Inicio › text › html › $.a)',
      'lenient-resolution lenient-resolution message (html/juego.html)',
      'external-reference external-reference message',
      'duplicate-content duplicate-content message',
    ]);
    expect(rowNames()).toEqual([
      'media/clase.mp4',
      'fotos/foto.jpg',
      'docs/guia.pdf',
      'screenshot.png',
      'media/sin-probar.webm',
      'media/raro.mp4',
      'fotos/anim.gif',
      'fotos/sin-info.png',
    ]);
    const details = $$('.inventory tbody td.details').map((td) => td.textContent);
    expect(details).toEqual(['h264 640×360, 1:04, aac es, opus, mp3, 2 subt.', '800×600', '', '300×200', 'not inspected', '? ?×?, —', '?×?, animated', '']);
    expect($$('.inventory .usage').map((u) => u.textContent)).toEqual(['in use', 'in use', '—', 'in use', 'unreferenced', 'uncertain', 'protected', 'in use']);
    // Only images and videos can be excluded.
    expect($$('.inventory tbody input[type="checkbox"]')).toHaveLength(7);
    expect($('.table-wrap').getAttribute('role')).toBe('region');
  });

  it('describes v3 projects without a title and projects without issues', async () => {
    await toReview(
      analysisResult({
        package: { ...analysisResult().package!, variant: 'v3', title: undefined } as AnalysisResult['package'],
        diagnostics: [],
        totals: { ...analysisResult().totals, uncompressedBytes: 0, videoBytes: 0, imageBytes: 0 },
      }),
    );
    expect($('.project-meta').textContent).toMatch(/^curso\.elpx — eXeLearning 3\.0 format/);
    expect($('details.problems summary').textContent).toBe('Issues: No issues found.');
    expect($<HTMLDetailsElement>('details.problems').open).toBe(false);
    expect($$('.weight-bar .seg')).toHaveLength(0);
  });

  it('sorts the resources table by each column', async () => {
    await toReview();
    const sortButton = (label: string): HTMLButtonElement => $<HTMLButtonElement>(`button.sort[aria-label="Sort by ${label}"]`);
    const sortState = (): (string | null)[] => $$('.inventory thead th').map((th) => th.getAttribute('aria-sort'));
    expect(sortState()).toEqual(['none', 'none', 'descending', null, 'none', null]);
    expect(sortButton('Size').textContent).toBe('Size ▼');
    sortButton('Size').click();
    expect(sortState()[2]).toBe('ascending');
    expect(sortButton('Size').textContent).toBe('Size ▲');
    expect(rowNames()[0]).toBe('fotos/sin-info.png');
    sortButton('File').click();
    expect(sortState()).toEqual(['ascending', 'none', 'none', null, 'none', null]);
    expect(rowNames()).toEqual([...rowNames()].sort());
    expect(rowNames()[0]).toBe('docs/guia.pdf');
    sortButton('File').click();
    expect(sortState()[0]).toBe('descending');
    expect(rowNames()[0]).toBe('screenshot.png');
    sortButton('Type').click();
    // By kind (document, image, video), keeping the inventory order within a kind.
    expect($$('.inventory tbody td:first-of-type').map((td) => td.textContent)).toEqual(['pdf', 'jpg', 'gif', 'png', 'png', 'mp4', 'mp4', 'webm']);
    sortButton('Usage').click();
    expect($$('.inventory .usage')[0]!.textContent).toBe('—');
    expect(sortState()[4]).toBe('ascending');
    // Size starts descending again when chosen after another column.
    sortButton('Size').click();
    expect(sortState()[2]).toBe('descending');
    expect(rowNames()[0]).toBe('media/clase.mp4');
  });

  it('shows the fatal problem of an unusable file, with help for legacy projects', async () => {
    void app.start(new File(['x'], 'viejo.elp'));
    pipeline.analysis.resolve(
      analysisResult({ ok: false, package: undefined, diagnostics: [diag('legacy-elp', 'fatal', { message: 'Legacy eXeLearning 2.x project' })] }),
    );
    await waitFor(() => app.currentView === 'error', 2000);
    const alert = $('[role="alert"]');
    expect(alert.querySelector('h2')!.textContent).toBe('Could not finish');
    expect(alert.textContent).toContain('Legacy eXeLearning 2.x project');
    expect(alert.textContent).toContain('Open the file in eXeLearning, save it as .elpx and try again.');
    expect(document.activeElement).toBe($('#h-error'));
    button('Start over').click();
    expect(app.currentView).toBe('start');
  });

  it('reports an unusable file without a fatal diagnostic generically', async () => {
    void app.start(new File(['x'], 'raro.elpx'));
    pipeline.analysis.resolve(analysisResult({ ok: false, diagnostics: [diag('zip-case-collision', 'warning')] }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('This file cannot be optimized reliably.');
    expect($('[role="alert"]').textContent).not.toContain('eXeLearning, save it');
  });

  it('shows analysis failures, with or without an error code', async () => {
    void app.start(new File(['x'], 'a.elpx'));
    pipeline.analysis.reject(Object.assign(new Error('The processing worker failed'), { code: 'worker-error' }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('The processing worker failed');
    button('Start over').click();
    pipeline.analysis = deferred();
    void app.start(new File(['x'], 'b.elpx'));
    pipeline.analysis.reject(new Error('plain failure'));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('plain failure');
  });
});

describe('options', () => {
  it('maps every advanced field and the excluded resources to OptionsInput', async () => {
    await toReview();
    const form = $<HTMLFormElement>('form.options');
    const field = <T extends HTMLElement>(name: string): T => form.querySelector<T>(`[name="${name}"]`)!;
    const input = (name: string): HTMLInputElement => field<HTMLInputElement>(name);
    // Defaults (balanced preset, empty numbers, the preset's resolution).
    expect(form.querySelector<HTMLInputElement>('input[name="preset"]:checked')!.value).toBe('balanced');
    expect(app.readOptions(form)).toEqual({
      preset: 'balanced',
      video: { enabled: true },
      images: { enabled: true, png: true, stripMetadata: false, includeScreenshot: false },
      removeUnused: 'off',
      deduplicate: 'off',
      exclude: [],
    });
    form.querySelector<HTMLInputElement>('input[name="preset"][value="aggressive"]')!.checked = true;
    input('video').checked = false;
    field<HTMLSelectElement>('maxResolution').value = '720';
    input('crf').value = '26';
    input('audioBitrate').value = '96';
    input('images').checked = false;
    input('jpegQuality').value = '70';
    input('webpQuality').value = '75';
    input('maxDimension').value = '1920';
    input('png').checked = false;
    input('stripMetadata').checked = true;
    input('includeScreenshot').checked = true;
    input('multithread').checked = false;
    input('removeUnused').checked = true;
    input('deduplicate').checked = true;
    const boxes = $$<HTMLInputElement>('.inventory tbody input[type="checkbox"]');
    expect(boxes[0]!.getAttribute('aria-label')).toBe('Optimize content/resources/media/clase.mp4');
    boxes[0]!.click();
    boxes[2]!.click();
    boxes[2]!.click(); // re-enabled
    expect(app.readOptions(form)).toEqual({
      preset: 'aggressive',
      video: { enabled: false, maxResolution: '720', crf: 26, audioBitrate: 96 },
      images: { enabled: false, png: false, stripMetadata: true, includeScreenshot: true, jpegQuality: 70, webpQuality: 75, maxDimension: 1920 },
      removeUnused: 'safe',
      deduplicate: 'exact',
      exclude: ['content/resources/media/clase.mp4'],
    });
    field<HTMLSelectElement>('maxResolution').value = 'original';
    expect(app.readOptions(form).video).toMatchObject({ maxResolution: 'original' });
  });

  it('falls back to defaults for a form without fields', () => {
    expect(app.readOptions(document.createElement('form'))).toEqual({
      preset: 'balanced',
      video: { enabled: false },
      images: { enabled: false, png: false, stripMetadata: false, includeScreenshot: false },
      removeUnused: 'off',
      deduplicate: 'off',
      exclude: [],
    });
  });

  it('keeps the chosen options and exclusions when returning from the plan', async () => {
    await toReview();
    const form = $<HTMLFormElement>('form.options');
    form.querySelector<HTMLInputElement>('input[name="preset"][value="conservative"]')!.checked = true;
    form.querySelector<HTMLSelectElement>('[name="maxResolution"]')!.value = '1080';
    form.querySelector<HTMLInputElement>('[name="crf"]')!.value = '20';
    form.querySelector<HTMLInputElement>('[name="maxDimension"]')!.value = '2000';
    form.querySelector<HTMLInputElement>('[name="multithread"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="video"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="removeUnused"]')!.checked = true;
    $$<HTMLInputElement>('.inventory tbody input[type="checkbox"]')[0]!.click();
    form.requestSubmit();
    expect(pipeline.planCalls[0]).toMatchObject({ preset: 'conservative', exclude: ['content/resources/media/clase.mp4'] });
    pipeline.plans.resolve(planOf());
    await waitFor(() => app.currentView === 'plan', 2000);
    button('Change options').click();
    expect(app.currentView).toBe('review');
    const again = $<HTMLFormElement>('form.options');
    expect(again.querySelector<HTMLInputElement>('input[name="preset"]:checked')!.value).toBe('conservative');
    expect(again.querySelector<HTMLSelectElement>('[name="maxResolution"]')!.value).toBe('1080');
    expect(again.querySelector<HTMLInputElement>('[name="crf"]')!.value).toBe('20');
    expect(again.querySelector<HTMLInputElement>('[name="maxDimension"]')!.value).toBe('2000');
    expect(again.querySelector<HTMLInputElement>('[name="multithread"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="video"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="removeUnused"]')!.checked).toBe(true);
    expect(again.querySelector<HTMLInputElement>('[name="deduplicate"]')!.checked).toBe(false);
    expect($$<HTMLInputElement>('.inventory tbody input[type="checkbox"]')[0]!.checked).toBe(false);
    // The single-thread choice applies to the next analysis.
    app.reset();
    void app.start(new File(['PK'], 'otro.elpx'));
    expect(pipeline.analyzeCalls.at(-1)!.threading).toBe('single');
  });

  it('shows planning errors', async () => {
    await toReview();
    $<HTMLFormElement>('form.options').requestSubmit();
    pipeline.plans.reject(Object.assign(new Error('crf must be an integer'), { code: 'invalid-options' }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('crf must be an integer');
  });

  it('shows planning errors without a code', async () => {
    await toReview();
    $<HTMLFormElement>('form.options').requestSubmit();
    pipeline.plans.reject(new Error('lost'));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] h2').textContent).toBe('Could not finish');
  });
});

describe('plan', () => {
  it('lists every operation, the skipped resources, risks and the estimate', async () => {
    await toPlan();
    expect(document.activeElement).toBe($('#h-step4'));
    expect($('.step-step4 h3').textContent).toBe('Will do');
    expect($$('.plan-ops li').map((li) => li.textContent)).toEqual([
      'transcode-video media/clase.mp4 (1.9 MB): video: h264 → h264; audio kept',
      'recompress-image fotos/foto.jpg (43.9 KB): JPEG q82',
      'remove-unused content/resources/sin-uso/viejo.webp — no references',
      'deduplicate content/resources/a.jpg ← content/resources/b.jpg, content/resources/c.jpg',
      'rewrite-references content.xml: references to removed duplicates',
    ]);
    expect($('.estimate').textContent).toBe('Estimate before processing (not measured): about 1.1 MB less.');
    expect($('.step-step4 details summary').textContent).toBe('Left as is (1)');
    expect($('.plan-skipped li').textContent).toBe('media/raro.mp4: Duration is unknown');
    expect($('.step-step4 .note').textContent).toBe('Lossy video re-encoding');
    expect(button('Optimize').disabled).toBe(false);
  });

  it('explains an empty plan and does not allow running it', async () => {
    await toPlan(planOf({ operations: [], skipped: [], risks: [] }));
    expect($('.step-step4 p').textContent).toBe('With these options there is nothing to optimize.');
    expect(root.querySelector('.plan-ops')).toBeNull();
    expect(root.querySelector('.estimate')).toBeNull();
    expect(root.querySelector('.step-step4 details')).toBeNull();
    expect(button('Optimize').disabled).toBe(true);
  });
});

describe('running', () => {
  it('shows stages and progress, determinate or not', async () => {
    await toRunning();
    expect(pipeline.optimizeCalls).toEqual(['plan-1']);
    expect(document.activeElement).toBe($('#h-step5'));
    const stages = (): string[] => $$('[data-role="stages"] li').map((li) => `${li.textContent}${li.getAttribute('aria-current') === 'step' ? '*' : ''}`);
    expect(stages()).toEqual([
      'Loading the engine',
      'Extracting',
      'Re-encoding video',
      'Recompressing images',
      'Validating',
      'Packaging',
      'Verifying the result',
    ]);
    pipeline.optimizeProgress!({ stage: 'transcode', resource: 'content/resources/media/clase.mp4', processedSeconds: 30, totalSeconds: 64, fraction: 0.47 });
    expect(stages()[2]).toBe('Re-encoding video*');
    expect($('[data-role="stages"] .is-current').textContent).toBe('Re-encoding video');
    expect($<HTMLProgressElement>('[data-role="progress"] progress').value).toBeCloseTo(0.47);
    expect($('.progress-text').textContent).toBe('Re-encoding video — 0:30 of 1:04 content/resources/media/clase.mp4');
    pipeline.optimizeProgress!({ stage: 'validate', message: 'Decoding the new video' });
    expect($<HTMLProgressElement>('[data-role="progress"] progress').hasAttribute('value')).toBe(false);
    expect($('.progress-text').textContent).toBe('Validating');
    // Missing totals: no "x of y" detail.
    pipeline.optimizeProgress!({ stage: 'transcode', processedSeconds: 3, totalSeconds: 0 });
    expect($('.progress-text').textContent).toBe('Re-encoding video');
  });

  it('cancels: the button reflects the request and the run ends as cancelled', async () => {
    await toRunning();
    const cancel = button('Cancel');
    expect(cancel.className).toBe('button danger');
    cancel.click();
    expect(pipeline.cancelCalls).toBe(1);
    expect(button('Cancelling…').disabled).toBe(true);
    pipeline.optimization.reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] h2').textContent).toBe('Done');
    expect($('[role="alert"] p').textContent).toBe('Cancelled. No file was produced.');
    expect(urls.created).toEqual([]);
  });

  it('shows optimization failures', async () => {
    await toRunning();
    pipeline.optimization.reject(Object.assign(new Error('The confirmed plan is no longer current'), { code: 'plan-mismatch' }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('The confirmed plan is no longer current');
    button('Start over').click();
    pipeline.optimization = deferred();
    await toRunning();
    pipeline.optimization.reject(new Error('no code'));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('no code');
  });

  it('ignores progress that arrives after the step changed', async () => {
    await toRunning();
    const progress = pipeline.optimizeProgress!;
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip'])));
    await waitFor(() => app.currentView === 'result', 2000);
    progress({ stage: 'verify' });
    expect(root.querySelector('[data-role="progress"]')).toBeNull();
    expect(app.currentView).toBe('result');
  });
});

describe('result', () => {
  const operations: OperationResult[] = [
    { id: 'v', op: 'transcode-video', path: 'content/resources/media/clase.mp4', status: 'applied', before: 2_000_000, after: 500_000 },
    {
      id: 'i',
      op: 'recompress-image',
      path: 'content/resources/fotos/foto.jpg',
      status: 'reverted',
      before: 45_000,
      after: 46_000,
      detail: 'not smaller enough',
    },
    { id: 'p', op: 'recompress-image', path: 'content/resources/fotos/x.png', status: 'failed', detail: 'decoder error' },
    { id: 's', op: 'recompress-image', path: 'content/resources/fotos/y.png', status: 'skipped', before: 10 },
  ];

  it('offers the optimized file and the report as downloads, and revokes them on reset', async () => {
    await toRunning();
    const output = new Blob(['optimized zip']);
    pipeline.optimization.resolve(resultOf('partial', output, operations));
    await waitFor(() => app.currentView === 'result', 2000);
    expect(document.activeElement).toBe($('#h-step6'));
    expect($('[role="status"]').textContent).toBe('Project optimized; some operations failed and those resources stay as they were.');
    expect($('.result-status').className).toBe('result-status status-partial');
    expect($$('.compare-row').map((r) => r.textContent)).toEqual(['Before2.9 MB', 'After1.4 MB']);
    expect($<HTMLElement>('.fill-after').style.width).toBe('50%');
    expect($('.saved').textContent).toBe('Measured saving: 1.4 MB (50 %)');
    const download = $<HTMLAnchorElement>('[data-testid="download"]');
    expect(download.getAttribute('href')).toBe('blob:test/1');
    expect(download.getAttribute('download')).toBe('curso_optimized.elpx');
    expect(download.textContent).toBe('Download curso_optimized.elpx');
    const reportLink = $<HTMLAnchorElement>('[data-testid="download-report"]');
    expect(reportLink.getAttribute('href')).toBe('blob:test/2');
    expect(reportLink.getAttribute('download')).toBe('curso_optimized_report.json');
    expect(urls.created[0]).toBe(output);
    expect(urls.created[1]!.type).toBe('application/json');
    expect(JSON.parse(await urls.created[1]!.text())).toMatchObject({ status: 'partial' });
    expect($$('.op-results li').map((li) => li.textContent)).toEqual([
      'Applied media/clase.mp4 1.9 MB → 488 KB',
      'Discarded (original kept) fotos/foto.jpg 43.9 KB → 44.9 KB — not smaller enough',
      'Failed (original kept) fotos/x.png — decoder error',
      'Discarded (original kept) fotos/y.png',
    ]);
    // A video was recompressed: no "originals kept" note.
    expect(root.querySelector('[role="note"]')).toBeNull();
    expect(urls.revoked).toEqual([]);
    button('Optimize another project').click();
    expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
    expect(app.currentView).toBe('start');
    expect(document.activeElement).toBe($('#h-step1'));
  });

  it('releases previous downloads when another file is started directly', async () => {
    await toRunning();
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip'])));
    await waitFor(() => app.currentView === 'result', 2000);
    pipeline.analysis = deferred();
    void app.start(new File(['PK'], 'siguiente.elpx'));
    expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
    expect(app.currentView).toBe('analyzing');
  });

  it('shows "no improvement" without a saving line', async () => {
    await toRunning();
    pipeline.optimization.resolve(resultOf('no-improvement', new Blob(['same']), [], { before: 1000, after: 1000, saved: 0, savedPercent: 0 }));
    await waitFor(() => app.currentView === 'result', 2000);
    expect($('.result-status').textContent).toBe('The size could not be reduced. The download is an identical copy of the original.');
    expect(root.querySelector('.saved')).toBeNull();
    expect($<HTMLElement>('.fill-before').style.width).toBe('100%');
    expect(root.querySelector('[data-testid="download"]')).not.toBeNull();
  });

  it('says clearly when no planned video was recompressed', async () => {
    await toRunning();
    const videos: OperationResult[] = [
      {
        id: 'v1',
        op: 'transcode-video',
        path: 'content/resources/media/a.mp4',
        status: 'reverted',
        before: 2_000_000,
        after: 1_990_000,
        detail: 'not smaller enough',
      },
      { id: 'v2', op: 'transcode-video', path: 'content/resources/media/b.mp4', status: 'failed', detail: 'The browser ran out of memory for this video' },
    ];
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip']), [...videos, operations[1]!, { ...operations[1]!, id: 'j', status: 'applied' }]));
    await waitFor(() => app.currentView === 'result', 2000);
    // The run status is kept; the note is not an error.
    expect($('.result-status').textContent).toBe('Project optimized.');
    const note = $('[role="note"]');
    expect(note.textContent).toBe('No video was recompressed; the originals were kept (see reasons below).');
    expect(note.className).toBe('callout');
    expect(note.closest('[role="alert"]')).toBeNull();
    // It sits right under the status, before the per-resource reasons.
    expect(note.previousElementSibling).toBe($('.result-status'));
    expect($$('.op-results li')[1]!.textContent).toContain('ran out of memory');
    $<HTMLButtonElement>('.link-button').click();
    expect($('[role="note"]').textContent).toBe('Ningún vídeo se ha recomprimido; se conservan los originales (ver motivos abajo).');
  });

  it('adds no video note when no video was planned', async () => {
    await toRunning();
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip']), [operations[1]!]));
    await waitFor(() => app.currentView === 'result', 2000);
    expect(root.querySelector('[role="note"]')).toBeNull();
  });

  it('offers nothing to download when the run failed', async () => {
    await toRunning();
    pipeline.optimization.resolve(resultOf('failed', undefined, operations.slice(0, 1), { before: 0, after: 0, saved: 0, savedPercent: 0 }));
    await waitFor(() => app.currentView === 'result', 2000);
    expect($('.result-status').textContent).toBe('The optimization did not pass the final validation; no file is delivered.');
    expect(root.querySelector('.compare')).toBeNull();
    expect(root.querySelector('[data-testid="download"]')).toBeNull();
    expect(urls.created).toEqual([]);
    expect($$('.op-results li')).toHaveLength(1);
  });

  it('can be re-rendered in the other language without leaking URLs', async () => {
    await toRunning();
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip'])));
    await waitFor(() => app.currentView === 'result', 2000);
    $<HTMLButtonElement>('.link-button').click();
    expect($('.result-status').textContent).toBe('Proyecto optimizado.');
    expect($('.saved').textContent).toBe('Ahorro medido: 1,4 MB (50 %)');
    await settle();
    app.reset();
    expect(urls.revoked).toEqual(urls.created.map((_, i) => `blob:test/${i + 1}`));
  });
});
