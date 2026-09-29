import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { App, brokenReferences, type PipelineApi, type UrlApi } from '../../src/web/app.js';
import { translate } from '../../src/web/i18n.js';
import { icon, type IconName } from '../../src/web/icons.js';
import type { EngineStatus } from '../../src/adapters/browser/protocol.js';
import type { OptimizeResult } from '../../src/adapters/browser/pipeline-client.js';
import type { ThreadingPreference } from '../../src/adapters/browser/ffmpeg-loader.js';
import type { AnalysisResult, InventoryEntry, ReferenceRecord } from '../../src/core/analyze/model.js';
import type { Diagnostic } from '../../src/core/diagnostics.js';
import type { ProgressEvent } from '../../src/core/media/engine.js';
import type { OptionsInput } from '../../src/core/plan/options.js';
import type { OptimizationPlan, PlanOperation } from '../../src/core/plan/plan.js';
import type { OperationResult, OptimizationReport } from '../../src/core/report/report.js';
import { TOOL_VERSION } from '../../src/core/version.js';
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

/** A broken explicit reference in content.xml, with defaults. */
function reference(id: number, extra: Partial<ReferenceRecord> = {}): ReferenceRecord {
  return {
    id,
    value: `{{context_path}}/content/resources/r${id}.jpg`,
    form: 'context-path',
    status: 'missing',
    kind: 'explicit',
    representation: 'editable',
    location: { entry: 'content.xml' },
    via: [],
    rewritable: true,
    ...extra,
  };
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
  entry('content/resources/docs/guia.pdf', 'document', {
    size: 30_000,
    usage: 'not-applicable',
    pdf: { pages: 12, encrypted: false, signed: true, pdfA1: true, linearized: false },
  }),
  entry('content/resources/audio/voz.mp3', 'audio', {
    size: 3000,
    audio: { codec: 'mp3', channels: 2, sampleRate: 44_100, bitRate: 128_000, duration: 125 },
  }),
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
      legacyFolders: { folders: 0, files: 0 },
    },
    totals: { entries: 11, files: 11, uncompressedBytes: 2_200_000, userAssetBytes: 2_100_000, imageBytes: 60_000, videoBytes: 2_012_000, audioBytes: 0 },
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

/** A project in eXeLearning 3 folders with broken references. */
function legacyAnalysis(): AnalysisResult {
  const base = analysisResult();
  return analysisResult({
    package: { ...base.package!, legacyFolders: { folders: 2, files: 5 } },
    references: [
      reference(1),
      reference(2, { status: 'unmapped', representation: 'published' }),
      reference(3, { status: 'resolved', target: 'content/resources/fotos/foto.jpg' }),
    ],
    diagnostics: [diag('legacy-resource-folders', 'info', { message: '5 files in eXeLearning 3 folders' })],
  });
}

/** A plan operation of each kind the first plans used. */
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

