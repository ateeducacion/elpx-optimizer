import type { AnalysisResult, InventoryEntry } from '../core/analyze/model.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ProgressEvent } from '../core/media/engine.js';
import type { OptionsInput } from '../core/plan/options.js';
import type { OptimizationPlan } from '../core/plan/plan.js';
import type { OptimizationReport } from '../core/report/report.js';
import type { EngineStatus } from '../adapters/browser/protocol.js';
import type { OptimizeResult } from '../adapters/browser/pipeline-client.js';
import type { ThreadingPreference } from '../adapters/browser/ffmpeg-loader.js';
import { h, replace } from './dom.js';
import { bytes, duration, percent } from './format.js';
import { translate, type Lang } from './i18n.js';

/** What the UI needs from the pipeline (the real client or a test double). */
export interface PipelineApi {
  analyze(file: File, onProgress?: (e: ProgressEvent) => void, threading?: ThreadingPreference): Promise<AnalysisResult>;
  plan(options: OptionsInput): Promise<OptimizationPlan>;
  optimize(planHash: string, onProgress?: (e: ProgressEvent) => void): Promise<OptimizeResult>;
  cancel(): Promise<void>;
  onEngineStatus: ((s: EngineStatus) => void) | undefined;
}

/** Browser services used for downloads (injectable for tests). */
export interface UrlApi {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

type View = 'start' | 'analyzing' | 'review' | 'plan' | 'running' | 'result' | 'error';
type SortKey = 'path' | 'kind' | 'size' | 'usage';
type StepKey = 'step1' | 'step2' | 'step3' | 'step4' | 'step5' | 'step6';

const STEP_NUMBERS: Record<StepKey, number> = { step1: 1, step2: 2, step3: 3, step4: 4, step5: 5, step6: 6 };

const STAGES = ['engine-load', 'extract', 'transcode', 'encode-image', 'validate', 'package', 'verify'] as const;

/**
 * The single-page application. Views follow the sequence: choose file,
 * review contents, choose options, confirm plan, progress, result.
 */
export class App {
  private lang: Lang;
  private view: View = 'start';
  private file: File | undefined;
  private analysis: AnalysisResult | undefined;
  private plan: OptimizationPlan | undefined;
  private result: OptimizeResult | undefined;
  private errorMessage = '';
  private errorCode = '';
  private engine: EngineStatus = { state: 'idle' };
  private progress: ProgressEvent | undefined;
  private readonly excluded = new Set<string>();
  private sort: { key: SortKey; dir: 1 | -1 } = { key: 'size', dir: -1 };
  private options: OptionsInput = { preset: 'balanced' };
  private threading: ThreadingPreference;
  private cancelling = false;
  private objectUrls: string[] = [];
  private readonly main: HTMLElement;
  private readonly engineLine: HTMLElement;
  private readonly status: HTMLElement;

  constructor(
    private readonly root: HTMLElement,
    private readonly pipeline: PipelineApi,
    lang: Lang,
    private readonly urls: UrlApi = URL,
    settings: { readonly threading?: ThreadingPreference } = {},
  ) {
    this.lang = lang;
    this.threading = settings.threading ?? 'auto';
    this.main = h('main', { id: 'main', className: 'app-main' });
    this.engineLine = h('p', { className: 'engine-line', 'aria-live': 'polite' });
    this.status = h('p', { className: 'visually-hidden', 'aria-live': 'polite', role: 'status' });
    pipeline.onEngineStatus = (s) => {
      this.engine = s;
      this.renderEngine();
    };
  }

  private t(key: string, params: Record<string, string | number> = {}): string {
    return translate(this.lang, key, params);
  }

  /** Renders the whole page. */
  mount(): void {
    document.documentElement.lang = this.lang;
    document.title = this.t('title');
    const header = h(
      'header',
      { className: 'app-header' },
      h(
        'div',
        { className: 'header-row' },
        h('h1', {}, this.t('title')),
        h(
          'button',
          { type: 'button', className: 'link-button', 'aria-label': this.t('languageLabel'), onclick: () => this.switchLanguage() },
          this.t('language'),
        ),
      ),
      h('p', { className: 'lead' }, this.t('lead')),
      h('p', { className: 'privacy' }, this.t('privacy')),
      this.engineLine,
    );
    const footer = h(
      'footer',
      { className: 'app-footer' },
      h('p', {}, this.t('footer')),
      h('p', {}, h('a', { href: 'licenses/THIRD-PARTY-NOTICES.txt' }, this.t('notices'))),
    );
    replace(this.root, header, this.main, this.status, footer);
    this.renderEngine();
    this.render();
  }

  private switchLanguage(): void {
    this.lang = this.lang === 'es' ? 'en' : 'es';
    this.mount();
  }

  private renderEngine(): void {
    const s = this.engine;
    let text = this.t('engineIdle');
    if (s.state === 'loading') text = this.t('engineLoading');
    else if (s.state === 'ready') text = this.t('engineReady', { mode: this.t(s.mode === 'multi' ? 'modeMulti' : 'modeSingle') });
    else if (s.state === 'error') text = this.t('engineError', { message: s.message ?? '' });
    this.engineLine.textContent = text;
    this.engineLine.dataset['state'] = s.state;
  }

  private announce(text: string): void {
    this.status.textContent = text;
  }

  private go(view: View): void {
    this.view = view;
    this.render();
    const heading = this.main.querySelector<HTMLElement>('h2');
    heading?.focus();
  }

  private render(): void {
    switch (this.view) {
      case 'start':
        replace(this.main, this.renderPicker());
        break;
      case 'analyzing':
        replace(this.main, this.section('step2', h('p', {}, this.t('analyzing', { name: this.file!.name })), this.renderProgressBar()));
        break;
      case 'review':
        replace(this.main, this.renderReview());
        break;
      case 'plan':
        replace(this.main, this.renderPlan());
        break;
      case 'running':
        replace(this.main, this.renderRunning());
        break;
      case 'result':
        replace(this.main, this.renderResult());
        break;
      case 'error':
        replace(this.main, this.renderError());
        break;
    }
  }

  private section(stepKey: StepKey, ...children: (Node | string | false | undefined)[]): HTMLElement {
    return h(
      'section',
      { className: `step step-${stepKey}`, 'aria-labelledby': `h-${stepKey}` },
      h('h2', { id: `h-${stepKey}`, tabindex: -1 }, h('span', { className: 'step-number' }, `${STEP_NUMBERS[stepKey]}`), this.t(stepKey)),
      ...children,
    );
  }