/** The operations added by the flatten and broken-reference options. */
const RESTRUCTURE_OPS = [
  {
    id: 'm',
    op: 'move-resource',
    path: 'content/resources/20240101120000AAAAAA/foto.jpg',
    to: 'content/resources/foto_2.jpg',
    size: 1000,
    references: 5,
  },
  {
    id: 'x',
    op: 'remove-missing-reference',
    path: 'content/resources/borrada.jpg',
    references: 3,
    actions: { element: 3, attribute: 0, value: 0 },
    entries: ['content.xml'],
  },
  { id: 'n', op: 'rename-resource', path: 'content/resources/fotos/Copia de Foto (2).JPG', to: 'content/resources/fotos/foto.jpg', size: 1000, references: 2 },
  { id: 'u', op: 'update-manifest', path: 'libs/elpx-manifest.js', reason: 'file list changed' },
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

/** Text of an element with whitespace collapsed (the inline SVG icons add some). */
function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Lets pending promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

/** Button inside the app by its visible text. */
function button(label: string): HTMLButtonElement {
  const b = $$<HTMLButtonElement>('button').find((x) => text(x) === label);
  if (!b)
    throw new Error(
      `no button "${label}" in ${$$('button')
        .map((x) => text(x))
        .join(', ')}`,
    );
  return b;
}

/** The language button of the header (it names the other language). */
function languageButton(): HTMLButtonElement {
  const b = $$<HTMLButtonElement>('header button').find((x) => ['English', 'Español'].includes(text(x)));
  if (!b) throw new Error('no language button');
  return b;
}

/** Inventory row names in display order. */
function rowNames(): string[] {
  return $$('.inventory tbody th').map((x) => text(x));
}

/** The stepper as "label:state" items. */
function stepper(): string[] {
  return $$('.stepper-nav .stepper-item').map((li) => {
    const state = li.classList.contains('is-current') ? 'current' : li.classList.contains('is-done') ? 'done' : 'todo';
    return `${li.querySelector('.stepper-label')!.textContent}:${state}`;
  });
}

/** The plan groups as [title, count, open, items]. */
function planGroups(): [string, string, boolean, string[]][] {
  return $$<HTMLDetailsElement>('.plan-ops details.plan-group').map((d) => [
    d.querySelector('.op-kind')!.textContent!,
    d.querySelector('.badge')!.textContent!,
    d.open,
    [...d.querySelectorAll('li')].map((li) => text(li)),
  ]);
}

/** The risk notes shown with the plan. */
function riskNotes(): string[] {
  return $$('.risks li.note').map((li) => li.textContent!);
}

/** The per-resource results as [text without detail, detail]. */
function opResults(): [string, string][] {
  return $$('.op-results li').map((li) => {
    const parts = [...li.children[1]!.childNodes];
    const detail = parts.find((n) => n instanceof Element && n.classList.contains('op-detail'));
    return [
      parts
        .filter((n) => n !== detail)
        .map((n) => n.textContent)
        .join(''),
      detail?.textContent ?? '',
    ];
  });
}

/** Drives the app to the review step. */
async function toReview(result = analysisResult()): Promise<void> {
  void app.start(new File(['PK'], 'curso.elpx'));
  pipeline.analysis.resolve(result);
  await waitFor(() => app.currentView === 'review', 2000, 'review');
}

/** Drives the app to the plan step with the given plan. */
async function toPlan(plan = planOf(), result = analysisResult()): Promise<void> {
  await toReview(result);
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

/** Drives the app to the result step with the given result. */
async function toResult(result: OptimizeResult): Promise<void> {
  await toRunning();
  pipeline.optimization.resolve(result);
  await waitFor(() => app.currentView === 'result', 2000, 'result');
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
  it('renders the header, the hero with the picker and the footer in the chosen language', () => {
    expect(document.documentElement.lang).toBe('en');
    expect(document.title).toBe('eXeLearning project optimizer');
    expect($('header.navbar h1').textContent).toBe('eXeLearning project optimizer');
    expect($('#h-step1').textContent).toBe('Make your eXeLearning project lighter');
    expect($('.hero-lead').textContent).toMatch(/^Recompress videos, images and audio/);
    expect($('[data-testid="dropzone"]')).toBeTruthy();
    expect($$('.features li strong').map((s) => s.textContent)).toEqual(['Private', 'Lighter', 'Still editable']);
    expect($('.app-footer').textContent).toMatch(/AGPL-3.0/);
    expect($('[role="status"]').getAttribute('aria-live')).toBe('polite');
    expect(app.currentView).toBe('start');
  });

  it('links the footer to the ATE and the source code in new tabs', () => {
    const ate = $<HTMLAnchorElement>('.app-footer a.ate-link');
    expect(ate.getAttribute('href')).toBe('https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/');
    expect(ate.getAttribute('target')).toBe('_blank');
    expect(ate.getAttribute('rel')).toBe('noopener noreferrer');
    expect(ate.getAttribute('aria-label')).toBe('Educational Technology Area of the Government of the Canary Islands (opens in a new tab)');
    expect(ate.textContent).toBe('Made by the Educational Technology Area of the Government of the Canary Islands');
    const logo = ate.querySelector('img')!;
    expect(logo.getAttribute('alt')).toBe('');
    expect(logo.getAttribute('src')).toMatch(/ate-logo.*\.png|^data:image\/png/);
    const github = $<HTMLAnchorElement>('.app-footer a.github-link');
    expect(github.getAttribute('href')).toBe('https://github.com/ateeducacion/elpx-optimizer');
    expect(github.getAttribute('target')).toBe('_blank');
    expect(github.getAttribute('rel')).toBe('noopener noreferrer');
    expect(github.getAttribute('aria-label')).toBe('Source code on GitHub (opens in a new tab)');
    expect(text(github)).toBe('Source code');
    expect(github.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
    const version = $<HTMLAnchorElement>('.app-footer a.version-link');
    expect(version.textContent).toBe(`v${TOOL_VERSION}`);
    expect(version.getAttribute('href')).toBe(`https://github.com/ateeducacion/elpx-optimizer/releases/tag/v${TOOL_VERSION}`);
    expect(version.getAttribute('target')).toBe('_blank');
    expect(version.getAttribute('aria-label')).toBe(`Version ${TOOL_VERSION}: release notes (opens in a new tab)`);
    languageButton().click();
    expect($('.app-footer a.ate-link').textContent).toBe('Hecho por el Área de Tecnología Educativa del Gobierno de Canarias');
    expect($('.app-footer a.ate-link').getAttribute('aria-label')).toBe('Área de Tecnología Educativa del Gobierno de Canarias (se abre en otra pestaña)');
    expect(text($('.app-footer a.github-link'))).toBe('Código fuente');
    expect($('.app-footer a.github-link').getAttribute('aria-label')).toBe('Código fuente en GitHub (se abre en otra pestaña)');
  });

  it('switches between Spanish and English, keeping the current step', async () => {
    await toReview();
    const toggle = languageButton();
    expect(toggle.getAttribute('aria-label')).toBe('Switch language to Spanish');
    expect(text(toggle)).toBe('Español');
    toggle.click();
    expect(document.documentElement.lang).toBe('es');
    expect($('h1').textContent).toBe('Optimizador de proyectos eXeLearning');
    expect($('#h-step2').textContent).toBe('Revisa el contenido');
    expect($('#h-step3').textContent).toBe('Elige cómo optimizar');
    expect(stepper()).toEqual(['Proyecto:done', 'Opciones:current', 'Plan:todo', 'Resultado:todo']);
    expect($('.stepper-nav').getAttribute('aria-label')).toBe('Pasos');
    expect(app.currentView).toBe('review');
    expect(languageButton().getAttribute('aria-label')).toBe('Cambiar idioma a inglés');
    languageButton().click();
    expect($('#h-step2').textContent).toBe('Review the contents');
  });

  it('shows the video engine status', () => {
    const line = $('.engine-line');
    expect(line.textContent).toBe('Video engine: loaded when needed.');
    expect(line.dataset['state']).toBe('idle');
    expect(line.getAttribute('aria-live')).toBe('polite');
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

describe('stepper', () => {
  it('marks the current step of every view, with the finished ones checked', async () => {
    const nav = $('nav.stepper-nav');
    expect(nav.getAttribute('aria-label')).toBe('Steps');
    expect($$('.stepper > li')).toHaveLength(4);
    const current = (): string[] => $$('.stepper-item[aria-current="step"]').map((li) => li.querySelector('.stepper-label')!.textContent!);
    const dots = (): (string | null)[] => $$('.stepper-dot').map((d) => (d.querySelector('svg') ? 'check' : d.textContent));
    // start
    expect(stepper()).toEqual(['Project:current', 'Options:todo', 'Plan:todo', 'Result:todo']);
    expect(current()).toEqual(['Project']);
    expect(dots()).toEqual(['1', '2', '3', '4']);
    expect($('.stepper-dot').getAttribute('aria-hidden')).toBe('true');
    // analyzing
    void app.start(new File(['PK'], 'curso.elpx'));
    expect(app.currentView).toBe('analyzing');
    expect(stepper()).toEqual(['Project:current', 'Options:todo', 'Plan:todo', 'Result:todo']);
    // review
    pipeline.analysis.resolve(analysisResult());
    await waitFor(() => app.currentView === 'review', 2000);
    expect(stepper()).toEqual(['Project:done', 'Options:current', 'Plan:todo', 'Result:todo']);
    expect(dots()).toEqual(['check', '2', '3', '4']);
    // plan
    $<HTMLFormElement>('form.options').requestSubmit();
    pipeline.plans.resolve(planOf());
    await waitFor(() => app.currentView === 'plan', 2000);
    expect(stepper()).toEqual(['Project:done', 'Options:done', 'Plan:current', 'Result:todo']);
    expect(current()).toEqual(['Plan']);
    // running
    button('Optimize').click();
    expect(app.currentView).toBe('running');
    expect(stepper()).toEqual(['Project:done', 'Options:done', 'Plan:done', 'Result:current']);
    // result
    pipeline.optimization.resolve(resultOf('optimized', new Blob(['zip'])));
    await waitFor(() => app.currentView === 'result', 2000);
    expect(stepper()).toEqual(['Project:done', 'Options:done', 'Plan:done', 'Result:current']);
    expect(dots()).toEqual(['check', 'check', 'check', '4']);
    // back to the start
    button('Optimize another project').click();
    expect(stepper()).toEqual(['Project:current', 'Options:todo', 'Plan:todo', 'Result:todo']);
  });

  it('marks no step on the error view', async () => {
    void app.start(new File(['x'], 'a.elpx'));
    pipeline.analysis.reject(new Error('broken'));
    await waitFor(() => app.currentView === 'error', 2000);
    expect(stepper()).toEqual(['Project:todo', 'Options:todo', 'Plan:todo', 'Result:todo']);
    expect(root.querySelector('.stepper-item[aria-current]')).toBeNull();
  });
});

describe('file picker', () => {
  it('starts when a file is chosen, ignoring an empty choice', async () => {
    const input = $<HTMLInputElement>('#file-input');
    expect(input.accept).toBe('.elpx,.elp,.zip,application/zip');
    expect(input.classList.contains('visually-hidden')).toBe(true);
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
    const label = $('label[for="file-input"]');
    expect(label.classList.contains('btn')).toBe(true);
    expect(label.getAttribute('role')).toBe('button');
    expect(label.getAttribute('tabindex')).toBe('0');
    expect(label.textContent).toBe('Choose file…');
    for (const key of ['Enter', ' ', 'a', 'Tab']) label.dispatchEvent(new KeyboardEvent('keydown', { key, cancelable: true }));
    expect(click).toHaveBeenCalledTimes(2);
    const enter = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    label.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const other = new KeyboardEvent('keydown', { key: 'a', cancelable: true });
    label.dispatchEvent(other);
    expect(other.defaultPrevented).toBe(false);
  });
});

describe('analysis', () => {
  it('shows indeterminate and determinate progress while analyzing', async () => {
    void app.start(new File(['PK'], 'grande.elpx'));
    expect($('#h-step2').textContent).toBe('Analyzing the project');
    expect($('.step-step2 p').textContent).toBe('Analyzing grande.elpx…');
    const bar = (): HTMLElement => $('[data-role="progress"] .progress[role="progressbar"]');
    const fill = (): HTMLElement => $('[data-role="progress"] .progress-bar');
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    expect(bar().getAttribute('aria-busy')).toBe('true');
    expect(bar().getAttribute('aria-valuemin')).toBe('0');
    expect(bar().getAttribute('aria-valuemax')).toBe('100');
    expect(bar().getAttribute('aria-label')).toBe('Reading the project');
    expect(fill().className).toBe('progress-bar progress-bar-striped progress-bar-animated');
    expect(fill().style.width).toBe('100%');
    expect($('.progress-text').textContent).toBe('Reading the project');
    pipeline.analyzeProgress!({ stage: 'read', fraction: 0.25 });
    expect(bar().getAttribute('aria-valuenow')).toBe('25');
    expect(bar().hasAttribute('aria-busy')).toBe(false);
    expect(fill().className).toBe('progress-bar');
    expect(fill().style.width).toBe('25%');
    pipeline.analyzeProgress!({ stage: 'probe', resource: 'content/resources/v.mp4', item: 1, items: 3 });
    expect(bar().hasAttribute('aria-valuenow')).toBe(false);
    const probing = translate('en', 'stage_probe');
    expect(bar().getAttribute('aria-label')).toBe(probing);
    expect($('.progress-text').textContent).toBe(`${probing} — 1 of 3 content/resources/v.mp4`);
    expect($('.progress-text .resource-name').textContent).toBe(' content/resources/v.mp4');
    pipeline.analyzeProgress!({ stage: 'analyze', fraction: 1.4 });
    expect(bar().getAttribute('aria-valuenow')).toBe('100');
    expect(fill().style.width).toBe('100%');
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
    expect($$('.project-meta > *').map((x) => x.textContent)).toEqual(['Mi curso <b>', 'eXeLearning 4 format', '3 pages · 7 iDevices', '2.9 MB']);
    // The title is text, never markup.
    expect($('.project-meta b.project-title').children).toHaveLength(0);
    const legend = $$('.weight-legend li').map((li) => li.textContent);
    expect(legend).toEqual(['Video 1.9 MB', 'Images 58.6 KB', 'Everything else 125 KB']);
    expect($$('.weight-bar .seg')).toHaveLength(3);
    expect($('.weight-bar').getAttribute('aria-label')).toBe('Video 1.9 MB, Images 58.6 KB, Audio 0 B, Everything else 125 KB');
    expect($('.weight figcaption').textContent).toBe('What takes up space');
    // No eXeLearning 3 folders and no broken references: no alerts.
    expect(root.querySelector('[data-testid="legacy-alert"]')).toBeNull();
    expect(root.querySelector('[data-testid="broken-alert"]')).toBeNull();
    const problems = $<HTMLDetailsElement>('details.problems');
    expect(problems.open).toBe(true);
    expect($('details.problems summary strong').textContent).toBe('Issues');
    expect($('details.problems summary span').textContent).toBe('1 errors, 1 warnings, 3 notes');
    const items = $$('.diagnostics li').map((li) => [
      li.querySelector('.diag-code')!.textContent,
      li.childNodes[1]!.textContent,
      li.querySelector('.diag-where')?.textContent ?? '',
    ]);
    expect(items).toEqual([
      ['missing-resource', 'missing-resource message', 'Inicio › text › html › $.a'],
      ['lenient-resolution', 'lenient-resolution message', 'html/juego.html'],
      ['external-reference', 'external-reference message', ''],
      ['duplicate-content', 'duplicate-content message', ''],
    ]);
    expect($$('.diagnostics .diag-code').map((b) => b.className)).toEqual([
      'badge text-bg-danger me-2 diag-code',
      'badge text-bg-warning me-2 diag-code',
      'badge text-bg-info me-2 diag-code',
      'badge text-bg-info me-2 diag-code',
    ]);
    expect($('.inventory-card .card-header h3').textContent).toBe('Project resources');
    expect($('.inventory-card .card-header span').textContent).toBe('9 files');
    expect(rowNames()).toEqual([
      'media/clase.mp4',
      'fotos/foto.jpg',
      'docs/guia.pdf',
      'screenshot.png',
      'media/sin-probar.webm',
      'media/raro.mp4',
      'audio/voz.mp3',
      'fotos/anim.gif',
      'fotos/sin-info.png',
    ]);
    // Each row shows the icon of its kind.
    const kinds: IconName[] = ['camera-video', 'image', 'music-note-beamed', 'file-earmark-pdf', 'file-earmark'];
    const iconOf = (svg: Element): IconName | undefined => kinds.find((k) => icon(k).outerHTML === svg.outerHTML);
    expect($$('.inventory tbody th .kind-icon svg').map(iconOf)).toEqual([
      'camera-video',
      'image',
      'file-earmark-pdf',
      'image',
      'camera-video',
      'camera-video',
      'music-note-beamed',
      'image',
      'image',
    ]);
    const details = $$('.inventory tbody td.details').map((td) => td.textContent);
    expect(details).toEqual([
      'h264 640×360, 1:04, aac es, opus, mp3, 2 subt.',
      '800×600',
      '12 pages, signed, PDF/A-1',
      '300×200',
      'not inspected',
      '? ?×?, —',
      'mp3 stereo 44.1 kHz 128 kb/s, 2:05',
      '?×?, animated',
      '',
    ]);
    expect($$('.inventory .usage').map((u) => u.textContent)).toEqual([
      'in use',
      'in use',
      '—',
      'in use',
      'unreferenced',
      'uncertain',
      'in use',
      'protected',
      'in use',
    ]);
    expect($('.inventory .usage-unreferenced').classList.contains('bg-secondary-subtle')).toBe(true);
    expect($('.inventory .usage-uncertain').classList.contains('bg-warning-subtle')).toBe(true);
    // Images, videos, audio and PDFs can be excluded, with a switch each.
    const switches = $$<HTMLInputElement>('.inventory tbody input[type="checkbox"]');
    expect(switches).toHaveLength(9);
    expect(switches.map((x) => x.getAttribute('aria-label'))).toContain('Optimize content/resources/docs/guia.pdf');
    expect(switches.map((x) => x.getAttribute('aria-label'))).toContain('Optimize content/resources/audio/voz.mp3');
    expect(switches.every((s) => s.getAttribute('role') === 'switch' && s.checked)).toBe(true);
    expect($('.table-wrap').getAttribute('role')).toBe('region');
    expect($('.table-wrap').getAttribute('aria-label')).toBe('Project resources');
  });

  it('describes audio by codec, channels, sample rate, bit rate and duration', async () => {
    const audio = (name: string, summary: NonNullable<InventoryEntry['audio']>): InventoryEntry =>
      entry(`content/resources/audio/${name}`, 'audio', { size: 1000, audio: summary });
    await toReview(
      analysisResult({
        entries: [
          audio('a.wav', { codec: 'pcm_s16le', channels: 1, sampleRate: 22_050 }),
          audio('b.flac', { codec: 'flac', channels: 6, bitRate: 900_400, duration: 3725 }),
          audio('c.m4a', { codec: 'aac' }),
          audio('d.mp3', { codec: 'mp3', channels: 2, sampleRate: 48_000, duration: 5 }),
        ],
      }),
    );
    const detailsOf = (): Record<string, string> =>
      Object.fromEntries($$('.inventory tbody tr').map((tr) => [text(tr.querySelector('th')), tr.querySelector('td.details')!.textContent!]));
    expect(detailsOf()).toEqual({
      'audio/a.wav': 'pcm_s16le mono 22.05 kHz, —',
      'audio/b.flac': 'flac 6 ch 900 kb/s, 1:02:05',
      'audio/c.m4a': 'aac, —',
      'audio/d.mp3': 'mp3 stereo 48 kHz, 0:05',
    });
    languageButton().click();
    expect(detailsOf()['audio/a.wav']).toBe('pcm_s16le mono 22,05 kHz, —');
    expect(detailsOf()['audio/d.mp3']).toBe('mp3 estéreo 48 kHz, 0:05');
  });

  it('describes PDFs by pages and what protects them, each with its switch', async () => {
    const pdf = (name: string, info?: InventoryEntry['pdf']): InventoryEntry =>
      entry(`content/resources/docs/${name}`, 'document', { size: 1000, ...(info ? { pdf: info } : {}) });
    await toReview(
      analysisResult({
        entries: [
          pdf('a.pdf', { pages: 1, encrypted: false, signed: false, pdfA1: false, linearized: true }),
          pdf('b.pdf', { pages: 40, encrypted: true, signed: false, pdfA1: false, linearized: false }),
          pdf('c.pdf'),
        ],
      }),
    );
    const rows = (): [string, string, boolean][] =>
      $$('.inventory tbody tr').map((tr) => [
        text(tr.querySelector('th')),
        tr.querySelector('td.details')!.textContent!,
        tr.querySelector('input[type="checkbox"]') !== null,
      ]);
    expect(rows()).toEqual([
      ['docs/a.pdf', '1 page', true],
      ['docs/b.pdf', '40 pages, encrypted', true],
      ['docs/c.pdf', '', true],
    ]);
    languageButton().click();
    expect(rows().map((r) => r[1])).toEqual(['1 página', '40 páginas, cifrado', '']);
  });

  it('describes v3 projects without a title and projects without issues', async () => {
    await toReview(
      analysisResult({
        package: { ...analysisResult().package!, variant: 'v3', title: undefined },
        diagnostics: [],
        totals: { ...analysisResult().totals, uncompressedBytes: 0, videoBytes: 0, imageBytes: 0 },
      }),
    );
    expect($$('.project-meta > *').map((x) => x.textContent)).toEqual(['curso.elpx', 'eXeLearning 3.0 format', '3 pages · 7 iDevices', '2.9 MB']);
    expect($('details.problems summary span').textContent).toBe('No issues found.');
    expect($<HTMLDetailsElement>('details.problems').open).toBe(false);
    expect($$('.diagnostics li')).toHaveLength(0);
    expect($$('.weight-bar .seg')).toHaveLength(0);
  });

  it('lists at most 200 issues, with a neutral badge for unknown severities', async () => {
    const many = Array.from({ length: 250 }, (_, i) => diag(`w${i}`, 'warning'));
    await toReview(analysisResult({ diagnostics: [diag('odd', 'debug' as Diagnostic['severity']), ...many] }));
    expect($$('.diagnostics li')).toHaveLength(200);
    expect($('.diagnostics .diag-code').className).toBe('badge text-bg-secondary me-2 diag-code');
    expect($('details.problems summary span').textContent).toBe('0 errors, 250 warnings, 0 notes');
    expect($<HTMLDetailsElement>('details.problems').open).toBe(false);
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
    expect(rowNames()[0]).toBe('audio/voz.mp3');
    sortButton('File').click();
    expect(sortState()[0]).toBe('descending');
    expect(rowNames()[0]).toBe('screenshot.png');
    sortButton('Type').click();
    // By kind (audio, document, image, video), keeping the inventory order within a kind.
    expect($$('.inventory tbody td:first-of-type').map((td) => td.textContent)).toEqual(['mp3', 'pdf', 'jpg', 'gif', 'png', 'png', 'mp4', 'mp4', 'webm']);
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
    const alert = $('section.step-error.card[role="alert"]');
    expect(text(alert.querySelector('h2'))).toBe('Could not finish');
    expect(alert.querySelector('h2')!.classList.contains('text-danger')).toBe(true);
    expect(alert.textContent).toContain('Legacy eXeLearning 2.x project');
    expect($('.step-error .alert-info').textContent).toBe('Open the file in eXeLearning, save it as .elpx and try again.');
    expect(document.activeElement).toBe($('#h-error'));
    button('Start over').click();
    expect(app.currentView).toBe('start');
    expect(document.activeElement).toBe($('#h-step1'));
  });

  it('reports an unusable file without a fatal diagnostic generically', async () => {
    void app.start(new File(['x'], 'raro.elpx'));
    pipeline.analysis.resolve(analysisResult({ ok: false, diagnostics: [diag('zip-case-collision', 'warning')] }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect($('[role="alert"] p').textContent).toBe('This file cannot be optimized reliably.');
    expect($('[role="alert"]').textContent).not.toContain('eXeLearning, save it');
    expect(root.querySelector('.step-error .alert-info')).toBeNull();
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

describe('eXeLearning 3 folders and broken references', () => {
  it('warns about both and offers the matching clean-ups', async () => {
    await toReview(legacyAnalysis());
    const legacy = $('[data-testid="legacy-alert"]');
    expect(legacy.classList.contains('alert-info')).toBe(true);
    expect(legacy.querySelector('strong')!.textContent).toBe('eXeLearning 3 folders');
    expect(legacy.textContent).toContain('5 files are in 2 folders named by eXeLearning 3 (content/resources/<ID>/).');
    expect(legacy.getAttribute('role')).toBeNull();
    const broken = $('[data-testid="broken-alert"]');
    expect(broken.classList.contains('alert-warning')).toBe(true);
    expect(broken.querySelector('strong')!.textContent).toBe('References to files that do not exist');
    // The resolved reference is not counted.
    expect(broken.textContent).toContain('There are 2 references to files missing from the project.');
    // The alerts come after the weight and before the issues.
    expect(legacy.previousElementSibling).toBe($('.weight'));
    expect(broken.nextElementSibling).toBe($('details.problems'));
    // The legacy diagnostic is listed even though it is only informative.
    expect($$('.diagnostics .diag-code').map((b) => b.textContent)).toEqual(['legacy-resource-folders']);

    const form = $<HTMLFormElement>('form.options');
    const flatten = $<HTMLInputElement>('form.options input[name="flatten"]');
    const missing = $<HTMLInputElement>('form.options input[name="missingReferences"]');
    for (const s of [flatten, missing]) {
      expect(s.getAttribute('role')).toBe('switch');
      expect(s.checked).toBe(false);
      expect(s.closest('.form-check')!.classList.contains('form-switch')).toBe(true);
    }
    expect($('label[for="opt-flatten"]').textContent).toBe('Flatten eXeLearning 3 folders');
    expect(flatten.parentElement!.querySelector('.form-text')!.textContent).toMatch(/^Moves 5 files to content\/resources\//);
    expect($('label[for="opt-missingReferences"]').textContent).toBe('Remove broken references');
    expect(missing.parentElement!.querySelector('.form-text')!.textContent).toMatch(/^2 references to files that do not exist/);
    expect(app.readOptions(form)).toMatchObject({ flatten: 'off', missingReferences: 'keep' });
    flatten.checked = true;
    expect(app.readOptions(form)).toMatchObject({ flatten: 'legacy', missingReferences: 'keep' });
    missing.checked = true;
    expect(app.readOptions(form)).toMatchObject({ flatten: 'legacy', missingReferences: 'remove' });
    flatten.checked = false;
    expect(app.readOptions(form)).toMatchObject({ flatten: 'off', missingReferences: 'remove' });

    // The choices reach the planner and survive a return from the plan.
    flatten.checked = true;
    form.requestSubmit();
    expect(pipeline.planCalls[0]).toMatchObject({ flatten: 'legacy', missingReferences: 'remove' });
    pipeline.plans.resolve(planOf({ operations: RESTRUCTURE_OPS }));
    await waitFor(() => app.currentView === 'plan', 2000);
    button('Change options').click();
    expect($<HTMLInputElement>('form.options input[name="flatten"]').checked).toBe(true);
    expect($<HTMLInputElement>('form.options input[name="missingReferences"]').checked).toBe(true);
    // Both texts follow the interface language.
    languageButton().click();
    expect($('[data-testid="legacy-alert"] strong').textContent).toBe('Carpetas de eXeLearning 3');
    expect($('[data-testid="broken-alert"]').textContent).toContain('Hay 2 referencias a archivos que faltan en el proyecto.');
    expect($('label[for="opt-flatten"]').textContent).toBe('Aplanar carpetas de eXeLearning 3');
    expect($('label[for="opt-missingReferences"]').textContent).toBe('Quitar referencias rotas');
  });

  it('shows only the alert and switch that apply', async () => {
    const base = legacyAnalysis();
    await toReview({ ...base, references: [] });
    expect(root.querySelector('[data-testid="legacy-alert"]')).not.toBeNull();
    expect(root.querySelector('[data-testid="broken-alert"]')).toBeNull();
    expect(root.querySelector('form.options [name="flatten"]')).not.toBeNull();
    expect(root.querySelector('form.options [name="missingReferences"]')).toBeNull();
    app.reset();
    pipeline.analysis = deferred();
    await toReview({ ...base, package: { ...base.package!, legacyFolders: { folders: 0, files: 0 } } });
    expect(root.querySelector('[data-testid="legacy-alert"]')).toBeNull();
    expect($('[data-testid="broken-alert"]').textContent).toContain('There are 2 references');
    expect(root.querySelector('form.options [name="flatten"]')).toBeNull();
    expect(root.querySelector('form.options [name="missingReferences"]')).not.toBeNull();
  });
});

describe('brokenReferences', () => {
  it('keeps the explicit missing references of the project documents only', () => {
    const refs = [
      reference(1),
      reference(2, { status: 'unmapped', representation: 'published' }),
      reference(3, { status: 'unresolvable', form: 'local-file', representation: 'search-index' }),
      reference(4, { status: 'unresolvable', form: 'absolute-url' }),
      reference(5, { status: 'resolved', target: 'content/resources/r5.jpg' }),
      reference(6, { status: 'external', form: 'absolute-url' }),
      reference(7, { status: 'ambiguous' }),
      reference(8, { status: 'ignored', form: 'fragment' }),
      reference(9, { kind: 'dynamic' }),
      reference(10, { representation: 'resource' }),
      reference(11, { representation: 'runtime' }),
    ];
    expect(brokenReferences(refs).map((r) => r.id)).toEqual([1, 2, 3]);
    expect(brokenReferences([])).toEqual([]);
  });
});

describe('options', () => {
  it('maps every advanced field and the excluded resources to OptionsInput', async () => {
    await toReview();
    const form = $<HTMLFormElement>('form.options');
    expect(form.closest('aside.options-card')).not.toBeNull();
    expect($('aside.options-card #h-step3').textContent).toBe('Choose how to optimize');
    const field = <T extends HTMLElement>(name: string): T => form.querySelector<T>(`[name="${name}"]`)!;
    const input = (name: string): HTMLInputElement => field<HTMLInputElement>(name);
    // Defaults (balanced preset, empty numbers, the preset's resolution).
    expect(form.querySelector<HTMLInputElement>('input[name="preset"]:checked')!.value).toBe('balanced');
    expect(field<HTMLSelectElement>('maxResolution').value).toBe('profile');
    expect(input('removeUnused').getAttribute('role')).toBe('switch');
    expect(input('deduplicate').getAttribute('role')).toBe('switch');
    expect(input('video').hasAttribute('role')).toBe(false);
    expect(input('audio').checked).toBe(true);
    expect($('label[for="opt-audio"]').textContent).toBe('Recompress audio (WAV, AIFF and FLAC become MP3)');
    // Levels, with the aggressive one shown as the maximum.
    expect($$('.preset-group strong').map((x) => x.textContent)).toEqual(['Conservative', 'Balanced', 'Maximum']);
    // The image size is chosen next to the level, outside the advanced options.
    const size = field<HTMLSelectElement>('imageSize');
    expect(size.id).toBe('opt-imageSize');
    expect(size.closest('details')).toBeNull();
    expect($('label[for="opt-imageSize"]').textContent).toBe('Maximum image size');
    expect([...size.options].map((o) => [o.value, o.textContent])).toEqual([
      ['profile', 'From the level'],
      ['1280', '1280 px'],
      ['1600', '1600 px'],
      ['1920', '1920 px'],
      ['2560', '2560 px'],
      ['none', 'No limit'],
    ]);
    expect(size.value).toBe('profile');
    expect(form.querySelector('[name="maxDimension"]')).toBeNull();
    expect($('form.options .note').textContent).toMatch(/videos, photos, audio and the images inside PDFs/);
    expect(input('pdf').checked).toBe(true);
    expect(input('pdfLossless').checked).toBe(false);
    expect($('label[for="opt-pdf"]').textContent).toBe('Optimize PDFs (signed or encrypted ones are not touched)');
    expect($('label[for="opt-pdfLossless"]').textContent).toBe('PDFs lossless only (do not convert their images to JPEG)');
    // Clean file names are on by default in the web app.
    expect(input('normalizeNames').checked).toBe(true);
    expect(input('normalizeNames').getAttribute('role')).toBe('switch');
    expect(app.readOptions(form)).toEqual({
      preset: 'balanced',
      video: { enabled: true },
      images: { enabled: true, png: true, stripMetadata: false, includeScreenshot: false },
      audio: { enabled: true },
      pdf: { enabled: true },
      removeUnused: 'off',
      deduplicate: 'off',
      flatten: 'off',
      missingReferences: 'keep',
      normalizeNames: 'slug',
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
    size.value = '1920';
    input('png').checked = false;
    input('stripMetadata').checked = true;
    input('includeScreenshot').checked = true;
    input('multithread').checked = false;
    input('removeUnused').checked = true;
    input('deduplicate').checked = true;
    input('audio').checked = false;
    input('audioFilesBitrate').value = '96';
    input('normalizeNames').checked = false;
    input('pdf').checked = false;
    input('pdfLossless').checked = true;
    const boxes = $$<HTMLInputElement>('.inventory tbody input[type="checkbox"]');
    expect(boxes[0]!.getAttribute('aria-label')).toBe('Optimize content/resources/media/clase.mp4');
    boxes[0]!.click();
    boxes[2]!.click();
    boxes[2]!.click(); // re-enabled
    expect(app.readOptions(form)).toEqual({
      preset: 'aggressive',
      video: { enabled: false, maxResolution: '720', crf: 26, audioBitrate: 96 },
      images: { enabled: false, png: false, stripMetadata: true, includeScreenshot: true, jpegQuality: 70, webpQuality: 75, maxDimension: 1920 },
      audio: { enabled: false, bitrate: 96 },
      pdf: { enabled: false, images: false },
      removeUnused: 'safe',
      deduplicate: 'exact',
      flatten: 'off',
      missingReferences: 'keep',
      normalizeNames: 'off',
      exclude: ['content/resources/media/clase.mp4'],
    });
    field<HTMLSelectElement>('maxResolution').value = 'original';
    expect(app.readOptions(form).video).toMatchObject({ maxResolution: 'original' });
    // No limit is an explicit null; the level's size leaves the key out.
    size.value = 'none';
    expect(app.readOptions(form).images).toMatchObject({ maxDimension: null });
    size.value = 'profile';
    expect(app.readOptions(form).images).not.toHaveProperty('maxDimension');
  });

  it('falls back to defaults for a form without fields', () => {
    expect(app.readOptions(document.createElement('form'))).toEqual({
      preset: 'balanced',
      video: { enabled: false },
      images: { enabled: false, png: false, stripMetadata: false, includeScreenshot: false },
      audio: { enabled: false },
      pdf: { enabled: false },
      removeUnused: 'off',
      deduplicate: 'off',
      flatten: 'off',
      missingReferences: 'keep',
      normalizeNames: 'off',
      exclude: [],
    });
  });

  it('explains what the clean-ups would take out', async () => {
    await toReview();
    const help = (name: string): string | null | undefined => $(`form.options input[name="${name}"]`).parentElement!.querySelector('.form-text')?.textContent;
    expect(help('removeUnused')).toBe('1 file (6.8 KB) that nothing uses.');
    expect(help('deduplicate')).toBeUndefined();
    const group = (id: number): AnalysisResult['duplicates'][number] => ({
      id,
      sha256: String(id),
      size: 10,
      format: 'jpg',
      paths: [`content/resources/a${id}.jpg`, `content/resources/b${id}.jpg`],
    });
    const again = async (extra: Partial<AnalysisResult>): Promise<void> => {
      app.reset();
      pipeline.analysis = deferred();
      await toReview(analysisResult(extra));
    };
    await again({ entries: ENTRIES.filter((e) => e.usage !== 'unreferenced'), duplicates: [group(1)] });
    expect(help('removeUnused')).toBeUndefined();
    expect(help('deduplicate')).toBe('1 group of identical files.');
    await again({
      entries: ENTRIES.map((e) => (e.role === 'user-asset' && e.kind === 'image' ? { ...e, usage: 'unreferenced' as const } : e)),
      duplicates: [group(1), group(2)],
    });
    expect(help('removeUnused')).toBe('4 files (53.1 KB) that nothing uses.');
    expect(help('deduplicate')).toBe('2 groups of identical files.');
  });

  it('says how many file names would be cleaned, with an example', async () => {
    const help = (): string => $('form.options input[name="normalizeNames"]').parentElement!.querySelector('.form-text')!.textContent!;
    await toReview();
    expect($('label[for="opt-normalizeNames"]').textContent).toBe('Clean file names');
    expect(help()).toBe('The names are already clean.');
    const again = async (entries: InventoryEntry[]): Promise<void> => {
      app.reset();
      pipeline.analysis = deferred();
      await toReview(analysisResult({ entries }));
    };
    await again([
      entry('content/resources/fotos/Copia de Foto (2).JPG', 'image'),
      entry('content/resources/Mi Vídeo.mp4', 'video'),
      entry('content/resources/limpio.png', 'image'),
      // Not counted: the style's own files, folders and package files.
      entry('custom/Mi Tema.css', 'text'),
      entry('content/resources/Carpeta Nueva/', 'unknown', { isDirectory: true }),
      entry('Otra Cosa.xml', 'text', { role: 'package' }),
    ]);
    expect(help()).toBe('2 files will get a clean name: lower case, no spaces, accents, “Copy of” or “(2)”. For example, Copia de Foto (2).JPG → foto.jpg.');
    await again([entry('content/resources/Mi Vídeo.mp4', 'video'), entry('content/resources/limpio.png', 'image')]);
    expect(help()).toBe('1 file will get a clean name: Mi Vídeo.mp4 → mi-video.mp4.');
    languageButton().click();
    expect($('label[for="opt-normalizeNames"]').textContent).toBe('Limpiar nombres de archivo');
    expect(help()).toBe('1 archivo tendrá un nombre limpio: Mi Vídeo.mp4 → mi-video.mp4.');
  });

  it('keeps the chosen options and exclusions when returning from the plan', async () => {
    await toReview();
    const form = $<HTMLFormElement>('form.options');
    form.querySelector<HTMLInputElement>('input[name="preset"][value="conservative"]')!.checked = true;
    form.querySelector<HTMLSelectElement>('[name="maxResolution"]')!.value = '1080';
    form.querySelector<HTMLInputElement>('[name="crf"]')!.value = '20';
    form.querySelector<HTMLSelectElement>('[name="imageSize"]')!.value = 'none';
    form.querySelector<HTMLInputElement>('[name="normalizeNames"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="multithread"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="video"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="removeUnused"]')!.checked = true;
    form.querySelector<HTMLInputElement>('[name="audio"]')!.checked = false;
    form.querySelector<HTMLInputElement>('[name="audioFilesBitrate"]')!.value = '160';
    $$<HTMLInputElement>('.inventory tbody input[type="checkbox"]')[0]!.click();
    form.requestSubmit();
    expect(pipeline.planCalls[0]).toMatchObject({ preset: 'conservative', exclude: ['content/resources/media/clase.mp4'] });
    pipeline.plans.resolve(planOf());
    await waitFor(() => app.currentView === 'plan', 2000);
    button('Change options').click();
    expect(app.currentView).toBe('review');
    expect(document.activeElement).toBe($('#h-step2'));
    const again = $<HTMLFormElement>('form.options');
    expect(again.querySelector<HTMLInputElement>('input[name="preset"]:checked')!.value).toBe('conservative');
    expect(again.querySelector<HTMLSelectElement>('[name="maxResolution"]')!.value).toBe('1080');
    expect(again.querySelector<HTMLInputElement>('[name="crf"]')!.value).toBe('20');
    expect(again.querySelector<HTMLSelectElement>('[name="imageSize"]')!.value).toBe('none');
    expect(again.querySelector<HTMLInputElement>('[name="normalizeNames"]')!.checked).toBe(false);
    // A size in pixels is kept as well.
    again.querySelector<HTMLSelectElement>('[name="imageSize"]')!.value = '2560';
    again.requestSubmit();
    expect(pipeline.planCalls[1]!.images).toMatchObject({ maxDimension: 2560 });
    await waitFor(() => app.currentView === 'plan', 2000);
    button('Change options').click();
    expect($<HTMLSelectElement>('form.options [name="imageSize"]').value).toBe('2560');
    expect(again.querySelector<HTMLInputElement>('[name="multithread"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="video"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="removeUnused"]')!.checked).toBe(true);
    expect(again.querySelector<HTMLInputElement>('[name="deduplicate"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="audio"]')!.checked).toBe(false);
    expect(again.querySelector<HTMLInputElement>('[name="audioFilesBitrate"]')!.value).toBe('160');
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
    expect(text($('[role="alert"] h2'))).toBe('Could not finish');
  });
});

describe('plan', () => {
  const LOSSY = 'Re-encoding videos, audio and photos changes their quality; when a result is not valid or not smaller, the original is kept.';
  const DOWNSCALE = 'Some videos or images will be downscaled.';
  const AUDIO_RENAME = 'WAV, AIFF and FLAC become MP3 with the .mp3 extension; their references are updated.';
  const PDF_IMAGES = 'In PDFs, images that are not JPEG may become JPEG when that makes them smaller; text, fonts, links and forms are not touched.';
  const pdfOp = (id: string, lossy: boolean): PlanOperation =>
    ({
      id,
      op: 'optimize-pdf',
      path: `content/resources/docs/${id}`,
      size: 2_000_000,
      lossy,
      conversions: lossy ? ['streams recompressed', 'images to JPEG'] : ['streams recompressed'],
      job: {},
    }) as unknown as PlanOperation;
  const audioOp = (id: string, to?: string): PlanOperation =>
    ({
      id,
      op: 'transcode-audio',
      path: `content/resources/audio/${id}`,
      size: 500_000,
      lossy: true,
      conversions: ['MP3 128 kb/s'],
      job: {},
      ...(to ? { to: `content/resources/audio/${to}` } : {}),
    }) as unknown as PlanOperation;

  it('groups the operations, lists the skipped resources, the estimate and localized risk notes', async () => {
    await toPlan();
    expect(document.activeElement).toBe($('#h-step4'));
    expect($('#h-step4').textContent).toBe('Confirm the plan');
    expect($('.step-step4 h3').textContent).toBe('Will do');
    expect(planGroups()).toEqual([
      ['Videos to recompress', '1', true, ['media/clase.mp4 (1.9 MB): video: h264 → h264; audio kept']],
      ['Images to recompress', '1', true, ['fotos/foto.jpg (43.9 KB): JPEG q82']],
      ['Unused files to remove', '1', true, ['sin-uso/viejo.webp (21.5 KB)']],
      ['Identical copies to merge', '1', true, ['b.jpg, c.jpg: merged with a.jpg']],
      ['Documents with updated references', '1', true, ['content.xml']],
    ]);
    expect($('.estimate').textContent).toBe('Estimate before processing (not measured): about 1.1 MB less.');
    expect($('details.skipped summary').textContent).toBe('Left as is (1)');
    expect($('ul.plan-skipped li').textContent).toBe('media/raro.mp4: Duration is unknown');
    // The notes come from the operations, not from the (English) risks of the plan.
    expect($('.risks').getAttribute('role')).toBe('note');
    expect($('.risks strong').textContent).toBe('Keep in mind');
    expect(riskNotes()).toEqual([
      LOSSY,
      'Files nothing uses will be removed; only files with no reference of any kind are selected.',
      'Identical copies will be merged and their references updated.',
    ]);
    expect($('.step-step4').textContent).not.toContain('Lossy video re-encoding');
    const optimize = button('Optimize');
    expect(optimize.disabled).toBe(false);
    expect(optimize.classList.contains('btn-primary')).toBe(true);
    languageButton().click();
    expect(riskNotes()[0]).toBe('Recodificar vídeos, audio y fotos cambia su calidad; si un resultado no es válido o no ocupa menos, se conserva el original.');
    expect(planGroups()[3]![3]).toEqual(['b.jpg, c.jpg: se unifica con a.jpg']);
  });

  it('shows every kind of operation in a fixed order with its icon', async () => {
    const audio = [audioOp('voz.wav', 'voz.mp3'), audioOp('musica.mp3')];
    await toPlan(planOf({ operations: [...RESTRUCTURE_OPS, pdfOp('guia.pdf', true), ...audio, ...OPS].reverse(), skipped: [] }), legacyAnalysis());
    expect(planGroups()).toEqual([
      ['Videos to recompress', '1', true, ['media/clase.mp4 (1.9 MB): video: h264 → h264; audio kept']],
      ['Images to recompress', '1', true, ['fotos/foto.jpg (43.9 KB): JPEG q82']],
      // Converted files show their new name.
      ['Audio to recompress', '2', true, ['audio/musica.mp3 (488 KB): MP3 128 kb/s', 'audio/voz.wav → audio/voz.mp3 (488 KB): MP3 128 kb/s']],
      ['PDFs to optimize', '1', true, ['docs/guia.pdf (1.9 MB): streams recompressed; images to JPEG']],
      ['Unused files to remove', '1', true, ['sin-uso/viejo.webp (21.5 KB)']],
      ['Identical copies to merge', '1', true, ['b.jpg, c.jpg: merged with a.jpg']],
      ['Files to move', '1', true, ['content/resources/20240101120000AAAAAA/foto.jpg → content/resources/foto_2.jpg']],
      ['Files with a clean name', '1', true, ['fotos/Copia de Foto (2).JPG → fotos/foto.jpg']],
      ['Missing files whose references are removed', '1', true, ['borrada.jpg: 3 references']],
      ['Documents with updated references', '1', true, ['content.xml']],
      ['Download manifest', '1', true, ['libs/elpx-manifest.js']],
    ]);
    const icons: IconName[] = [
      'camera-video',
      'image',
      'music-note-beamed',
      'file-earmark-pdf',
      'trash3',
      'files',
      'folder-symlink',
      'pencil-square',
      'eraser',
      'pencil-square',
      'file-earmark',
    ];
    expect($$('.plan-group .op-icon svg').map((svg) => svg.outerHTML)).toEqual(icons.map((n) => icon(n).outerHTML));
    expect($$('.plan-group li').map((li) => li.className)).toEqual([
      'op op-transcode-video',
      'op op-recompress-image',
      'op op-transcode-audio',
      'op op-transcode-audio',
      'op op-optimize-pdf',
      'op op-remove-unused',
      'op op-deduplicate',
      'op op-move-resource',
      'op op-rename-resource',
      'op op-remove-missing-reference',
      'op op-rewrite-references',
      'op op-update-manifest',
    ]);
    expect(riskNotes()).toEqual([
      LOSSY,
      AUDIO_RENAME,
      PDF_IMAGES,
      'Files nothing uses will be removed; only files with no reference of any kind are selected.',
      'Identical copies will be merged and their references updated.',
      'Files in eXeLearning 3 folders will be moved to content/resources/ and their references updated.',
      'Some files get a clean name; all their references are updated.',
      'References to files that do not exist will be removed: broken images and players are deleted, and links keep their text.',
    ]);
    expect(root.querySelector('details.skipped')).toBeNull();
  });

  const image = (id: string, lossy: boolean, resize?: { width: number; height: number }): PlanOperation =>
    ({ id, op: 'recompress-image', path: `content/resources/${id}.png`, size: 10, lossy, conversions: [], job: { resize } }) as unknown as PlanOperation;
  const video = (id: string, scale?: { width: number; height: number }): PlanOperation =>
    ({ id, op: 'transcode-video', path: `content/resources/${id}.mp4`, size: 10, lossy: true, conversions: [], job: { scale } }) as unknown as PlanOperation;

  it.each<[string, PlanOperation[], string[]]>([
    ['a lossless image', [image('a', false)], []],
    ['a lossy image', [image('a', true)], [LOSSY]],
    ['a lossless downscaled image', [image('a', false, { width: 10, height: 10 })], [DOWNSCALE]],
    ['a video', [video('v')], [LOSSY]],
    ['a downscaled video', [video('v', { width: 640, height: 360 })], [LOSSY, DOWNSCALE]],
    ['an audio re-encoding', [audioOp('a.mp3')], [LOSSY]],
    ['an audio conversion to MP3', [audioOp('a.wav', 'a.mp3')], [LOSSY, AUDIO_RENAME]],
    ['a lossless PDF rewrite', [pdfOp('a.pdf', false)], []],
    ['a PDF whose images may become JPEG', [pdfOp('a.pdf', true)], [PDF_IMAGES]],
    ['bookkeeping only', RESTRUCTURE_OPS.filter((o) => o.op === 'update-manifest'), []],
    [
      'a move only',
      RESTRUCTURE_OPS.filter((o) => o.op === 'move-resource'),
      ['Files in eXeLearning 3 folders will be moved to content/resources/ and their references updated.'],
    ],
    ['a rename only', RESTRUCTURE_OPS.filter((o) => o.op === 'rename-resource'), ['Some files get a clean name; all their references are updated.']],
  ])('derives the risk notes of %s', async (_, operations, notes) => {
    await toPlan(planOf({ operations, skipped: [] }));
    expect(riskNotes()).toEqual(notes);
    expect(root.querySelector('.risks') !== null).toBe(notes.length > 0);
  });

  it('closes large groups and caps long lists', async () => {
    const unused = Array.from(
      { length: 305 },
      (_, i) => ({ id: `r${i}`, op: 'remove-unused', path: `content/resources/x/${i}.png`, size: 1024, reason: '' }) as unknown as PlanOperation,
    );
    const images = Array.from({ length: 5 }, (_, i) => image(`i${i}`, false));
    const skipped = Array.from({ length: 250 }, (_, i) => ({ path: `content/resources/s${i}.mp4`, kind: 'video', reason: 'x', detail: 'kept' }));
    await toPlan(planOf({ operations: [...unused, ...images], skipped } as Partial<OptimizationPlan>));
    const [imagesGroup, unusedGroup] = planGroups();
    expect(imagesGroup!.slice(0, 3)).toEqual(['Images to recompress', '5', true]);
    expect(unusedGroup!.slice(0, 3)).toEqual(['Unused files to remove', '305', false]);
    expect(unusedGroup![3]).toHaveLength(301);
    expect(unusedGroup![3][0]).toBe('x/0.png (1.0 KB)');
    expect(unusedGroup![3].at(-1)).toBe('… +5');
    expect($('details.skipped summary').textContent).toBe('Left as is (250)');
    expect($$('ul.plan-skipped li')).toHaveLength(200);
  });

  it('explains an empty plan and does not allow running it', async () => {
    await toPlan(planOf({ operations: [], skipped: [], risks: [] }));
    expect($('.step-step4 p').textContent).toBe('With these options there is nothing to optimize.');
    expect(root.querySelector('.step-step4 h3')).toBeNull();
    expect(root.querySelector('.plan-ops')).toBeNull();
    expect(root.querySelector('.estimate')).toBeNull();
    expect(root.querySelector('.risks')).toBeNull();
    expect(root.querySelector('.step-step4 details')).toBeNull();
    expect(button('Optimize').disabled).toBe(true);
  });
});

describe('running', () => {
  it('shows stages and progress, determinate or not', async () => {
    await toRunning();
    expect(pipeline.optimizeCalls).toEqual(['plan-1']);
    expect(document.activeElement).toBe($('#h-step5'));
    expect($('#h-step5').textContent).toBe('Optimizing');
    const stages = (): string[] =>
      $$('ol.stages[data-role="stages"] li').map((li) => {
        const mark = li.querySelector('.spinner-border') ? '*' : li.classList.contains('is-done') ? '+' : '';
        return `${text(li)}${mark}${li.getAttribute('aria-current') === 'step' ? '!' : ''}`;
      });
    expect(stages()).toEqual([
      'Loading the engine',
      'Extracting',
      'Re-encoding video',
      'Recompressing images',
      'Optimizing PDFs',
      'Validating',
      'Packaging',
      'Verifying the result',
    ]);
    pipeline.optimizeProgress!({ stage: 'transcode', resource: 'content/resources/media/clase.mp4', processedSeconds: 30, totalSeconds: 64, fraction: 0.47 });
    expect(stages()).toEqual([
      'Loading the engine+',
      'Extracting+',
      'Re-encoding video*!',
      'Recompressing images',
      'Optimizing PDFs',
      'Validating',
      'Packaging',
      'Verifying the result',
    ]);
    expect(text($('[data-role="stages"] .is-current'))).toBe('Re-encoding video');
    expect($$('[data-role="stages"] .is-done svg.text-success')).toHaveLength(2);
    expect($('[data-role="progress"] .progress').getAttribute('aria-valuenow')).toBe('47');
    expect($('[data-role="progress"] .progress-bar').style.width).toBe('47%');
    expect($('.progress-text').textContent).toBe('Re-encoding video — 0:30 of 1:04 content/resources/media/clase.mp4');
    pipeline.optimizeProgress!({ stage: 'validate', message: 'Decoding the new video' });
    expect($('[data-role="progress"] .progress').hasAttribute('aria-valuenow')).toBe(false);
    expect($('[data-role="progress"] .progress-bar').classList.contains('progress-bar-animated')).toBe(true);
    expect($('.progress-text').textContent).toBe('Validating');
    expect(stages()[5]).toBe('Validating*!');
    pipeline.optimizeProgress!({ stage: 'pdf', resource: 'content/resources/docs/guia.pdf', item: 1, items: 2, message: 'qpdf, images pass' });
    expect($('.progress-text').textContent).toBe('Optimizing PDFs — 1 of 2 content/resources/docs/guia.pdf');
    expect(stages()[4]).toBe('Optimizing PDFs*!');
    // Missing totals: no "x of y" detail.
    pipeline.optimizeProgress!({ stage: 'transcode', processedSeconds: 3, totalSeconds: 0 });
    expect($('.progress-text').textContent).toBe('Re-encoding video');
    // A stage outside the list marks none.
    pipeline.optimizeProgress!({ stage: 'read' });
    expect(stages().every((s) => !/[*+!]/.test(s))).toBe(true);
  });

  it('cancels: the button reflects the request and the run ends as cancelled', async () => {
    await toRunning();
    const cancel = button('Cancel');
    expect(cancel.className).toBe('btn btn-outline-danger');
    cancel.click();
    expect(pipeline.cancelCalls).toBe(1);
    expect(button('Cancelling…').disabled).toBe(true);
    pipeline.optimization.reject(Object.assign(new Error('Cancelled'), { code: 'cancelled' }));
    await waitFor(() => app.currentView === 'error', 2000);
    expect(text($('[role="alert"] h2'))).toBe('Done');
    expect($('[role="alert"] h2').classList.contains('text-danger')).toBe(false);
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
    pipeline.analysis = deferred();
    pipeline.plans = deferred();
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
    const output = new Blob(['optimized zip']);
    await toResult(resultOf('partial', output, operations));
    expect(document.activeElement).toBe($('#h-step6'));
    expect($('#h-step6').textContent).toBe('Result');
    expect($('[role="status"]').textContent).toBe('Project optimized; some operations failed and those resources stay as they were.');
    expect($('.result-status').className).toBe('result-status status-partial alert alert-warning d-flex align-items-center gap-2');
    expect($('.saved-hero .saved-figure').textContent).toBe('50 % smaller');
    expect($('.saved-hero .saved').textContent).toBe('1.4 MB smaller than the original (measured on the final file).');
    expect($$('.compare .compare-row').map((r) => r.textContent)).toEqual(['Before2.9 MB', 'After1.4 MB']);
    expect($<HTMLElement>('.fill-before').style.width).toBe('100%');
    expect($<HTMLElement>('.fill-after').style.width).toBe('50%');
    const download = $<HTMLAnchorElement>('[data-testid="download"]');
    expect(download.getAttribute('href')).toBe('blob:test/1');
    expect(download.getAttribute('download')).toBe('curso_optimized.elpx');
    expect(text(download)).toBe('Download curso_optimized.elpx');
    expect(download.classList.contains('btn-primary')).toBe(true);
    const reportLink = $<HTMLAnchorElement>('[data-testid="download-report"]');
    expect(reportLink.getAttribute('href')).toBe('blob:test/2');
    expect(reportLink.getAttribute('download')).toBe('curso_optimized_report.json');
    expect(text(reportLink)).toBe('Download report (JSON)');
    // A named File, for browsers that ignore the download attribute of blob: URLs.
    const named = urls.created[0] as File;
    expect(named).toBeInstanceOf(File);
    expect(named.name).toBe('curso_optimized.elpx');
    expect(named.type).toBe('application/zip');
    expect(await named.text()).toBe('optimized zip');
    expect(urls.created[1]!.type).toBe('application/json');
    expect(JSON.parse(await urls.created[1]!.text())).toMatchObject({ status: 'partial' });
    expect($('details.op-details summary').textContent).toBe('Operation details (4)');
    expect($<HTMLDetailsElement>('details.op-details').open).toBe(true);
    expect(opResults()).toEqual([
      ['Applied media/clase.mp4 1.9 MB → 488 KB', ''],
      ['Discarded (original kept) fotos/foto.jpg 43.9 KB → 44.9 KB', 'not smaller enough'],
      ['Failed (original kept) fotos/x.png', 'decoder error'],
      ['Discarded (original kept) fotos/y.png', ''],
    ]);
    expect($$('.op-results li > span:first-child').map((s) => s.className)).toEqual([
      'text-success',
      'text-body-secondary',
      'text-danger',
      'text-body-secondary',
    ]);
    // A video was recompressed: no "originals kept" note.
    expect(root.querySelector('main [role="note"]')).toBeNull();
    expect(urls.revoked).toEqual([]);
    button('Optimize another project').click();
    expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
    expect(app.currentView).toBe('start');
    expect(document.activeElement).toBe($('#h-step1'));
  });

  it.each<[OptimizationReport['status'], string, string]>([
    ['optimized', 'alert-success', 'Project optimized.'],
    ['partial', 'alert-warning', 'Project optimized; some operations failed and those resources stay as they were.'],
    ['no-improvement', 'alert-secondary', 'The size could not be reduced. The download is an identical copy of the original.'],
    ['failed', 'alert-danger', 'The optimization did not pass the final validation; no file is delivered.'],
  ])('shows the "%s" status with its tone', async (status, tone, label) => {
    await toResult(resultOf(status, new Blob(['zip'])));
    const line = $('.result-status');
    expect(line.classList.contains(tone)).toBe(true);
    expect(line.classList.contains(`status-${status}`)).toBe(true);
    expect(text(line)).toBe(label);
    expect(line.querySelectorAll('svg')).toHaveLength(1);
  });

  it('releases previous downloads when another file is started directly', async () => {
    await toResult(resultOf('optimized', new Blob(['zip'])));
    pipeline.analysis = deferred();
    void app.start(new File(['PK'], 'siguiente.elpx'));
    expect(urls.revoked).toEqual(['blob:test/1', 'blob:test/2']);
    expect(app.currentView).toBe('analyzing');
  });

  it('shows "no improvement" without a saving line', async () => {
    await toResult(
      resultOf('no-improvement', new Blob(['same'], { type: 'application/octet-stream' }), [], { before: 1000, after: 1000, saved: 0, savedPercent: 0 }),
    );
    // The type of the output is kept when it has one.
    expect(urls.created[0]!.type).toBe('application/octet-stream');
    expect(text($('.result-status'))).toBe('The size could not be reduced. The download is an identical copy of the original.');
    expect(root.querySelector('.saved-hero')).toBeNull();
    expect(root.querySelector('.saved')).toBeNull();
    expect($<HTMLElement>('.fill-before').style.width).toBe('100%');
    expect(root.querySelector('[data-testid="download"]')).not.toBeNull();
    expect($('details.op-details summary').textContent).toBe('Operation details (0)');
  });

  it('says clearly when no planned video was recompressed', async () => {
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
    await toResult(resultOf('optimized', new Blob(['zip']), [...videos, operations[1]!, { ...operations[1]!, id: 'j', status: 'applied' }]));
    // The run status is kept; the note is not an error.
    expect(text($('.result-status'))).toBe('Project optimized.');
    const note = $('main [role="note"]');
    expect(note.textContent).toBe('No video was recompressed; the originals were kept (see reasons below).');
    expect(note.className).toBe('callout alert alert-light border');
    expect(note.closest('[role="alert"]')).toBeNull();
    // It sits right under the status, before the per-resource reasons.
    expect(note.previousElementSibling).toBe($('.result-status'));
    expect(opResults()[1]![1]).toContain('ran out of memory');
    languageButton().click();
    expect($('main [role="note"]').textContent).toBe('Ningún vídeo se ha recomprimido; se conservan los originales (ver motivos abajo).');
  });

  it('adds no video note when no video was planned', async () => {
    await toResult(resultOf('optimized', new Blob(['zip']), [operations[1]!]));
    expect(root.querySelector('main [role="note"]')).toBeNull();
  });

  it('closes the operation details when there are many', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ ...operations[0]!, id: `v${i}` }));
    await toResult(resultOf('optimized', new Blob(['zip']), many));
    expect($<HTMLDetailsElement>('details.op-details').open).toBe(false);
    expect($('details.op-details summary').textContent).toBe('Operation details (9)');
    expect($$('.op-results li')).toHaveLength(9);
  });

  it('offers nothing to download when the run failed', async () => {
    await toResult(resultOf('failed', undefined, operations.slice(0, 1), { before: 0, after: 0, saved: 0, savedPercent: 0 }));
    expect(text($('.result-status'))).toBe('The optimization did not pass the final validation; no file is delivered.');
    expect($('.result-status').classList.contains('alert-danger')).toBe(true);
    expect(root.querySelector('.compare')).toBeNull();
    expect(root.querySelector('.saved-hero')).toBeNull();
    expect(root.querySelector('[data-testid="download"]')).toBeNull();
    expect(urls.created).toEqual([]);
    expect($$('.op-results li')).toHaveLength(1);
    expect(button('Optimize another project')).toBeTruthy();
  });

  it('can be re-rendered in the other language without leaking URLs', async () => {
    await toResult(resultOf('optimized', new Blob(['zip'])));
    languageButton().click();
    expect(text($('.result-status'))).toBe('Proyecto optimizado.');
    expect($('.saved-figure').textContent).toBe('50 % menos');
    expect($('.saved').textContent).toBe('Ocupa 1,4 MB menos que el original (medido en el archivo final).');
    expect(stepper()).toEqual(['Proyecto:done', 'Opciones:done', 'Plan:done', 'Resultado:current']);
    await settle();
    app.reset();
    expect(urls.revoked).toEqual(urls.created.map((_, i) => `blob:test/${i + 1}`));
  });
});

describe('side panels', () => {
  /** Opens a side panel from its button and returns it. */
  function open(buttonSelector: string, panel: string): HTMLDialogElement {
    const trigger = $<HTMLButtonElement>(buttonSelector);
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
    const dialog = $<HTMLDialogElement>(`dialog.${panel}`);
    expect(dialog.open).toBe(false);
    trigger.click();
    expect(dialog.open).toBe(true);
    return dialog;
  }

  /** Every link of an element must open elsewhere without the opener. */
  function expectExternal(links: HTMLAnchorElement[]): void {
    for (const a of links) {
      expect(a.getAttribute('target'), a.href).toBe('_blank');
      expect(a.getAttribute('rel'), a.href).toBe('noopener noreferrer');
    }
  }

  it('lists the licenses of the app and of every bundled component', async () => {
    const { COMPONENTS } = await import('../../src/web/licenses.js');
    const dialog = open('.app-footer button.licenses-button', 'licenses-panel');
    expect(text($('.app-footer button.licenses-button'))).toBe('Licenses');
    expect(dialog.getAttribute('aria-labelledby')).toBe('licenses-title');
    expect(dialog.querySelector('#licenses-title')!.textContent).toBe('Licenses and credits');
    const items = [...dialog.querySelectorAll('.licenses-list li')];
    expect(items).toHaveLength(COMPONENTS.length);
    COMPONENTS.forEach((c, i) => {
      const li = items[i]!;
      expect(li.querySelector('strong')!.textContent).toBe(c.name);
      expect(li.querySelector('.badge')!.textContent).toBe(c.license);
      const link = li.querySelector('a')!;
      expect(link.getAttribute('href')).toBe(`licenses/${c.file}`);
      expect(link.getAttribute('aria-label')).toBe(`View the license of ${c.name}`);
      expect(link.textContent).toBe('View license');
      // The version is shown when known.
      expect(li.querySelector('div.small')!.textContent!.endsWith(` · ${c.version}`)).toBe(c.version !== '—');
    });
    expect(items[0]!.querySelector('div.small')!.textContent).toBe(
      'Re-encodes video and audio in the browser (includes x264, LAME and other libraries). · 0.12.10',
    );
    const links = [...dialog.querySelectorAll<HTMLAnchorElement>('a')];
    expectExternal(links);
    expect(links.map((a) => a.getAttribute('href'))).toEqual(
      expect.arrayContaining(['licenses/elpx-optimizer-AGPL-3.0.txt', 'https://github.com/ateeducacion/elpx-optimizer', 'licenses/THIRD-PARTY-NOTICES.txt']),
    );
    // Every link stays on this site except the source code.
    expect(links.filter((a) => /^https?:/.test(a.getAttribute('href')!)).map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/ateeducacion/elpx-optimizer',
    ]);
    expect(dialog.querySelector('[role="note"]')!.textContent).toMatch(/^The FFmpeg WebAssembly binaries/);
    expect(dialog.querySelector('img.ate-logo')!.getAttribute('alt')).toBe('');
    // The close button closes it.
    const close = dialog.querySelector<HTMLButtonElement>('.btn-close')!;
    expect(close.getAttribute('aria-label')).toBe('Close');
    close.click();
    expect(dialog.open).toBe(false);
  });

  it('closes on a click on the backdrop only', () => {
    const dialog = open('.app-footer button.licenses-button', 'licenses-panel');
    dialog.querySelector('p')!.click();
    expect(dialog.open).toBe(true);
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(dialog.open).toBe(false);
  });

  it('explains the CLI and the Agent Skill, with commands that can be copied', async () => {
    const helpButton = $<HTMLButtonElement>('header button.help-button');
    expect(helpButton.getAttribute('title')).toBe('Use it from the terminal and with agents');
    // A short label on wide screens, the full title for screen readers on narrow ones.
    expect(helpButton.querySelector('.d-md-inline')!.textContent).toBe('CLI');
    expect(helpButton.querySelector('.visually-hidden')!.textContent).toBe('Use it from the terminal and with agents');
    const dialog = open('header button.help-button', 'help-panel');
    expect(dialog.querySelector('#help-title')!.textContent).toBe('Use it from the terminal and with agents');
    // Docker first (the published image), then from the source code.
    expect([...dialog.querySelectorAll('h4')].map((x) => x.textContent)).toEqual(['With Docker (the simplest)', 'Without Docker, from the source code']);
    const [docker, local] = [...dialog.querySelectorAll('ol.help-steps')];
    const titles = (list: Element): (string | null)[] => [...list.querySelectorAll(':scope > li .fw-bold')].map((x) => x.textContent);
    expect(titles(docker!)).toEqual(['Review a project without changing anything', 'See the plan before applying it', 'Optimize']);
    expect(
      [...docker!.querySelectorAll('code')].every((c) =>
        c.textContent!.startsWith('docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer-cli '),
      ),
    ).toBe(true);
    expect(titles(local!)).toEqual([
      'Install FFmpeg (and Node.js 22 or Bun)',
      'Get the code and build the CLI',
      'Check that everything is available',
      'Review a project without changing anything',
      'See the plan before applying it',
      'Optimize',
    ]);
    // Notes only where they help.
    const notes = (list: Element): boolean[] =>
      [...list.querySelectorAll(':scope > li')].map((li) => li.querySelector(':scope > .text-body-secondary') !== null);
    expect(notes(docker!)).toEqual([false, false, true]);
    expect(notes(local!)).toEqual([true, false, false, false, false, true]);
    const codes = [...dialog.querySelectorAll('.code-block code')].map((c) => c.textContent!);
    expect(codes).toContain('docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer');
    expect(codes).toContain('node dist/cli/elpx-optimizer.mjs doctor');
    expect(codes.some((c) => c.includes('--flatten legacy --missing-references remove'))).toBe(true);
    expect(dialog.textContent).toContain('On Windows (PowerShell), drop --user and use -v "${PWD}:/work".');
    expectExternal([...dialog.querySelectorAll<HTMLAnchorElement>('a')]);
    expect([...dialog.querySelectorAll('a')].map((a) => a.getAttribute('href'))).toEqual([
      'https://github.com/ateeducacion/elpx-optimizer/blob/main/docs/cli.md',
      'https://github.com/ateeducacion/elpx-optimizer/blob/main/skills/elpx-optimizer/SKILL.md',
      'https://github.com/ateeducacion/elpx-optimizer/blob/main/docs/skill.md',
    ]);
    /** The copy button of the block holding a command. */
    const copyOf = (command: string): HTMLButtonElement =>
      [...dialog.querySelectorAll('.code-block')].find((b) => b.querySelector('code')!.textContent === command)!.querySelector('.copy-button')!;

    // Copying puts the command on the clipboard and says so.
    const write = vi.fn(() => Promise.resolve());
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText: write } as unknown as Clipboard);
    const copy = copyOf('node dist/cli/elpx-optimizer.mjs doctor');
    expect(copy.getAttribute('aria-label')).toBe('Copy');
    const before = copy.innerHTML;
    copy.click();
    expect(write).toHaveBeenCalledWith('node dist/cli/elpx-optimizer.mjs doctor');
    await waitFor(() => copy.innerHTML !== before, 2000, 'copied icon');
    expect(copy.querySelector('svg')!.outerHTML).toBe(icon('clipboard-check').outerHTML);
    expect($('[role="status"]').textContent).toBe('Copied to the clipboard');
    // A refused copy changes nothing.
    write.mockImplementation(() => Promise.reject(new Error('denied')));
    const other = copyOf('docker run --rm -p 8080:8080 ghcr.io/ateeducacion/elpx-optimizer');
    const otherBefore = other.innerHTML;
    other.click();
    await settle();
    expect(other.innerHTML).toBe(otherBefore);
    // Without a clipboard (insecure context) the button does nothing.
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue(undefined as unknown as Clipboard);
    expect(() => other.click()).not.toThrow();
    dialog.close();
  });

  it('links the Agent Skill from the header and follows the language', () => {
    const skill = $$<HTMLAnchorElement>('header a').find((a) => a.getAttribute('href')!.endsWith('/SKILL.md'))!;
    expect(skill.getAttribute('href')).toBe('https://github.com/ateeducacion/elpx-optimizer/blob/main/skills/elpx-optimizer/SKILL.md');
    expect(skill.getAttribute('aria-label')).toBe('Agent Skill for AI assistants: SKILL.md on GitHub (opens in a new tab)');
    expectExternal([skill]);
    languageButton().click();
    expect($('.app-footer button.licenses-button').textContent).toBe('Licencias');
    expect($('dialog.licenses-panel #licenses-title').textContent).toBe('Licencias y créditos');
    expect($('dialog.help-panel #help-title').textContent).toBe('Usar desde la terminal y con agentes');
    // Re-mounting replaces the panels instead of piling them up.
    expect($$('dialog.licenses-panel')).toHaveLength(1);
    expect($$('dialog.help-panel')).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ previews

/** A short silent WAV file (8 kHz, 8-bit mono). */
function silentWav(seconds = 2): Blob {
  const samples = 8000 * seconds;
  const buffer = new ArrayBuffer(44 + samples);
  const v = new DataView(buffer);
  const ascii = (at: number, s: string): void => [...s].forEach((c, i) => v.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  v.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  ascii(36, 'data');
  v.setUint32(40, samples, true);
  new Uint8Array(buffer, 44).fill(128);
  return new Blob([buffer], { type: 'audio/wav' });
}

/** A 2×2 PNG. */
async function smallPng(): Promise<Blob> {
  const canvas = new OffscreenCanvas(2, 2);
  canvas.getContext('2d')!.fillRect(0, 0, 2, 2);
  return canvas.convertToBlob({ type: 'image/png' });
}

/** Pipeline double that can also preview resources. */
class PreviewPipeline extends FakePipeline {
  readonly previewCalls: string[] = [];
  answer: (path: string) => Promise<Blob> = () => Promise.resolve(new Blob(['x']));

  preview(path: string): Promise<Blob> {
    this.previewCalls.push(path);
    return this.answer(path);
  }
}

/** Real object URLs, recorded. */
class LiveUrls implements UrlApi {
  readonly created: string[] = [];
  readonly revoked: string[] = [];

  createObjectURL(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.created.push(url);
    return url;
  }

  revokeObjectURL(url: string): void {
    this.revoked.push(url);
    URL.revokeObjectURL(url);
  }
}

describe('resource previews', () => {
  const AUDIO = 'content/resources/audio/"voz" 1.mp3';
  const PREVIEW_ENTRIES: InventoryEntry[] = [
    ENTRIES[0]!, // clase.mp4 640×360
    ENTRIES[1]!, // raro.mp4, no size
    entry('content/resources/media/alto.mp4', 'video', {
      size: 4000,
      video: { container: 'mp4', width: 320, audio: [], subtitles: 0, chapters: 0, otherStreams: 0 },
    }),
    ENTRIES[3]!, // foto.jpg 800×600
    entry('content/resources/fotos/ancho.png', 'image', { size: 200, image: { width: 50, animated: false, hasIcc: false, hasExif: false, hasXmp: false } }),
    ENTRIES[5]!, // sin-info.png
    ENTRIES[6]!, // guia.pdf
    entry(AUDIO, 'audio', { size: 3000 }),
    entry('content/resources/audio/otra.wav', 'audio', { size: 2000 }),
  ];
  let previews: PreviewPipeline;
  let live: LiveUrls;

  beforeEach(async () => {
    root.replaceChildren();
    previews = new PreviewPipeline();
    pipeline = previews;
    live = new LiveUrls();
    app = new App(root, previews, 'en', live);
    app.mount();
    await toReview(analysisResult({ entries: PREVIEW_ENTRIES }));
  });

  /** The preview button of a resource. */
  function previewButton(path: string): HTMLButtonElement {
    return $<HTMLButtonElement>(`.preview-button[data-path="${CSS.escape(path)}"]`);
  }

  /** The open preview window. */
  function previewDialog(): HTMLDialogElement | null {
    return root.querySelector<HTMLDialogElement>('dialog.preview-dialog');
  }

  it('offers a preview button for images, videos and audio', () => {
    const buttons = $$<HTMLButtonElement>('.inventory .preview-button');
    expect(buttons.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Watch the video media/clase.mp4',
      'View the image fotos/foto.jpg',
      'Watch the video media/raro.mp4',
      'Watch the video media/alto.mp4',
      'Play audio/"voz" 1.mp3',
      'Play audio/otra.wav',
      'View the image fotos/ancho.png',
      'View the image fotos/sin-info.png',
    ]);
    expect(buttons.every((b) => b.getAttribute('title') === b.getAttribute('aria-label'))).toBe(true);
    expect(buttons.map((b) => b.getAttribute('aria-pressed'))).toEqual([null, null, null, null, 'false', 'false', null, null]);
    const names: IconName[] = ['play-circle', 'eye', 'play-fill'];
    const iconOf = (b: Element): IconName | undefined => names.find((n) => icon(n).outerHTML === b.querySelector('svg')!.outerHTML);
    expect(buttons.map(iconOf)).toEqual(['play-circle', 'eye', 'play-circle', 'play-circle', 'play-fill', 'play-fill', 'eye', 'eye']);
    // A document has no preview: it keeps its kind icon.
    const pdfRow = $$('.inventory tbody tr').find((tr) => text(tr.querySelector('th')).endsWith('docs/guia.pdf'))!;
    expect(pdfRow.querySelector('.preview-button')).toBeNull();
    expect(pdfRow.querySelector('.kind-icon svg')).not.toBeNull();
  });

  it('shows an image in a modal window and releases it when closed', async () => {
    const png = await smallPng();
    const pending = deferred<Blob>();
    previews.answer = () => pending.promise;
    const button = previewButton('content/resources/fotos/foto.jpg');
    const icons = button.innerHTML;
    button.click();
    expect(previews.previewCalls).toEqual(['content/resources/fotos/foto.jpg']);
    // A spinner while the image is read from the project.
    expect(button.disabled).toBe(true);
    expect(button.querySelector('.spinner-border')).not.toBeNull();
    pending.resolve(png);
    await waitFor(() => previewDialog() !== null, 2000, 'preview window');
    expect(button.disabled).toBe(false);
    expect(button.innerHTML).toBe(icons);
    const dialog = previewDialog()!;
    expect(dialog.open).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('preview-title');
    expect(dialog.querySelector('#preview-title')!.textContent).toBe('fotos/foto.jpg');
    expect(dialog.querySelector('.preview-header p')!.textContent).toBe('800×600 · 43.9 KB');
    const img = dialog.querySelector<HTMLImageElement>('img.preview-media')!;
    expect(img.getAttribute('alt')).toBe('fotos/foto.jpg');
    expect(img.getAttribute('src')).toBe(live.created[0]);
    // A named download of the original file (the viewer's own would save a nameless blob: URL).
    const save = dialog.querySelector<HTMLAnchorElement>('.preview-header a[download]')!;
    expect(save.getAttribute('href')).toBe(live.created[0]);
    expect(save.getAttribute('download')).toBe('foto.jpg');
    expect(text(save)).toBe('Download');
    await waitFor(() => img.complete && img.naturalWidth === 2, 2000, 'image decoded');
    // Clicks inside keep it open; the close button closes it and releases the image.
    dialog.querySelector('p')!.click();
    expect(dialog.open).toBe(true);
    dialog.querySelector<HTMLButtonElement>('.btn-close')!.click();
    await waitFor(() => previewDialog() === null, 2000, 'window removed');
    expect(img.hasAttribute('src')).toBe(false);
    expect(live.revoked).toEqual(live.created);
  });

  it('plays a video in a modal window, closed from the backdrop', async () => {
    previewButton('content/resources/media/clase.mp4').click();
    await waitFor(() => previewDialog() !== null, 2000, 'preview window');
    const dialog = previewDialog()!;
    expect(dialog.querySelector('.preview-header p')!.textContent).toBe('640×360 · 1.9 MB');
    const video = dialog.querySelector<HTMLVideoElement>('video.preview-media')!;
    expect(video.controls).toBe(true);
    expect(video.autoplay).toBe(true);
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.getAttribute('controlslist')).toBe('nodownload');
    expect(dialog.querySelector('.preview-header a[download]')!.getAttribute('download')).toBe('clase.mp4');
    const pause = vi.spyOn(video, 'pause');
    dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => previewDialog() === null, 2000, 'window removed');
    expect(pause).toHaveBeenCalled();
    expect(video.hasAttribute('src')).toBe(false);
    expect(live.revoked).toEqual(live.created);
  });

  it.each([
    ['content/resources/media/raro.mp4', '4.9 KB'],
    ['content/resources/media/alto.mp4', '320×? · 3.9 KB'],
    ['content/resources/fotos/ancho.png', '50×? · 200 B'],
    ['content/resources/fotos/sin-info.png', '100 B'],
  ])('describes %s with the size it knows', async (path, line) => {
    previewButton(path).click();
    await waitFor(() => previewDialog() !== null, 2000, 'preview window');
    expect(previewDialog()!.querySelector('.preview-header p')!.textContent).toBe(line);
    previewDialog()!.close();
  });

  it('says when a resource cannot be shown', async () => {
    previews.answer = () => Promise.reject(new Error('The file is no longer available'));
    const button = previewButton('content/resources/fotos/foto.jpg');
    button.click();
    await waitFor(() => !button.disabled, 2000, 'button restored');
    expect($('[role="status"]').textContent).toBe('Cannot show fotos/foto.jpg. The file is no longer available');
    expect(previewDialog()).toBeNull();
    expect(live.created).toEqual([]);
    expect(button.querySelector('.spinner-border')).toBeNull();
  });

  it('plays and pauses audio in the table and stops it when leaving the review', async () => {
    // Real clicks: the browser only plays audio after a user gesture.
    previews.answer = () => Promise.resolve(silentWav());
    const pressed = (path: string): string | null => previewButton(path).getAttribute('aria-pressed');
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => pressed(AUDIO) === 'true', 5000, 'playing');
    expect(previewButton(AUDIO).getAttribute('aria-label')).toBe('Pause audio/"voz" 1.mp3');
    expect(previewButton(AUDIO).querySelector('svg')!.outerHTML).toBe(icon('pause-fill').outerHTML);
    expect(previews.previewCalls).toEqual([AUDIO]);
    // Pause and resume without reading the file again.
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => pressed(AUDIO) === 'false', 5000, 'paused');
    expect(previewButton(AUDIO).getAttribute('aria-label')).toBe('Play audio/"voz" 1.mp3');
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => pressed(AUDIO) === 'true', 5000, 'playing again');
    expect(previews.previewCalls).toEqual([AUDIO]);
    // The state survives sorting and a language switch.
    $<HTMLButtonElement>('button.sort[aria-label="Sort by File"]').click();
    expect(pressed(AUDIO)).toBe('true');
    languageButton().click();
    expect(previewButton(AUDIO).getAttribute('aria-label')).toBe('Pausar audio/"voz" 1.mp3');
    languageButton().click();
    // Another audio replaces the first one, which is released.
    await userEvent.click(previewButton('content/resources/audio/otra.wav'));
    await waitFor(() => pressed('content/resources/audio/otra.wav') === 'true', 5000, 'second audio');
    expect(pressed(AUDIO)).toBe('false');
    expect(live.revoked).toEqual([live.created[0]]);
    // Opening an image stops the audio too.
    previewButton('content/resources/fotos/foto.jpg').click();
    await waitFor(() => previewDialog() !== null, 2000, 'preview window');
    expect(live.revoked).toEqual(live.created.slice(0, 2));
    previewDialog()!.close();
    await waitFor(() => previewDialog() === null, 2000, 'window removed');
    // Leaving the review stops and releases the audio.
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => pressed(AUDIO) === 'true', 5000, 'playing before leaving');
    const playing = live.created.at(-1)!;
    $<HTMLFormElement>('form.options').requestSubmit();
    previews.plans.resolve(planOf());
    await waitFor(() => app.currentView === 'plan', 2000);
    expect(live.revoked).toContain(playing);
    expect(live.revoked).toHaveLength(live.created.length);
  });

  it('says when the audio cannot be played, and offers to try again', async () => {
    previews.answer = () => Promise.resolve(new Blob(['not audio'], { type: 'audio/mpeg' }));
    const failed = 'Cannot show audio/"voz" 1.mp3. ';
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => $('[role="status"]').textContent === failed, 5000, 'failure');
    // Nothing plays: the button offers to play again and the file is released.
    await waitFor(() => previewButton(AUDIO).getAttribute('aria-pressed') === 'false', 2000, 'not pressed');
    expect(previewButton(AUDIO).getAttribute('aria-label')).toBe('Play audio/"voz" 1.mp3');
    expect(live.created).toHaveLength(1);
    expect(live.revoked).toEqual(live.created);
    // A second press reads the file again.
    $('[role="status"]').textContent = '';
    await userEvent.click(previewButton(AUDIO));
    await waitFor(() => $('[role="status"]').textContent === failed, 5000, 'second failure');
    expect(previews.previewCalls).toEqual([AUDIO, AUDIO]);
  });

  it('treats an interrupted start as a pause and keeps the current audio on a late failure', async () => {
    const plays: ReturnType<typeof deferred<void>>[] = [];
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => {
      plays.push(deferred<void>());
      return plays.at(-1)!.promise;
    });
    const status = $('[role="status"]');
    previewButton(AUDIO).click();
    await waitFor(() => plays.length === 1, 2000, 'first play');
    previewButton('content/resources/audio/otra.wav').click();
    await waitFor(() => plays.length === 2, 2000, 'second play');
    // The first audio was released when the second one was chosen.
    expect(live.revoked).toEqual([live.created[0]]);
    // A start interrupted by a pause is not a failure: nothing is said or released.
    plays[1]!.reject(new DOMException('The play() request was interrupted by a call to pause().', 'AbortError'));
    await settle();
    expect(status.textContent).toBe('Review the contents');
    expect(live.revoked).toEqual([live.created[0]]);
    // A late failure of the first audio is reported but does not stop the second one.
    plays[0]!.reject(new DOMException('unsupported', 'NotSupportedError'));
    await settle();
    expect(status.textContent).toBe('Cannot show audio/"voz" 1.mp3. ');
    expect(live.revoked).toEqual([live.created[0]]);
    // A refused resume of the current audio changes nothing either.
    previewButton('content/resources/audio/otra.wav').click();
    await waitFor(() => plays.length === 3, 2000, 'resume');
    plays[2]!.reject(new DOMException('denied', 'NotAllowedError'));
    await settle();
    expect(previews.previewCalls).toHaveLength(2);
    expect(live.revoked).toEqual([live.created[0]]);
  });

  it('drops a preview that arrives after leaving the review', async () => {
    const pending = deferred<Blob>();
    previews.answer = () => pending.promise;
    previewButton(AUDIO).click();
    $<HTMLFormElement>('form.options').requestSubmit();
    previews.plans.resolve(planOf());
    await waitFor(() => app.currentView === 'plan', 2000);
    pending.resolve(silentWav());
    await settle();
    await new Promise((r) => setTimeout(r, 200));
    // Nothing plays behind the plan and nothing is left allocated.
    expect(live.created).toEqual([]);
    expect(previewDialog()).toBeNull();
  });

  it('keeps only the last of two previews requested in a row', async () => {
    const first = deferred<Blob>();
    const second = deferred<Blob>();
    previews.answer = (path) => (path === AUDIO ? first.promise : second.promise);
    await userEvent.click(previewButton(AUDIO));
    await userEvent.click(previewButton('content/resources/audio/otra.wav'));
    second.resolve(silentWav());
    await waitFor(() => previewButton('content/resources/audio/otra.wav').getAttribute('aria-pressed') === 'true', 5000, 'second audio');
    first.resolve(silentWav());
    await new Promise((r) => setTimeout(r, 200));
    // The earlier answer does not start a second, unstoppable player.
    expect(previewButton(AUDIO).getAttribute('aria-pressed')).toBe('false');
    expect(previewButton('content/resources/audio/otra.wav').getAttribute('aria-pressed')).toBe('true');
    expect(live.created.length - live.revoked.length).toBe(1);
  });
});

describe('project thumbnail', () => {
  /** Pipeline double that previews the current thumbnail, reads the first page and records the new one. */
  class ThumbnailPipeline extends PreviewPipeline {
    readonly files = new Map<string, Blob>();
    readonly screenshots: (Blob | undefined)[] = [];

    read(path: string): Promise<Blob | undefined> {
      return Promise.resolve(this.files.get(path));
    }

    override optimize(planHash: string, onProgress?: (e: ProgressEvent) => void, screenshot?: Blob): Promise<OptimizeResult> {
      this.screenshots.push(screenshot);
      return super.optimize(planHash, onProgress);
    }
  }

  let thumbs: ThumbnailPipeline;
  const WITH_PAGE = [...ENTRIES, entry('index.html', 'text', { role: 'runtime' })];

  beforeEach(async () => {
    root.replaceChildren();
    thumbs = new ThumbnailPipeline();
    thumbs.answer = () => smallPng();
    thumbs.files.set('index.html', new Blob(['<!DOCTYPE html><html><body style="background:#fc0"><h1>Tema 1</h1></body></html>']));
    pipeline = thumbs;
    app = new App(root, thumbs, 'en', new LiveUrls());
    app.mount();
  });

  function status(): string {
    return text($('.screenshot .screenshot-status'));
  }

  async function upload(blob: Blob, name = 'foto.png'): Promise<void> {
    const input = $<HTMLInputElement>('.screenshot input[type="file"]');
    const files = new DataTransfer();
    files.items.add(new File([blob], name, { type: blob.type }));
    input.files = files.files;
    input.dispatchEvent(new Event('change'));
  }

  async function png(width: number, height: number): Promise<Blob> {
    const canvas = new OffscreenCanvas(width, height);
    canvas.getContext('2d')!.fillRect(0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  it('points to the current thumbnail, regenerates it from the first page and can discard the new one', async () => {
    await toReview(analysisResult({ entries: WITH_PAGE }));
    expect(text($('.screenshot legend'))).toBe('Project thumbnail (screenshot.png)');
    const current = 'The project already has a thumbnail: view it from its row in the contents.';
    expect(text($('.screenshot'))).toContain(current);
    // The current one is previewed from the contents.
    expect(root.querySelector('.preview-button[data-path="screenshot.png"]')).not.toBeNull();
    expect(app.readOptions($<HTMLFormElement>('form.options'))).not.toHaveProperty('screenshot');

    button('Regenerate from the first page').click();
    await waitFor(() => status().startsWith('New thumbnail ready'), 5000, 'regenerated');
    expect($('.screenshot img').getAttribute('alt')).toBe('New project thumbnail');
    const options = app.readOptions($<HTMLFormElement>('form.options'));
    expect(options.screenshot).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as string, size: expect.any(Number) as number });

    button('Discard the new one').click();
    expect(root.querySelector('.screenshot img')).toBeNull();
    expect(text($('.screenshot'))).toContain(current);
    expect(app.readOptions($<HTMLFormElement>('form.options'))).not.toHaveProperty('screenshot');
  });

  it('offers no regeneration without a first page, and says when there is no thumbnail', async () => {
    const base = analysisResult();
    await toReview(analysisResult({ package: { ...base.package!, hasScreenshot: false } }));
    expect(text($('.screenshot'))).toContain('This project has no thumbnail.');
    expect($$('.screenshot button').map((b) => text(b))).toEqual(['Upload image…']);
  });

  it('takes an uploaded 16:9 image and refuses other shapes, in the interface language', async () => {
    await toReview(analysisResult({ entries: WITH_PAGE }));
    await upload(await png(1000, 1000));
    await waitFor(() => status() !== 'Preparing the thumbnail…' && status() !== '', 5000, 'refused');
    expect(status()).toBe('The image must be 16:9 and at least 600 px wide.');
    await upload(await png(1920, 1080));
    await waitFor(() => status().startsWith('New thumbnail ready'), 5000, 'uploaded');
    expect(app.readOptions($<HTMLFormElement>('form.options')).screenshot?.size).toBeGreaterThan(0);
  });

  it('reports a first page that cannot be read, and ignores an empty file choice', async () => {
    thumbs.read = () => Promise.reject(new Error('worker gone'));
    await toReview(analysisResult({ entries: WITH_PAGE }));
    const input = $<HTMLInputElement>('.screenshot input[type="file"]');
    input.dispatchEvent(new Event('change'));
    expect(status()).toBe('');
    button('Regenerate from the first page').click();
    await waitFor(() => status().startsWith('The thumbnail could not'), 5000, 'error');
    expect(status()).toBe('The thumbnail could not be prepared: worker gone');
    expect(button('Regenerate from the first page').disabled).toBe(false);
  });

  it('refuses a drawn thumbnail that breaks the rules, and names an added one in the plan', async () => {
    // The page checks what the canvas produced before taking it: here an encoder gone wrong.
    const base = analysisResult({ entries: WITH_PAGE });
    await toReview(analysisResult({ entries: WITH_PAGE, package: { ...base.package!, hasScreenshot: false } }));
    const source = await png(1280, 720);
    const big = new Blob([new Uint8Array(9 * 1024 * 1024)]);
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementationOnce((callback) => callback(big));
    await upload(source);
    await waitFor(() => status().startsWith('The thumbnail could not'), 5000, 'refused');
    expect(status()).toBe(`The thumbnail could not be prepared: larger than ${8 * 1024 * 1024} bytes`);
    spy.mockRestore();
    const op = { id: 's', op: 'replace-screenshot', path: 'screenshot.png', size: 0, after: 2048, added: true } as PlanOperation;
    $<HTMLFormElement>('form.options').requestSubmit();
    thumbs.plans.resolve(planOf({ operations: [op] }));
    await waitFor(() => app.currentView === 'plan', 2000, 'plan');
    expect(text($('.op-replace-screenshot'))).toBe('screenshot.png (new, 2.0 KB)');
  });

  it('sends the new thumbnail with the plan that names it', async () => {
    await toReview(analysisResult({ entries: WITH_PAGE }));
    await upload(await png(1280, 720));
    await waitFor(() => status().startsWith('New thumbnail ready'), 5000, 'uploaded');
    const options = app.readOptions($<HTMLFormElement>('form.options'));
    $<HTMLFormElement>('form.options').requestSubmit();
    expect(thumbs.planCalls.at(-1)?.screenshot).toEqual(options.screenshot);
    const op = { id: 's', op: 'replace-screenshot', path: 'screenshot.png', size: 13_917, after: options.screenshot!.size, added: false } as PlanOperation;
    thumbs.plans.resolve(planOf({ operations: [op] }));
    await waitFor(() => app.currentView === 'plan', 2000, 'plan');
    expect(planGroups().map(([title]) => title)).toContain('Project thumbnail');
    expect(text($('.op-replace-screenshot'))).toMatch(/^screenshot\.png \(replaced, [\d.,]+ [kK]?B\)$/);
    button('Optimize').click();
    await waitFor(() => thumbs.screenshots.length === 1, 2000, 'optimize');
    expect(thumbs.screenshots[0]?.size).toBe(options.screenshot!.size);
  });
});