  // ------------------------------------------------------------------ step 1
  private renderPicker(): HTMLElement {
    const input = h('input', { type: 'file', id: 'file-input', accept: '.elpx,.elp,.zip,application/zip', className: 'visually-hidden' });
    input.addEventListener('change', () => {
      const f = input.files?.[0];
      if (f) void this.start(f);
    });
    const zone = h(
      'div',
      { className: 'dropzone', 'data-testid': 'dropzone' },
      h('p', { className: 'drop-title' }, this.t('drop')),
      h('p', { className: 'drop-or' }, this.t('or')),
      h(
        'label',
        { for: 'file-input', className: 'button primary', tabindex: 0, role: 'button', onkeydown: (e: Event) => this.activateOnKey(e as KeyboardEvent, input) },
        this.t('choose'),
      ),
      input,
      h('p', { className: 'hint' }, this.t('accepts')),
    );
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      zone.classList.add('is-over');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      zone.classList.remove('is-over');
      const f = e.dataTransfer?.files[0];
      if (f) void this.start(f);
    });
    return this.section('step1', zone);
  }

  private activateOnKey(e: KeyboardEvent, input: HTMLInputElement): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      input.click();
    }
  }

  /** Starts analysis of a file. */
  async start(file: File): Promise<void> {
    this.file = file;
    this.analysis = undefined;
    this.plan = undefined;
    this.result = undefined;
    this.excluded.clear();
    this.revokeUrls();
    this.progress = undefined;
    this.go('analyzing');
    try {
      this.analysis = await this.pipeline.analyze(file, (e) => this.onProgress(e), this.threading);
      if (!this.analysis.ok) {
        const fatal = this.analysis.diagnostics.find((d) => d.severity === 'fatal');
        this.showError(fatal?.code ?? 'invalid-input', fatal?.message ?? this.t('status_invalid-input'));
        return;
      }
      this.announce(this.t('step2'));
      this.go('review');
    } catch (error) {
      this.showError((error as { code?: string }).code ?? 'error', (error as Error).message);
    }
  }

  private onProgress(e: ProgressEvent): void {
    this.progress = e;
    const bar = this.main.querySelector('[data-role="progress"]');
    if (bar) bar.replaceWith(this.renderProgressBar());
    if (this.view === 'running') this.main.querySelector('[data-role="stages"]')!.replaceWith(this.renderStages());
  }

  private renderProgressBar(): HTMLElement {
    const e = this.progress;
    const fraction = e?.fraction;
    const label = e ? this.t(`stage_${e.stage}`) : this.t('stage_read');
    let detail = '';
    if (e?.processedSeconds !== undefined && e.totalSeconds)
      detail = this.t('processed', { done: duration(e.processedSeconds), total: duration(e.totalSeconds) });
    else if (e?.item !== undefined && e.items !== undefined) detail = this.t('processed', { done: e.item, total: e.items });
    const progress = h('progress', { max: 1, 'aria-label': label });
    if (fraction !== undefined) progress.value = Math.min(1, fraction);
    return h(
      'div',
      { className: 'progress', 'data-role': 'progress' },
      progress,
      h(
        'p',
        { className: 'progress-text' },
        label,
        detail ? ` — ${detail}` : '',
        e?.resource ? h('span', { className: 'resource-name' }, ` ${e.resource}`) : '',
      ),
    );
  }

  // ------------------------------------------------------------------ step 2 + 3
  private renderReview(): HTMLElement {
    const a = this.analysis!;
    const p = a.package!;
    const meta = h(
      'p',
      { className: 'project-meta' },
      h('strong', {}, p.title ?? a.input.name),
      ` — ${this.t(p.variant === 'v4' ? 'variantV4' : 'variantV3')}, ${this.t('pagesComponents', { pages: p.pages, components: p.components })}, ${bytes(a.input.size, this.lang)}`,
    );
    const review = this.section('step2', meta, this.renderWeight(a), this.renderDiagnostics(a.diagnostics), this.renderInventory(a.entries));
    const options = this.renderOptions();
    return h('div', { className: 'layout' }, review, options);
  }

  private renderWeight(a: AnalysisResult): HTMLElement {
    const other = Math.max(0, a.totals.uncompressedBytes - a.totals.videoBytes - a.totals.imageBytes - a.totals.audioBytes);
    const parts: [string, number, string][] = [
      ['video', a.totals.videoBytes, 'seg-video'],
      ['images', a.totals.imageBytes, 'seg-image'],
      ['audio', a.totals.audioBytes, 'seg-audio'],
      ['other', other, 'seg-other'],
    ];
    const total = Math.max(
      1,
      parts.reduce((s, x) => s + x[1], 0),
    );
    const bar = h('div', { className: 'weight-bar', role: 'img', 'aria-label': parts.map(([k, v]) => `${this.t(k)} ${bytes(v, this.lang)}`).join(', ') });
    const legend = h('ul', { className: 'weight-legend' });
    for (const [key, value, cls] of parts) {
      if (value === 0) continue;
      const seg = h('span', { className: `seg ${cls}` });
      seg.style.flexGrow = String(value / total);
      bar.append(seg);
      legend.append(
        h(
          'li',
          {},
          h('span', { className: `swatch ${cls}`, 'aria-hidden': 'true' }),
          `${this.t(key)} `,
          h('span', { className: 'num' }, bytes(value, this.lang)),
        ),
      );
    }
    return h('figure', { className: 'weight' }, h('figcaption', {}, this.t('weight')), bar, legend);
  }

  private renderDiagnostics(list: readonly Diagnostic[]): HTMLElement {
    const count = (s: string): number => list.filter((d) => d.severity === s).length;
    const visible = list.filter((d) => d.severity !== 'info' || d.code === 'external-reference' || d.code === 'duplicate-content');
    const summary =
      list.length === 0 ? this.t('problemsNone') : this.t('problemsCount', { errors: count('error'), warnings: count('warning'), info: count('info') });
    const items = h('ul', { className: 'diagnostics' });
    for (const d of visible.slice(0, 200)) {
      const l = d.location;
      const where = l ? [l.pageName, l.ideviceType, l.field, l.jsonPath, l.entry !== 'content.xml' ? l.entry : undefined].filter(Boolean).join(' › ') : '';
      items.append(
        h(
          'li',
          { className: `diag diag-${d.severity}` },
          h('span', { className: 'diag-code' }, d.code),
          ' ',
          d.message,
          where ? h('span', { className: 'diag-where' }, ` (${where})`) : '',
        ),
      );
    }
    return h('details', { className: 'problems', open: count('error') > 0 }, h('summary', {}, `${this.t('problems')}: ${summary}`), items);
  }

  private renderInventory(entries: readonly InventoryEntry[]): HTMLElement {
    const rows = entries.filter((e) => e.role === 'user-asset' || e.path === 'screenshot.png');
    const dir = this.sort.dir;
    const key = this.sort.key;
    rows.sort((x, y) => {
      const a = key === 'size' ? x.size : key === 'kind' ? x.kind : key === 'usage' ? x.usage : x.path;
      const b = key === 'size' ? y.size : key === 'kind' ? y.kind : key === 'usage' ? y.usage : y.path;
      return (a < b ? -1 : a > b ? 1 : 0) * dir;
    });
    const header = (k: SortKey, labelKey: string): HTMLElement => {
      const active = this.sort.key === k;
      return h(
        'th',
        { scope: 'col', 'aria-sort': active ? (dir === 1 ? 'ascending' : 'descending') : 'none' },
        h(
          'button',
          { type: 'button', className: 'sort', 'aria-label': this.t('sortBy', { column: this.t(labelKey) }), onclick: () => this.setSort(k) },
          this.t(labelKey),
          active ? (dir === 1 ? ' ▲' : ' ▼') : '',
        ),
      );
    };
    const body = h('tbody');
    for (const e of rows) {
      const optimizable = e.kind === 'image' || e.kind === 'video';
      const box = optimizable
        ? h('input', {
            type: 'checkbox',
            checked: !this.excluded.has(e.path),
            'aria-label': this.t('keepOriginal', { name: e.path }),
            onchange: (ev: Event) => {
              if ((ev.target as HTMLInputElement).checked) this.excluded.delete(e.path);
              else this.excluded.add(e.path);
            },
          })
        : '';
      body.append(
        h(
          'tr',
          {},
          h('th', { scope: 'row', className: 'path' }, e.path.replace(/^content\/resources\//, '')),
          h('td', {}, e.format),
          h('td', { className: 'num' }, bytes(e.size, this.lang)),
          h('td', { className: 'details' }, this.details(e)),
          h('td', {}, h('span', { className: `usage usage-${e.usage}` }, this.t(`usage_${e.usage}`))),
          h('td', { className: 'center' }, box),
        ),
      );
    }
    const table = h(
      'table',
      { className: 'inventory' },
      h('caption', {}, this.t('resources')),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          header('path', 'colName'),
          header('kind', 'colType'),
          header('size', 'colSize'),
          h('th', { scope: 'col' }, this.t('colDetails')),
          header('usage', 'colUsage'),
          h('th', { scope: 'col' }, this.t('colOptimize')),
        ),
      ),
      body,
    );
    return h('div', { className: 'table-wrap', tabindex: 0, role: 'region', 'aria-label': this.t('resources') }, table);
  }

  private details(e: InventoryEntry): string {
    if (e.video) {
      const v = e.video;
      const audio = v.audio.map((x) => `${x.codec}${x.language && x.language !== 'und' ? ` ${x.language}` : ''}`).join(', ');
      return `${v.videoCodec ?? '?'} ${v.width ?? '?'}×${v.height ?? '?'}, ${duration(v.duration)}${audio ? `, ${audio}` : ''}${v.subtitles ? `, ${v.subtitles} subt.` : ''}`;
    }
    if (e.kind === 'video') return this.t('notProbed');
    if (e.image) return `${e.image.width ?? '?'}×${e.image.height ?? '?'}${e.image.animated ? `, ${this.t('animated')}` : ''}`;
    return '';
  }

  private setSort(key: SortKey): void {
    this.sort = this.sort.key === key ? { key, dir: this.sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'size' ? -1 : 1 };
    // Sorting is only offered by the table of the review step.
    this.main.querySelector('.table-wrap')!.replaceWith(this.renderInventory(this.analysis!.entries));
  }

  private renderOptions(): HTMLElement {
    const o = this.options;
    const form = h('form', { className: 'options', 'aria-labelledby': 'h-step3' });
    const presets = h('fieldset', {}, h('legend', {}, this.t('preset')));
    for (const p of ['conservative', 'balanced', 'aggressive'] as const) {
      presets.append(
        h(
          'label',
          { className: 'radio' },
          h('input', { type: 'radio', name: 'preset', value: p, checked: o.preset === p }),
          h('span', {}, h('strong', {}, this.t(`preset_${p}`)), h('span', { className: 'help' }, this.t(`preset_${p}_help`))),
        ),
      );
    }
    const num = (name: string, label: string, min: number, max: number, value: number | undefined): HTMLElement =>
      h(
        'label',
        { className: 'field' },
        h('span', {}, this.t(label)),
        h('input', { type: 'number', name, min, max, inputmode: 'numeric', value: value ?? '' }),
      );
    const check = (name: string, label: string, checked: boolean): HTMLElement =>
      h('label', { className: 'check' }, h('input', { type: 'checkbox', name, checked }), h('span', {}, this.t(label)));
    const res = h('select', { name: 'maxResolution' });
    res.append(h('option', { value: 'profile', selected: o.video?.maxResolution === undefined }, this.t('byPreset')));
    for (const r of ['original', '2160', '1440', '1080', '720', '480', '360']) {
      res.append(h('option', { value: r, selected: String(o.video?.maxResolution ?? '') === r }, r === 'original' ? this.t('original') : `${r}p`));
    }
    const advanced = h(
      'details',
      { className: 'advanced' },
      h('summary', {}, this.t('advanced')),
      check('video', 'videoEnabled', o.video?.enabled !== false),
      h('label', { className: 'field' }, h('span', {}, this.t('videoResolution')), res),
      num('crf', 'videoQuality', 16, 35, o.video?.crf),
      num('audioBitrate', 'audioBitrate', 64, 320, o.video?.audioBitrate),
      check('images', 'imagesEnabled', o.images?.enabled !== false),
      num('jpegQuality', 'jpegQuality', 30, 100, o.images?.jpegQuality),
      num('webpQuality', 'webpQuality', 30, 100, o.images?.webpQuality),
      num('maxDimension', 'maxDimension', 64, 20000, o.images?.maxDimension ?? undefined),
      check('png', 'optimizePng', o.images?.png !== false),
      check('stripMetadata', 'stripMetadata', o.images?.stripMetadata === true),
      check('includeScreenshot', 'includeScreenshot', o.images?.includeScreenshot === true),
      check('multithread', 'threadsMulti', this.threading !== 'single'),
    );
    const cleanup = h(
      'fieldset',
      {},
      h('legend', {}, this.t('cleanup')),
      check('removeUnused', 'removeUnused', o.removeUnused === 'safe'),
      check('deduplicate', 'deduplicate', o.deduplicate === 'exact'),
    );
    form.append(
      presets,
      h('p', { className: 'note' }, this.t('lossyNote')),
      cleanup,
      advanced,
      h('button', { type: 'submit', className: 'button primary' }, this.t('reviewPlan')),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.makePlan(form);
    });
    return h(
      'aside',
      { className: 'panel', 'aria-labelledby': 'h-step3' },
      h('h2', { id: 'h-step3', tabindex: -1 }, h('span', { className: 'step-number' }, '3'), this.t('step3')),
      form,
    );
  }

  /** Reads the options form into OptionsInput. */
  readOptions(form: HTMLFormElement): OptionsInput {
    const data = new FormData(form);
    const n = (k: string): number | undefined => {
      const v = String(data.get(k) ?? '').trim();
      return v === '' ? undefined : Number(v);
    };
    const on = (k: string): boolean => data.get(k) !== null;
    const video: NonNullable<OptionsInput['video']> = { enabled: on('video') };
    const res = String(data.get('maxResolution') ?? '');
    if (res && res !== 'profile') video.maxResolution = res;
    const crf = n('crf');
    if (crf !== undefined) video.crf = crf;
    const ab = n('audioBitrate');
    if (ab !== undefined) video.audioBitrate = ab;
    const images: NonNullable<OptionsInput['images']> = {
      enabled: on('images'),
      png: on('png'),
      stripMetadata: on('stripMetadata'),
      includeScreenshot: on('includeScreenshot'),
    };
    const jq = n('jpegQuality');
    if (jq !== undefined) images.jpegQuality = jq;
    const wq = n('webpQuality');
    if (wq !== undefined) images.webpQuality = wq;
    const md = n('maxDimension');
    if (md !== undefined) images.maxDimension = md;
    this.threading = on('multithread') ? 'auto' : 'single';
    return {
      preset: String(data.get('preset') ?? 'balanced') as OptionsInput['preset'],
      video,
      images,
      removeUnused: on('removeUnused') ? 'safe' : 'off',
      deduplicate: on('deduplicate') ? 'exact' : 'off',
      exclude: [...this.excluded],
    };
  }

  private async makePlan(form: HTMLFormElement): Promise<void> {
    const options = this.readOptions(form);
    this.options = options;
    try {
      this.plan = await this.pipeline.plan(options);
      this.go('plan');
    } catch (error) {
      this.showError((error as { code?: string }).code ?? 'error', (error as Error).message);
    }
  }

  // ------------------------------------------------------------------ step 4
  private renderPlan(): HTMLElement {
    const plan = this.plan!;
    const ops = h('ul', { className: 'plan-ops' });
    for (const op of plan.operations) {
      let text: string;
      if (op.op === 'transcode-video' || op.op === 'recompress-image')
        text = `${op.path.replace(/^content\/resources\//, '')} (${bytes(op.size, this.lang)}): ${op.conversions.join('; ')}`;
      else if (op.op === 'remove-unused') text = `${op.path} — ${op.reason}`;
      else if (op.op === 'deduplicate') text = `${op.keep} ← ${op.remove.join(', ')}`;
      else text = `${op.path}: ${op.reason}`;
      ops.append(h('li', { className: `op op-${op.op}` }, h('span', { className: 'op-kind' }, op.op), ' ', text));
    }
    const skipped = h('ul', { className: 'plan-skipped' });
    for (const s of plan.skipped.slice(0, 200)) skipped.append(h('li', {}, `${s.path.replace(/^content\/resources\//, '')}: ${s.detail}`));
    const actionable = plan.operations.length > 0;
    return this.section(
      'step4',
      actionable ? h('h3', {}, this.t('planOps')) : h('p', {}, this.t('planEmpty')),
      actionable ? ops : false,
      actionable ? h('p', { className: 'estimate' }, this.t('estimate', { size: bytes(plan.estimate.savedBytes, this.lang) })) : false,
      plan.skipped.length > 0 ? h('details', {}, h('summary', {}, `${this.t('planSkipped')} (${plan.skipped.length})`), skipped) : false,
      ...plan.risks.map((r) => h('p', { className: 'note' }, r)),
      h(
        'div',
        { className: 'actions' },
        h('button', { type: 'button', className: 'button primary', onclick: () => void this.run(), disabled: !actionable }, this.t('optimize')),
        h('button', { type: 'button', className: 'button', onclick: () => this.go('review') }, this.t('changeOptions')),
      ),
    );
  }

  // ------------------------------------------------------------------ step 5
  private renderStages(): HTMLElement {
    const current = this.progress?.stage;
    const list = h('ol', { className: 'stages', 'data-role': 'stages' });
    for (const s of STAGES)
      list.append(h('li', { className: s === current ? 'is-current' : '', 'aria-current': s === current ? 'step' : undefined }, this.t(`stage_${s}`)));
    return list;
  }

  private renderRunning(): HTMLElement {
    const cancel = h(
      'button',
      { type: 'button', className: 'button danger', onclick: () => void this.cancel(), disabled: this.cancelling },
      this.t(this.cancelling ? 'cancelling' : 'cancel'),
    );
    return this.section('step5', this.renderStages(), this.renderProgressBar(), h('div', { className: 'actions' }, cancel));
  }

  private async run(): Promise<void> {
    const plan = this.plan!;
    this.cancelling = false;
    this.progress = undefined;
    this.go('running');
    try {
      this.result = await this.pipeline.optimize(plan.planHash, (e) => this.onProgress(e));
      this.announce(this.t(`status_${this.result.report.status}`));
      this.go('result');
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'error';
      if (code === 'cancelled') {
        this.result = undefined;
        this.errorCode = 'cancelled';
        this.errorMessage = this.t('status_cancelled');
        this.go('error');
      } else this.showError(code, (error as Error).message);
    }
  }

  private async cancel(): Promise<void> {
    this.cancelling = true;
    this.render();
    await this.pipeline.cancel();
  }

  // ------------------------------------------------------------------ step 6
  private renderResult(): HTMLElement {
    const { report, output, fileName } = this.result!;
    const s = report.sizes;
    const children: (Node | false)[] = [h('p', { className: `result-status status-${report.status}` }, this.t(`status_${report.status}`))];
    // Never imply that videos were optimized when every planned one kept its original.
    const videos = report.operations.filter((o) => o.op === 'transcode-video');
    if (videos.length > 0 && !videos.some((o) => o.status === 'applied')) children.push(h('p', { className: 'callout', role: 'note' }, this.t('videosKept')));
    if (output) {
      const max = Math.max(s.before, s.after, 1);
      const bar = (label: string, value: number, cls: string): HTMLElement => {
        const fill = h('span', { className: `fill ${cls}` });
        fill.style.width = `${(value / max) * 100}%`;
        return h(
          'div',
          { className: 'compare-row' },
          h('span', { className: 'compare-label' }, label),
          h('span', { className: 'compare-track' }, fill),
          h('span', { className: 'num' }, bytes(value, this.lang)),
        );
      };
      children.push(h('div', { className: 'compare' }, bar(this.t('before'), s.before, 'fill-before'), bar(this.t('after'), s.after, 'fill-after')));
      if (s.saved > 0)
        children.push(h('p', { className: 'saved' }, this.t('saved', { size: bytes(s.saved, this.lang), percent: percent(s.saved / s.before, this.lang) })));
      const url = this.urls.createObjectURL(output);
      const reportUrl = this.urls.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      this.objectUrls.push(url, reportUrl);
      children.push(
        h(
          'div',
          { className: 'actions' },
          h('a', { className: 'button primary', href: url, download: fileName, 'data-testid': 'download' }, this.t('download', { name: fileName })),
          h(
            'a',
            { className: 'button', href: reportUrl, download: fileName.replace(/\.elpx$/, '_report.json'), 'data-testid': 'download-report' },
            this.t('downloadReport'),
          ),
        ),
      );
    }
    children.push(this.renderOperationResults(report));
    children.push(h('div', { className: 'actions' }, h('button', { type: 'button', className: 'button', onclick: () => this.reset() }, this.t('another'))));
    return this.section('step6', ...children);
  }

  private renderOperationResults(report: OptimizationReport): HTMLElement {
    const list = h('ul', { className: 'op-results' });
    for (const o of report.operations) {
      const sizes = o.before !== undefined && o.after !== undefined ? ` ${bytes(o.before, this.lang)} → ${bytes(o.after, this.lang)}` : '';
      list.append(
        h(
          'li',
          { className: `op-result op-${o.status}` },
          h('span', { className: 'op-status' }, this.t(o.status === 'applied' ? 'applied' : o.status === 'failed' ? 'failed' : 'reverted')),
          ` ${o.path.replace(/^content\/resources\//, '')}${sizes}`,
          o.detail ? h('span', { className: 'op-detail' }, ` — ${o.detail}`) : '',
        ),
      );
    }
    return list;
  }

  // ------------------------------------------------------------------ errors
  private showError(code: string, message: string): void {
    this.errorCode = code;
    this.errorMessage = message;
    this.go('error');
  }

  private renderError(): HTMLElement {
    return h(
      'section',
      { className: 'step step-error', 'aria-labelledby': 'h-error', role: 'alert' },
      h('h2', { id: 'h-error', tabindex: -1 }, this.t(this.errorCode === 'cancelled' ? 'stage_done' : 'errorTitle')),
      h('p', {}, this.errorMessage),
      this.errorCode === 'legacy-elp' ? h('p', {}, this.t('legacyHelp')) : false,
      h('div', { className: 'actions' }, h('button', { type: 'button', className: 'button primary', onclick: () => this.reset() }, this.t('tryAgain'))),
    );
  }

  private revokeUrls(): void {
    for (const u of this.objectUrls) this.urls.revokeObjectURL(u);
    this.objectUrls = [];
  }

  /** Returns to the first step, releasing downloads. */
  reset(): void {
    this.revokeUrls();
    this.file = undefined;
    this.analysis = undefined;
    this.plan = undefined;
    this.result = undefined;
    this.go('start');
  }

  /** Current view (for tests and debugging). */
  get currentView(): View {
    return this.view;
  }
}
