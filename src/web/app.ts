import type { AnalysisResult, InventoryEntry, ReferenceRecord } from '../core/analyze/model.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ProgressEvent } from '../core/media/engine.js';
import type { OptionsInput } from '../core/plan/options.js';
import type { OptimizationPlan, PlanOperation } from '../core/plan/plan.js';
import type { OperationResult, OptimizationReport } from '../core/report/report.js';
import type { EngineStatus } from '../adapters/browser/protocol.js';
import type { OptimizeResult } from '../adapters/browser/pipeline-client.js';
import type { ThreadingPreference } from '../adapters/browser/ffmpeg-loader.js';
import { h, replace } from './dom.js';
import { bytes, duration, percent } from './format.js';
import { translate, type Lang } from './i18n.js';
import { icon, type IconName } from './icons.js';
import ateLogo from './assets/ate-logo.png';
import { COMPONENTS } from './licenses.js';
import { cleanFileName } from '../core/refs/slug.js';
import { TOOL_VERSION } from '../core/version.js';
import { screenshotProblem } from '../core/format/screenshot.js';
import { sha256Hex } from '../core/io/hash.js';
import { renderFirstPage, ScreenshotError, thumbnailFromImage } from './screenshot.js';

/** What the UI needs from the pipeline (the real client or a test double). */
export interface PipelineApi {
  analyze(file: File, onProgress?: (e: ProgressEvent) => void, threading?: ThreadingPreference): Promise<AnalysisResult>;
  plan(options: OptionsInput): Promise<OptimizationPlan>;
  /** Returns an image, audio or video of the analyzed project for a local preview (optional). */
  preview?(path: string): Promise<Blob>;
  /** Returns any file of the analyzed project as untyped bytes, to draw a new thumbnail (optional). */
  read?(path: string): Promise<Blob | undefined>;
  optimize(planHash: string, onProgress?: (e: ProgressEvent) => void, screenshot?: Blob): Promise<OptimizeResult>;
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
type Child = Node | string | false | undefined;

const REPO_URL = 'https://github.com/ateeducacion/elpx-optimizer';
const ATE_URL = 'https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/';
const SKILL_URL = `${REPO_URL}/blob/main/skills/elpx-optimizer/SKILL.md`;
const CLI_DOCS_URL = `${REPO_URL}/blob/main/docs/cli.md`;
const SKILL_DOCS_URL = `${REPO_URL}/blob/main/docs/skill.md`;

const STAGES = ['engine-load', 'extract', 'transcode', 'encode-image', 'pdf', 'validate', 'package', 'verify'] as const;

/** The stepper position of each view (1-based; 0 hides the current marker). */
const VIEW_STEP: Record<View, number> = { start: 1, analyzing: 1, review: 2, plan: 3, running: 4, result: 4, error: 0 };

/** Order and icon of plan operations, as shown in the plan. */
const OP_ORDER: readonly [PlanOperation['op'], IconName][] = [
  ['transcode-video', 'camera-video'],
  ['recompress-image', 'image'],
  ['transcode-audio', 'music-note-beamed'],
  ['optimize-pdf', 'file-earmark-pdf'],
  ['remove-unused', 'trash3'],
  ['deduplicate', 'files'],
  ['move-resource', 'folder-symlink'],
  ['rename-resource', 'pencil-square'],
  ['remove-missing-reference', 'eraser'],
  ['rewrite-references', 'pencil-square'],
  ['update-manifest', 'file-earmark'],
  ['replace-screenshot', 'image'],
];

const USAGE_BADGE: Record<InventoryEntry['usage'], string> = {
  used: 'bg-success-subtle text-success-emphasis',
  uncertain: 'bg-warning-subtle text-warning-emphasis',
  protected: 'bg-info-subtle text-info-emphasis',
  unreferenced: 'bg-secondary-subtle text-secondary-emphasis',
  'not-applicable': 'bg-body-tertiary text-body-secondary',
};

/** Broken references the "remove broken references" option can take out. */
export function brokenReferences(refs: readonly ReferenceRecord[]): ReferenceRecord[] {
  return refs.filter(
    (r) =>
      r.kind === 'explicit' &&
      (r.representation === 'editable' || r.representation === 'published' || r.representation === 'search-index') &&
      (r.status === 'missing' || r.status === 'unmapped' || (r.status === 'unresolvable' && r.form === 'local-file')),
  );
}

/** Strips the common resource folder from a path for display. */
function short(path: string): string {
  return path.replace(/^content\/resources\//, '');
}

/**
 * The single-page application. Views follow the sequence: choose file,
 * review contents and choose options, confirm plan, progress, result.
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
  // Clean file names are on by default in the web app (the CLI keeps names unless asked).
  private options: OptionsInput = { preset: 'balanced', normalizeNames: 'slug' };
  private threading: ThreadingPreference;
  private cancelling = false;
  private objectUrls: string[] = [];
  /** The new screenshot.png chosen in the options. */
  private screenshot: { readonly blob: Blob; readonly url: string; readonly sha256: string; readonly size: number } | undefined;
  private readonly main: HTMLElement;
  private readonly stepper: HTMLElement;
  private readonly engineLine: HTMLElement;
  private readonly status: HTMLElement;
  private licensesPanel: HTMLDialogElement | undefined;
  private helpPanel: HTMLDialogElement | undefined;
  /** The audio being previewed from the resources table, if any. */
  private player: { readonly path: string; readonly audio: HTMLAudioElement; readonly url: string } | undefined;
  /** Counter of preview requests: an answer that is no longer the latest one is dropped. */
  private previewRequest = 0;

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
    this.stepper = h('nav', { className: 'stepper-nav' });
    this.engineLine = h('p', { className: 'engine-line small mb-0', 'aria-live': 'polite' });
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
      { className: 'app-header navbar bg-body border-bottom' },
      h(
        'div',
        { className: 'container-lg gap-2 flex-nowrap' },
        h(
          'div',
          { className: 'navbar-brand d-flex align-items-center gap-2 me-auto text-wrap' },
          h('span', { className: 'brand-mark' }, icon('feather')),
          h('h1', { className: 'brand-title mb-0' }, this.t('title')),
        ),
        h(
          'div',
          { className: 'header-actions d-flex align-items-center gap-2' },
          h(
            'a',
            {
              href: SKILL_URL,
              target: '_blank',
              rel: 'noopener noreferrer',
              className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
              title: this.t('skillLink'),
              'aria-label': this.t('skillLink'),
            },
            icon('robot'),
            h('span', { className: 'd-none d-md-inline' }, 'SKILL.md'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 help-button',
              'aria-haspopup': 'dialog',
              title: this.t('helpTitle'),
              onclick: () => this.helpPanel?.showModal(),
            },
            icon('terminal'),
            h('span', { className: 'd-none d-md-inline' }, this.t('helpButton')),
            h('span', { className: 'visually-hidden d-md-none' }, this.t('helpTitle')),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
              'aria-label': this.t('languageLabel'),
              onclick: () => this.switchLanguage(),
            },
            icon('translate'),
            this.t('language'),
          ),
        ),
      ),
    );
    const body = h('div', { className: 'container-lg app-body' }, this.stepper, this.engineLine, this.main, this.status);
    this.licensesPanel = this.renderLicenses();
    this.helpPanel = this.renderHelp();
    replace(this.root, header, body, this.renderFooter(), this.licensesPanel, this.helpPanel);
    this.renderEngine();
    this.render();
  }

  private renderFooter(): HTMLElement {
    const external = { target: '_blank', rel: 'noopener noreferrer' };
    return h(
      'footer',
      { className: 'app-footer border-top bg-body' },
      h(
        'div',
        { className: 'container-lg d-flex flex-column flex-md-row align-items-center justify-content-between gap-3' },
        h(
          'a',
          { ...external, href: ATE_URL, className: 'ate-link d-flex align-items-center gap-3 text-reset', 'aria-label': this.t('ateLink') },
          h('img', { src: ateLogo, alt: '', className: 'ate-logo', width: 40, height: 41 }),
          h('span', {}, this.t('footerMadeBy')),
        ),
        h(
          'div',
          { className: 'd-flex flex-wrap align-items-center justify-content-center gap-3 small' },
          h(
            'a',
            { ...external, href: REPO_URL, className: 'github-link d-inline-flex align-items-center gap-2', 'aria-label': this.t('sourceCodeLink') },
            icon('github', 'fs-5'),
            this.t('sourceCode'),
          ),
          h(
            'a',
            {
              ...external,
              href: `${REPO_URL}/releases/tag/v${TOOL_VERSION}`,
              className: 'version-link',
              'aria-label': this.t('versionLink', { version: TOOL_VERSION }),
            },
            `v${TOOL_VERSION}`,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-link btn-sm p-0 licenses-button',
              'aria-haspopup': 'dialog',
              onclick: () => this.licensesPanel?.showModal(),
            },
            this.t('licensesButton'),
          ),
          h('span', { className: 'text-body-secondary' }, this.t('license')),
        ),
      ),
    );
  }

  /** Side panel with the licenses of the app and of every bundled component. */
  private renderLicenses(): HTMLDialogElement {
    const external = { target: '_blank', rel: 'noopener noreferrer' };
    const list = h('ul', { className: 'list-group list-group-flush licenses-list' });
    for (const c of COMPONENTS) {
      list.append(
        h(
          'li',
          { className: 'list-group-item px-0' },
          h(
            'div',
            { className: 'd-flex justify-content-between align-items-baseline gap-2' },
            h('strong', {}, c.name),
            h('span', { className: 'badge rounded-pill bg-primary-subtle text-primary-emphasis flex-none' }, c.license),
          ),
          h('div', { className: 'small text-body-secondary' }, this.t(c.role), c.version !== '—' ? ` · ${c.version}` : ''),
          h(
            'a',
            { ...external, href: `licenses/${c.file}`, className: 'small', 'aria-label': this.t('viewLicense', { name: c.name }) },
            this.t('viewLicenseShort'),
          ),
        ),
      );
    }
    return this.sidePanel(
      'licenses',
      this.t('licensesTitle'),
      h('p', {}, this.t('licensesIntro')),
      h(
        'div',
        { className: 'd-flex flex-wrap gap-2 mb-4' },
        h('a', { ...external, href: 'licenses/elpx-optimizer-AGPL-3.0.txt', className: 'btn btn-sm btn-outline-primary' }, this.t('licensesApp')),
        h(
          'a',
          { ...external, href: REPO_URL, className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1' },
          icon('github'),
          this.t('sourceCode'),
        ),
      ),
      h('h3', { className: 'h6' }, this.t('licensesComponents')),
      list,
      h('div', { className: 'alert alert-secondary small mt-4', role: 'note' }, this.t('licensesGpl')),
      h('p', { className: 'small' }, h('a', { ...external, href: 'licenses/THIRD-PARTY-NOTICES.txt' }, this.t('licensesAll'))),
      h(
        'p',
        { className: 'small text-body-secondary d-flex align-items-center gap-2 mb-0' },
        h('img', { src: ateLogo, alt: '', className: 'ate-logo', width: 28, height: 29 }),
        this.t('licensesAte'),
      ),
    );
  }

  /** A panel that slides in from the side (a modal dialog: Escape and the backdrop close it). */
  private sidePanel(id: string, title: string, ...children: Child[]): HTMLDialogElement {
    const dialog = h(
      'dialog',
      { className: `side-panel ${id}-panel`, 'aria-labelledby': `${id}-title` },
      h(
        'div',
        { className: 'side-panel-header d-flex align-items-center justify-content-between border-bottom' },
        h('h2', { id: `${id}-title`, className: 'h5 mb-0', tabindex: -1, autofocus: true }, title),
        h('button', { type: 'button', className: 'btn-close', 'aria-label': this.t('close'), onclick: () => dialog.close() }),
      ),
      h('div', { className: 'side-panel-body' }, ...children),
    );
    // A click on the backdrop reaches the dialog itself: close, as Bootstrap's offcanvas does.
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close();
    });
    return dialog;
  }

  /** How to use the command-line version and the Agent Skill. */
  private renderHelp(): HTMLDialogElement {
    const external = { target: '_blank', rel: 'noopener noreferrer' };
    const cli = 'npx elpx-optimizer';
    const docker = 'docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ghcr.io/ateeducacion/elpx-optimizer';
    const step = (title: string, code?: string, note?: string): HTMLElement =>
      h(
        'li',
        { className: 'mb-3' },
        h('span', { className: 'fw-bold d-block mb-1' }, title),
        code ? this.codeBlock(code) : false,
        note ? h('span', { className: 'small text-body-secondary' }, note) : false,
      );
    return this.sidePanel(
      'help',
      this.t('helpTitle'),
      h('h3', { className: 'h6 d-flex align-items-center gap-2' }, icon('terminal'), this.t('helpCliTitle')),
      h('p', { className: 'small' }, this.t('helpCliIntro')),
      h('h4', { className: 'h6 mt-3' }, this.t('helpDockerTitle')),
      h('p', { className: 'small' }, this.t('helpDocker')),
      h(
        'ol',
        { className: 'help-steps ps-3' },
        step(this.t('helpStep4'), `${docker} inspect /work/curso.elpx`),
        step(this.t('helpStep5'), `${docker} optimize /work/curso.elpx --dry-run`),
        step(this.t('helpStep6'), `${docker} optimize /work/curso.elpx \\\n  --remove-unused safe --deduplicate exact`, this.t('helpStep6Note')),
      ),
      h('p', { className: 'small text-body-secondary' }, this.t('helpDockerWindows')),
      h('h4', { className: 'h6 mt-4' }, this.t('helpNpxTitle')),
      h('p', { className: 'small' }, this.t('helpNpx')),
      h(
        'ol',
        { className: 'help-steps ps-3' },
        step(this.t('helpStep1'), 'sudo apt install ffmpeg      # Ubuntu\nbrew install ffmpeg          # macOS', this.t('helpStep1Note')),
        step(this.t('helpStep3'), `${cli} doctor`),
        step(this.t('helpStep4'), `${cli} inspect curso.elpx`),
        step(this.t('helpStep5'), `${cli} optimize curso.elpx --dry-run`),
        step(
          this.t('helpStep6'),
          `${cli} optimize curso.elpx --preset balanced \\\n  --remove-unused safe --deduplicate exact \\\n  --flatten legacy --missing-references remove`,
          this.t('helpStep6Note'),
        ),
      ),
      h('p', {}, h('a', { ...external, href: CLI_DOCS_URL }, this.t('helpCliDocs'))),
      h('hr', { className: 'my-4' }),
      h('h3', { className: 'h6 d-flex align-items-center gap-2' }, icon('robot'), this.t('helpSkillTitle')),
      h('p', { className: 'small' }, this.t('helpSkillIntro')),
      this.codeBlock('make build-skill\ncp -r dist/skill/elpx-optimizer ~/.claude/skills/'),
      h('p', { className: 'small text-body-secondary' }, this.t('helpSkillNote')),
      h(
        'div',
        { className: 'd-flex flex-wrap gap-2' },
        h('a', { ...external, href: SKILL_URL, className: 'btn btn-sm btn-outline-primary d-inline-flex align-items-center gap-1' }, icon('robot'), 'SKILL.md'),
        h('a', { ...external, href: SKILL_DOCS_URL, className: 'btn btn-sm btn-outline-secondary' }, this.t('helpSkillDocs')),
      ),
    );
  }

  /** A command block with a copy button. */
  private codeBlock(code: string): HTMLElement {
    const copy = h(
      'button',
      {
        type: 'button',
        className: 'btn btn-sm btn-light copy-button',
        'aria-label': this.t('copy'),
        title: this.t('copy'),
        onclick: () => {
          void navigator.clipboard?.writeText(code).then(
            () => {
              replace(copy, icon('clipboard-check'));
              this.announce(this.t('copied'));
            },
            () => undefined,
          );
        },
      },
      icon('clipboard'),
    );
    return h('div', { className: 'code-block' }, h('pre', { className: 'mb-0' }, h('code', {}, code)), copy);
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

  private renderStepper(): void {
    const current = VIEW_STEP[this.view];
    const list = h('ol', { className: 'stepper' });
    for (let i = 1; i <= 4; i++) {
      const state = i < current ? 'is-done' : i === current ? 'is-current' : '';
      list.append(
        h(
          'li',
          { className: `stepper-item ${state}`, 'aria-current': i === current ? 'step' : undefined },
          h('span', { className: 'stepper-dot', 'aria-hidden': 'true' }, i < current ? icon('check-circle-fill') : String(i)),
          h('span', { className: 'stepper-label' }, this.t(`nav_step${i}`)),
        ),
      );
    }
    this.stepper.setAttribute('aria-label', this.t('stepsLabel'));
    replace(this.stepper, list);
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
    if (this.view !== 'review') this.stopAudio();
    this.renderStepper();
    switch (this.view) {
      case 'start':
        replace(this.main, this.renderPicker());
        break;
      case 'analyzing':
        replace(
          this.main,
          this.section(
            'step2',
            this.t('analyzingTitle'),
            h('p', { className: 'text-body-secondary' }, this.t('analyzing', { name: this.file!.name })),
            this.renderProgressBar(),
          ),
        );
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

  /** A step as a card whose heading receives focus when the step opens. */
  private section(stepKey: StepKey, title: string, ...children: Child[]): HTMLElement {
    return h(
      'section',
      { className: `step step-${stepKey} card`, 'aria-labelledby': `h-${stepKey}` },
      h('div', { className: 'card-body' }, h('h2', { id: `h-${stepKey}`, tabindex: -1, className: 'h4 mb-3' }, title), ...children),
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
      h('span', { className: 'dropzone-icon' }, icon('file-earmark-arrow-up')),
      h('p', { className: 'drop-title h5 mb-1' }, this.t('drop')),
      h('p', { className: 'drop-or text-body-secondary mb-2' }, this.t('or')),
      h(
        'label',
        {
          for: 'file-input',
          className: 'btn btn-primary btn-lg px-4',
          tabindex: 0,
          role: 'button',
          onkeydown: (e: Event) => this.activateOnKey(e as KeyboardEvent, input),
        },
        this.t('choose'),
      ),
      input,
      h('p', { className: 'hint small text-body-secondary mt-3 mb-0' }, this.t('accepts')),
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
    const feature = (name: IconName, title: string, text: string): HTMLElement =>
      h(
        'li',
        { className: 'col feature d-flex gap-3' },
        h('span', { className: 'feature-icon' }, icon(name)),
        h('span', {}, h('strong', { className: 'd-block' }, this.t(title)), h('span', { className: 'text-body-secondary' }, this.t(text))),
      );
    return h(
      'section',
      { className: 'step step-step1 hero', 'aria-labelledby': 'h-step1' },
      h('h2', { id: 'h-step1', tabindex: -1, className: 'hero-title' }, this.t('heroTitle')),
      h('p', { className: 'lead hero-lead' }, this.t('heroLead')),
      zone,
      h(
        'ul',
        { className: 'features row row-cols-1 row-cols-md-3 g-4 list-unstyled mt-2 mb-0' },
        feature('shield-lock', 'featurePrivacyTitle', 'featurePrivacy'),
        feature('feather', 'featureLightTitle', 'featureLight'),
        feature('pencil-square', 'featureEditableTitle', 'featureEditable'),
      ),
    );
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
    this.dropScreenshot();
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
    const known = fraction !== undefined;
    const value = known ? Math.round(Math.min(1, fraction) * 100) : undefined;
    const fill = h('div', { className: `progress-bar${known ? '' : ' progress-bar-striped progress-bar-animated'}` });
    fill.style.width = `${value ?? 100}%`;
    const track = h(
      'div',
      {
        className: 'progress',
        role: 'progressbar',
        'aria-label': label,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': value,
        'aria-busy': known ? undefined : 'true',
      },
      fill,
    );
    return h(
      'div',
      { className: 'progress-block', 'data-role': 'progress' },
      track,
      h(
        'p',
        { className: 'progress-text small mt-2 mb-0' },
        h('strong', {}, label),
        detail ? ` — ${detail}` : '',
        e?.resource ? h('span', { className: 'resource-name text-body-secondary' }, ` ${e.resource}`) : '',
      ),
    );
  }

  // ------------------------------------------------------------------ step 2 + 3
  private renderReview(): HTMLElement {
    const a = this.analysis!;
    const p = a.package!;
    const broken = brokenReferences(a.references);
    const summary = h(
      'div',
      { className: 'project-meta d-flex flex-wrap align-items-center gap-2 mb-3' },
      h('b', { className: 'project-title me-1' }, p.title ?? a.input.name),
      h('span', { className: 'badge rounded-pill text-bg-light border' }, this.t(p.variant === 'v4' ? 'variantV4' : 'variantV3')),
      h('span', { className: 'badge rounded-pill text-bg-light border' }, this.t('pagesComponents', { pages: p.pages, components: p.components })),
      h('span', { className: 'badge rounded-pill text-bg-light border' }, bytes(a.input.size, this.lang)),
    );
    const alerts: Child[] = [];
    if (p.legacyFolders.files > 0) {
      alerts.push(
        this.alert(
          'info',
          'folder-symlink',
          this.t('legacyDetectedTitle'),
          this.t('legacyDetected', { files: p.legacyFolders.files, folders: p.legacyFolders.folders }),
          'legacy-alert',
        ),
      );
    }
    if (broken.length > 0) {
      alerts.push(this.alert('warning', 'eraser', this.t('brokenDetectedTitle'), this.t('brokenDetected', { count: broken.length }), 'broken-alert'));
    }
    const review = this.section(
      'step2',
      this.t('step2'),
      summary,
      this.renderWeight(a),
      ...alerts,
      this.renderDiagnostics(a.diagnostics),
      this.renderInventory(a.entries),
    );
    return h(
      'div',
      { className: 'row g-4 align-items-start' },
      h('div', { className: 'col-lg-8' }, review),
      h('div', { className: 'col-lg-4 options-col' }, this.renderOptions(broken.length)),
    );
  }

  private alert(kind: 'info' | 'warning', name: IconName, title: string, text: string, testId: string): HTMLElement {
    return h(
      'div',
      { className: `alert alert-${kind} d-flex gap-3 align-items-start`, 'data-testid': testId },
      h('span', { className: 'alert-icon' }, icon(name)),
      h('div', {}, h('strong', { className: 'd-block' }, title), h('span', {}, text)),
    );
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
    const legend = h('ul', { className: 'weight-legend list-unstyled d-flex flex-wrap gap-3 small mb-0 mt-2' });
    for (const [key, value, cls] of parts) {
      if (value === 0) continue;
      const seg = h('span', { className: `seg ${cls}` });
      seg.style.flexGrow = String(value / total);
      bar.append(seg);
      legend.append(
        h(
          'li',
          { className: 'd-flex align-items-center gap-2' },
          h('span', { className: `swatch ${cls}`, 'aria-hidden': 'true' }),
          `${this.t(key)} `,
          h('span', { className: 'num fw-bold' }, bytes(value, this.lang)),
        ),
      );
    }
    return h('figure', { className: 'weight mb-4' }, h('figcaption', { className: 'small text-body-secondary mb-2' }, this.t('weight')), bar, legend);
  }

  private renderDiagnostics(list: readonly Diagnostic[]): HTMLElement {
    const count = (s: string): number => list.filter((d) => d.severity === s).length;
    const visible = list.filter(
      (d) => d.severity !== 'info' || d.code === 'external-reference' || d.code === 'duplicate-content' || d.code === 'legacy-resource-folders',
    );
    const summary =
      list.length === 0 ? this.t('problemsNone') : this.t('problemsCount', { errors: count('error'), warnings: count('warning'), info: count('info') });
    const items = h('ul', { className: 'diagnostics list-group list-group-flush' });
    const badge: Record<string, string> = { fatal: 'text-bg-danger', error: 'text-bg-danger', warning: 'text-bg-warning', info: 'text-bg-info' };
    for (const d of visible.slice(0, 200)) {
      const l = d.location;
      const where = l ? [l.pageName, l.ideviceType, l.field, l.jsonPath, l.entry !== 'content.xml' ? l.entry : undefined].filter(Boolean).join(' › ') : '';
      items.append(
        h(
          'li',
          { className: `list-group-item diag diag-${d.severity}` },
          h('span', { className: `badge ${badge[d.severity] ?? 'text-bg-secondary'} me-2 diag-code` }, d.code),
          d.message,
          where ? h('span', { className: 'diag-where d-block small text-body-secondary' }, where) : '',
        ),
      );
    }
    return h(
      'details',
      { className: 'problems card mb-4', open: count('error') > 0 },
      h(
        'summary',
        { className: 'card-header d-flex align-items-center gap-2' },
        h('strong', {}, this.t('problems')),
        h('span', { className: 'text-body-secondary' }, summary),
      ),
      items,
    );
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
    const header = (k: SortKey, labelKey: string, className = ''): HTMLElement => {
      const active = this.sort.key === k;
      return h(
        'th',
        { scope: 'col', className, 'aria-sort': active ? (dir === 1 ? 'ascending' : 'descending') : 'none' },
        h(
          'button',
          {
            type: 'button',
            className: 'sort btn btn-link btn-sm p-0',
            'aria-label': this.t('sortBy', { column: this.t(labelKey) }),
            onclick: () => this.setSort(k),
          },
          this.t(labelKey),
          active ? (dir === 1 ? ' ▲' : ' ▼') : '',
        ),
      );
    };
    const body = h('tbody');
    for (const e of rows) {
      const pdf = e.format === 'pdf';
      const optimizable = e.kind === 'image' || e.kind === 'video' || e.kind === 'audio' || pdf;
      const box = optimizable
        ? h(
            'div',
            { className: 'form-check form-switch d-inline-block m-0' },
            h('input', {
              type: 'checkbox',
              role: 'switch',
              className: 'form-check-input',
              checked: !this.excluded.has(e.path),
              'aria-label': this.t('keepOriginal', { name: e.path }),
              onchange: (ev: Event) => {
                if ((ev.target as HTMLInputElement).checked) this.excluded.delete(e.path);
                else this.excluded.add(e.path);
              },
            }),
          )
        : '';
      const kindIcon: IconName =
        e.kind === 'video'
          ? 'camera-video'
          : e.kind === 'image'
            ? 'image'
            : e.kind === 'audio'
              ? 'music-note-beamed'
              : pdf
                ? 'file-earmark-pdf'
                : 'file-earmark';
      const lead = this.pipeline.preview && (e.kind === 'image' || e.kind === 'video' || e.kind === 'audio') ? this.previewButton(e) : undefined;
      body.append(
        h(
          'tr',
          {},
          h(
            'th',
            { scope: 'row', className: 'path fw-normal' },
            h(
              'span',
              { className: 'd-flex gap-2 align-items-baseline' },
              lead ?? h('span', { className: 'kind-icon text-body-secondary' }, icon(kindIcon)),
              h('span', {}, short(e.path)),
            ),
          ),
          h('td', {}, e.format),
          h('td', { className: 'num text-end' }, bytes(e.size, this.lang)),
          h('td', { className: 'details small text-body-secondary' }, this.details(e)),
          h('td', {}, h('span', { className: `badge usage usage-${e.usage} ${USAGE_BADGE[e.usage]}` }, this.t(`usage_${e.usage}`))),
          h('td', { className: 'text-center' }, box),
        ),
      );
    }
    const table = h(
      'table',
      { className: 'inventory table table-sm table-hover align-middle mb-0' },
      h('caption', { className: 'visually-hidden' }, this.t('resources')),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          header('path', 'colName'),
          header('kind', 'colType'),
          header('size', 'colSize', 'text-end'),
          h('th', { scope: 'col' }, this.t('colDetails')),
          header('usage', 'colUsage'),
          h('th', { scope: 'col', className: 'text-center' }, this.t('colOptimize')),
        ),
      ),
      body,
    );
    return h(
      'div',
      { className: 'inventory-card card' },
      h(
        'div',
        { className: 'card-header d-flex justify-content-between align-items-center' },
        h('h3', { className: 'h6 mb-0' }, this.t('resources')),
        h('span', { className: 'small text-body-secondary' }, this.t('filesCount', { count: rows.length })),
      ),
      h('div', { className: 'table-wrap table-responsive', tabindex: 0, role: 'region', 'aria-label': this.t('resources') }, table),
    );
  }

  /** Play/pause (audio) or open-in-a-window (image, video) button for a resource. */
  private previewButton(e: InventoryEntry): HTMLButtonElement {
    const audio = e.kind === 'audio';
    const playing = audio && this.player?.path === e.path && !this.player.audio.paused;
    const label = this.t(audio ? (playing ? 'pauseAudio' : 'playAudio') : e.kind === 'video' ? 'playVideo' : 'viewImage', { name: short(e.path) });
    const button = h(
      'button',
      {
        type: 'button',
        className: 'preview-button btn btn-sm btn-light rounded-circle',
        'aria-label': label,
        title: label,
        'data-path': e.path,
        'aria-pressed': audio ? String(playing) : undefined,
        onclick: () => void (audio ? this.toggleAudio(e, button) : this.openPreview(e, button)),
      },
      icon(audio ? (playing ? 'pause-fill' : 'play-fill') : e.kind === 'video' ? 'play-circle' : 'eye'),
    );
    return button;
  }

  /** Fetches a resource for preview, showing a spinner on the button meanwhile. */
  private async fetchPreview(e: InventoryEntry, button: HTMLButtonElement): Promise<string | undefined> {
    const request = ++this.previewRequest;
    const content = [...button.childNodes];
    button.disabled = true;
    replace(button, h('span', { className: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }));
    try {
      const blob = await this.pipeline.preview!(e.path);
      // Another preview, or leaving the review (see stopAudio), replaced this one meanwhile.
      return request === this.previewRequest ? this.urls.createObjectURL(blob) : undefined;
    } catch (error) {
      this.announce(this.t('previewFailed', { name: short(e.path), message: (error as Error).message }));
      return undefined;
    } finally {
      button.disabled = false;
      replace(button, ...content);
    }
  }

  private async toggleAudio(e: InventoryEntry, button: HTMLButtonElement): Promise<void> {
    if (this.player?.path === e.path) {
      if (this.player.audio.paused) await this.player.audio.play().catch(() => undefined);
      else this.player.audio.pause();
      return;
    }
    this.stopAudio();
    const url = await this.fetchPreview(e, button);
    if (!url) return;
    const audio = new Audio(url);
    this.player = { path: e.path, audio, url };
    const refresh = (): void => {
      const current = this.main.querySelector<HTMLButtonElement>(`.preview-button[data-path="${CSS.escape(e.path)}"]`);
      current?.replaceWith(this.previewButton(e));
    };
    audio.addEventListener('play', refresh);
    audio.addEventListener('pause', refresh);
    audio.addEventListener('ended', refresh);
    await audio.play().catch((error: unknown) => {
      // A pause (or another preview) before playback started interrupts play(): not a failure.
      if ((error as Error).name === 'AbortError') return;
      // An unplayable file stays "not paused": release it so the button offers to play again.
      if (this.player?.audio === audio) this.stopAudio();
      this.announce(this.t('previewFailed', { name: short(e.path), message: '' }));
    });
  }

  /** Stops and releases the audio preview, and drops any preview still being read. */
  private stopAudio(): void {
    this.previewRequest++;
    if (!this.player) return;
    const { audio, url } = this.player;
    this.player = undefined;
    audio.pause();
    audio.removeAttribute('src');
    this.urls.revokeObjectURL(url);
  }

  /** Shows an image or plays a video in a modal window. */
  private async openPreview(e: InventoryEntry, button: HTMLButtonElement): Promise<void> {
    this.stopAudio();
    const url = await this.fetchPreview(e, button);
    if (!url) return;
    const media =
      e.kind === 'video'
        ? // The player's own download would save the blob: URL without a name; the header offers a named one.
          h('video', { src: url, controls: true, autoplay: true, playsinline: true, controlslist: 'nodownload', className: 'preview-media' })
        : h('img', { src: url, alt: short(e.path), className: 'preview-media preview-image' });
    const size = e.image?.width ? `${e.image.width}×${e.image.height ?? '?'} · ` : e.video?.width ? `${e.video.width}×${e.video.height ?? '?'} · ` : '';
    const dialog = h(
      'dialog',
      { className: 'preview-dialog', 'aria-labelledby': 'preview-title' },
      h(
        'div',
        { className: 'preview-header d-flex align-items-start justify-content-between gap-3' },
        h(
          'div',
          { className: 'min-w-0' },
          h('h2', { id: 'preview-title', className: 'h6 mb-0 text-break', tabindex: -1, autofocus: true }, short(e.path)),
          h('p', { className: 'small text-body-secondary mb-0' }, `${size}${bytes(e.size, this.lang)}`),
        ),
        h(
          'div',
          { className: 'd-flex align-items-center gap-2 flex-none' },
          h(
            'a',
            {
              href: url,
              download: e.path.slice(e.path.lastIndexOf('/') + 1),
              className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1',
            },
            icon('download'),
            this.t('downloadFile'),
          ),
          h('button', { type: 'button', className: 'btn-close', 'aria-label': this.t('close'), onclick: () => dialog.close() }),
        ),
      ),
      h('div', { className: 'preview-body' }, media),
    );
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) dialog.close();
    });
    dialog.addEventListener('close', () => {
      if (media instanceof HTMLVideoElement) media.pause();
      media.removeAttribute('src');
      this.urls.revokeObjectURL(url);
      dialog.remove();
    });
    this.root.append(dialog);
    dialog.showModal();
  }

  private details(e: InventoryEntry): string {
    if (e.video) {
      const v = e.video;
      const audio = v.audio.map((x) => `${x.codec}${x.language && x.language !== 'und' ? ` ${x.language}` : ''}`).join(', ');
      return `${v.videoCodec ?? '?'} ${v.width ?? '?'}×${v.height ?? '?'}, ${duration(v.duration)}${audio ? `, ${audio}` : ''}${v.subtitles ? `, ${v.subtitles} subt.` : ''}`;
    }
    if (e.kind === 'video') return this.t('notProbed');
    if (e.image) return `${e.image.width ?? '?'}×${e.image.height ?? '?'}${e.image.animated ? `, ${this.t('animated')}` : ''}`;
    if (e.audio) {
      const a = e.audio;
      const channels = a.channels === 1 ? this.t('mono') : a.channels === 2 ? this.t('stereo') : a.channels ? `${a.channels} ch` : '';
      const parts = [
        a.codec,
        channels,
        a.sampleRate ? `${(a.sampleRate / 1000).toLocaleString(this.lang)} kHz` : '',
        a.bitRate ? `${Math.round(a.bitRate / 1000)} kb/s` : '',
      ];
      return `${parts.filter(Boolean).join(' ')}, ${duration(a.duration)}`;
    }
    if (e.pdf) {
      const p = e.pdf;
      const flags = [p.encrypted ? this.t('pdfEncrypted') : '', p.signed ? this.t('pdfSigned') : '', p.pdfA1 ? 'PDF/A-1' : ''];
      return [this.t(p.pages === 1 ? 'pdfPagesOne' : 'pdfPages', { count: p.pages }), ...flags].filter(Boolean).join(', ');
    }
    return '';
  }

  private setSort(key: SortKey): void {
    this.sort = this.sort.key === key ? { key, dir: this.sort.dir === 1 ? -1 : 1 } : { key, dir: key === 'size' ? -1 : 1 };
    // Sorting is only offered by the table of the review step.
    this.main.querySelector('.inventory-card')!.replaceWith(this.renderInventory(this.analysis!.entries));
  }

  private renderOptions(brokenCount: number): HTMLElement {
    const o = this.options;
    const a = this.analysis!;
    const form = h('form', { className: 'options', 'aria-labelledby': 'h-step3' });
    const presets = h('fieldset', { className: 'mb-3' }, h('legend', { className: 'form-label fw-bold fs-6' }, this.t('preset')));
    const group = h('div', { className: 'list-group preset-group' });
    for (const p of ['conservative', 'balanced', 'aggressive'] as const) {
      group.append(
        h(
          'label',
          { className: 'list-group-item d-flex gap-3 align-items-start radio' },
          h('input', { type: 'radio', name: 'preset', value: p, checked: o.preset === p, className: 'form-check-input flex-shrink-0 mt-1' }),
          h(
            'span',
            {},
            h('strong', { className: 'd-block' }, this.t(`preset_${p}`)),
            h('span', { className: 'help small text-body-secondary' }, this.t(`preset_${p}_help`)),
          ),
        ),
      );
    }
    presets.append(group);
    const current = o.images?.maxDimension;
    const size = h('select', { name: 'imageSize', id: 'opt-imageSize', className: 'form-select' });
    size.append(h('option', { value: 'profile', selected: current === undefined }, this.t('imageSizeProfile')));
    for (const px of [1280, 1600, 1920, 2560]) size.append(h('option', { value: px, selected: current === px }, `${px} px`));
    size.append(h('option', { value: 'none', selected: current === null }, this.t('imageSizeNone')));
    const imageSize = h(
      'div',
      { className: 'mb-3' },
      h('label', { className: 'form-label fw-bold fs-6', for: 'opt-imageSize' }, this.t('imageSize')),
      size,
      h('div', { className: 'form-text' }, this.t('imageSizeHelp')),
    );
    const num = (name: string, label: string, min: number, max: number, value: number | undefined): HTMLElement =>
      h(
        'div',
        { className: 'mb-2' },
        h('label', { className: 'form-label small mb-1', for: `opt-${name}` }, this.t(label)),
        h('input', { type: 'number', id: `opt-${name}`, name, min, max, inputmode: 'numeric', value: value ?? '', className: 'form-control form-control-sm' }),
      );
    const check = (name: string, label: string, checked: boolean, help?: string, isSwitch = false): HTMLElement =>
      h(
        'div',
        { className: `form-check${isSwitch ? ' form-switch' : ''} mb-2` },
        h('input', { type: 'checkbox', name, id: `opt-${name}`, checked, className: 'form-check-input', role: isSwitch ? 'switch' : undefined }),
        h('label', { className: 'form-check-label', for: `opt-${name}` }, this.t(label)),
        help ? h('div', { className: 'form-text mt-0' }, help) : false,
      );
    const res = h('select', { name: 'maxResolution', id: 'opt-maxResolution', className: 'form-select form-select-sm' });
    res.append(h('option', { value: 'profile', selected: o.video?.maxResolution === undefined }, this.t('byPreset')));
    for (const r of ['original', '2160', '1440', '1080', '720', '480', '360']) {
      res.append(h('option', { value: r, selected: String(o.video?.maxResolution ?? '') === r }, r === 'original' ? this.t('original') : `${r}p`));
    }
    const advanced = h(
      'details',
      { className: 'advanced mt-3' },
      h('summary', { className: 'd-flex align-items-center gap-2' }, icon('gear'), this.t('advanced')),
      h(
        'div',
        { className: 'pt-3' },
        check('video', 'videoEnabled', o.video?.enabled !== false),
        h('div', { className: 'mb-2' }, h('label', { className: 'form-label small mb-1', for: 'opt-maxResolution' }, this.t('videoResolution')), res),
        num('crf', 'videoQuality', 16, 35, o.video?.crf),
        num('audioBitrate', 'audioBitrate', 64, 320, o.video?.audioBitrate),
        check('audio', 'audioEnabled', o.audio?.enabled !== false),
        num('audioFilesBitrate', 'audioFilesBitrate', 64, 320, o.audio?.bitrate),
        check('images', 'imagesEnabled', o.images?.enabled !== false),
        num('jpegQuality', 'jpegQuality', 30, 100, o.images?.jpegQuality),
        num('webpQuality', 'webpQuality', 30, 100, o.images?.webpQuality),
        check('png', 'optimizePng', o.images?.png !== false),
        check('stripMetadata', 'stripMetadata', o.images?.stripMetadata === true),
        check('includeScreenshot', 'includeScreenshot', o.images?.includeScreenshot === true),
        check('pdf', 'pdfEnabled', o.pdf?.enabled !== false),
        check('pdfLossless', 'pdfLossless', o.pdf?.images === false),
        check('multithread', 'threadsMulti', this.threading !== 'single'),
      ),
    );
    const unused = a.entries.filter((e) => e.role === 'user-asset' && e.usage === 'unreferenced');
    const legacy = a.package!.legacyFolders;
    const cleanup = h(
      'fieldset',
      { className: 'cleanup mb-2' },
      h('legend', { className: 'form-label fw-bold fs-6' }, this.t('cleanup')),
      check(
        'removeUnused',
        'removeUnused',
        o.removeUnused === 'safe',
        unused.length > 0
          ? this.t(unused.length === 1 ? 'removeUnusedHelpOne' : 'removeUnusedHelp', {
              count: unused.length,
              size: bytes(
                unused.reduce((s, e) => s + e.size, 0),
                this.lang,
              ),
            })
          : undefined,
        true,
      ),
      check(
        'deduplicate',
        'deduplicate',
        o.deduplicate === 'exact',
        a.duplicates.length > 0 ? this.t(a.duplicates.length === 1 ? 'deduplicateHelpOne' : 'deduplicateHelp', { count: a.duplicates.length }) : undefined,
        true,
      ),
      this.namesCheck(check, o.normalizeNames !== 'off'),
      legacy.files > 0 ? check('flatten', 'flatten', o.flatten === 'legacy', this.t('flattenHelp', { files: legacy.files }), true) : false,
      brokenCount > 0
        ? check('missingReferences', 'missingRefs', o.missingReferences === 'remove', this.t('missingRefsHelp', { count: brokenCount }), true)
        : false,
    );
    form.append(
      presets,
      imageSize,
      h('p', { className: 'note small text-body-secondary' }, this.t('lossyNote')),
      cleanup,
      this.renderScreenshot(),
      advanced,
      h('button', { type: 'submit', className: 'btn btn-primary btn-lg w-100 mt-3' }, this.t('reviewPlan')),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.makePlan(form);
    });
    return h(
      'aside',
      { className: 'panel card options-card', 'aria-labelledby': 'h-step3' },
      h('div', { className: 'card-body' }, h('h2', { id: 'h-step3', tabindex: -1, className: 'h5 mb-3' }, this.t('step3')), form),
    );
  }

  /**
   * The project thumbnail: a new screenshot.png drawn from the first page or chosen by the user
   * (the current one is previewed from its row in the contents).
   */
  private renderScreenshot(): HTMLElement {
    const box = h('fieldset', { className: 'screenshot mb-2' });
    const status = h('p', { className: 'screenshot-status small mb-0', 'aria-live': 'polite' });
    const fill = (): void => {
      const a = this.analysis!;
      const preview = this.screenshot
        ? h('img', {
            className: 'screenshot-preview img-fluid border rounded mb-2',
            src: this.screenshot.url,
            alt: this.t('screenshotNew'),
            width: 1280,
            height: 720,
          })
        : h('p', { className: 'small text-body-secondary mb-2' }, this.t(a.package?.hasScreenshot ? 'screenshotCurrent' : 'screenshotNone'));
      const buttons: HTMLButtonElement[] = [];
      const make = async (task: () => Promise<Blob>): Promise<void> => {
        for (const b of buttons) b.disabled = true;
        status.textContent = this.t('screenshotWorking');
        try {
          const blob = await task();
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const problem = screenshotProblem(bytes);
          if (problem) throw new ScreenshotError('render', problem);
          this.dropScreenshot();
          this.screenshot = { blob, url: this.urls.createObjectURL(blob), sha256: sha256Hex(bytes), size: bytes.length };
          fill();
          status.textContent = this.t('screenshotReady');
        } catch (error) {
          for (const b of buttons) b.disabled = false;
          const code = error instanceof ScreenshotError ? error.code : 'render';
          status.textContent = this.t(`screenshotError_${code}`, { message: (error as Error).message });
        }
      };
      const read = this.pipeline.read?.bind(this.pipeline);
      if (read && a.entries.some((e) => e.path === 'index.html')) {
        buttons.push(
          h(
            'button',
            { type: 'button', className: 'btn btn-sm btn-outline-primary screenshot-regenerate', onclick: () => void make(() => renderFirstPage(read)) },
            icon('arrow-repeat'),
            ` ${this.t('screenshotRegenerate')}`,
          ),
        );
      }
      const file = h('input', {
        type: 'file',
        accept: 'image/png,image/jpeg,image/webp,image/gif',
        className: 'screenshot-file visually-hidden',
        tabindex: -1,
        'aria-hidden': 'true',
      });
      file.addEventListener('change', () => {
        const chosen = file.files?.[0];
        if (chosen) void make(() => thumbnailFromImage(chosen));
      });
      buttons.push(
        h(
          'button',
          { type: 'button', className: 'btn btn-sm btn-outline-primary screenshot-upload', onclick: () => file.click() },
          icon('file-earmark-arrow-up'),
          ` ${this.t('screenshotUpload')}`,
        ),
      );
      if (this.screenshot) {
        buttons.push(
          h(
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-link screenshot-discard',
              onclick: () => {
                this.dropScreenshot();
                fill();
                status.textContent = '';
              },
            },
            this.t('screenshotDiscard'),
          ),
        );
      }
      replace(
        box,
        h('legend', { className: 'form-label fw-bold fs-6' }, this.t('screenshot')),
        preview,
        h('div', { className: 'd-flex flex-wrap gap-2 mb-1' }, ...buttons),
        file,
        h('div', { className: 'form-text mt-0 mb-1' }, this.t('screenshotHelp')),
        status,
      );
    };
    fill();
    return box;
  }

  /** The clean-names switch, with how many files would get a new name and one example. */
  private namesCheck(check: (name: string, label: string, checked: boolean, help?: string, isSwitch?: boolean) => HTMLElement, checked: boolean): HTMLElement {
    const changes = this.analysis!.entries.filter((e) => !e.isDirectory && e.role === 'user-asset' && !e.path.startsWith('custom/'))
      .map((e) => e.path.slice(e.path.lastIndexOf('/') + 1))
      .filter((name) => cleanFileName(name) !== name);
    const help =
      changes.length === 0
        ? this.t('normalizeNamesClean')
        : this.t(changes.length === 1 ? 'normalizeNamesHelpOne' : 'normalizeNamesHelp', {
            count: changes.length,
            from: changes[0]!,
            to: cleanFileName(changes[0]!),
          });
    return check('normalizeNames', 'normalizeNames', checked, help, true);
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
    const imageSize = String(data.get('imageSize') ?? 'profile');
    if (imageSize === 'none') images.maxDimension = null;
    else if (/^\d+$/.test(imageSize)) images.maxDimension = Number(imageSize);
    const audio: NonNullable<OptionsInput['audio']> = { enabled: on('audio') };
    // Unchecked, the preset decides whether images inside PDFs are converted.
    const pdf: NonNullable<OptionsInput['pdf']> = { enabled: on('pdf'), ...(on('pdfLossless') ? { images: false } : {}) };
    const afb = n('audioFilesBitrate');
    if (afb !== undefined) audio.bitrate = afb;
    this.threading = on('multithread') ? 'auto' : 'single';
    return {
      preset: String(data.get('preset') ?? 'balanced') as OptionsInput['preset'],
      video,
      images,
      audio,
      pdf,
      removeUnused: on('removeUnused') ? 'safe' : 'off',
      deduplicate: on('deduplicate') ? 'exact' : 'off',
      flatten: on('flatten') ? 'legacy' : 'off',
      missingReferences: on('missingReferences') ? 'remove' : 'keep',
      normalizeNames: on('normalizeNames') ? 'slug' : 'off',
      exclude: [...this.excluded],
      ...(this.screenshot ? { screenshot: { sha256: this.screenshot.sha256, size: this.screenshot.size } } : {}),
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
  private opText(op: PlanOperation): string {
    switch (op.op) {
      case 'transcode-video':
      case 'recompress-image':
      case 'optimize-pdf':
        return `${short(op.path)} (${bytes(op.size, this.lang)}): ${op.conversions.join('; ')}`;
      case 'transcode-audio':
        return `${short(op.path)}${op.to ? ` → ${short(op.to)}` : ''} (${bytes(op.size, this.lang)}): ${op.conversions.join('; ')}`;
      case 'remove-unused':
        return `${short(op.path)} (${bytes(op.size, this.lang)})`;
      case 'deduplicate':
        return `${op.remove.map(short).join(', ')}: ${this.t('mergedInto', { keep: short(op.keep) })}`;
      case 'move-resource':
        return `${op.path} → ${op.to}`;
      case 'rename-resource':
        return `${short(op.path)} → ${short(op.to)}`;
      case 'remove-missing-reference':
        return `${short(op.path)}: ${this.t('unlinkCount', { count: op.references })}`;
      case 'replace-screenshot':
        return `${op.path} (${this.t(op.added ? 'screenshotAdded' : 'screenshotReplaced', { size: bytes(op.after, this.lang) })})`;
      default:
        return op.path;
    }
  }

  /** Warnings about the plan, derived from its operations so they follow the interface language. */
  private riskNotes(plan: OptimizationPlan): string[] {
    const ops = plan.operations;
    const has = (kind: PlanOperation['op']): boolean => ops.some((o) => o.op === kind);
    const notes: string[] = [];
    if (ops.some((o) => o.op === 'transcode-video' || o.op === 'transcode-audio' || (o.op === 'recompress-image' && o.lossy))) notes.push(this.t('risk_lossy'));
    if (ops.some((o) => o.op === 'transcode-audio' && o.to !== undefined)) notes.push(this.t('risk_audioRename'));
    if (ops.some((o) => o.op === 'optimize-pdf' && o.lossy)) notes.push(this.t('risk_pdfImages'));
    if (ops.some((o) => (o.op === 'transcode-video' && o.job.scale) || (o.op === 'recompress-image' && o.job.resize))) notes.push(this.t('risk_downscale'));
    if (has('remove-unused')) notes.push(this.t('risk_unused'));
    if (has('deduplicate')) notes.push(this.t('risk_dedup'));
    if (has('move-resource')) notes.push(this.t('risk_move'));
    if (has('rename-resource')) notes.push(this.t('risk_rename'));
    if (has('remove-missing-reference')) notes.push(this.t('risk_unlink'));
    return notes;
  }

  private renderPlan(): HTMLElement {
    const plan = this.plan!;
    const ops = h('div', { className: 'plan-ops list-group mb-3' });
    for (const [kind, iconName] of OP_ORDER) {
      const list = plan.operations.filter((o) => o.op === kind);
      if (list.length === 0) continue;
      const items = h('ul', { className: 'plan-op-items list-unstyled small mb-0 mt-2' });
      for (const op of list.slice(0, 300)) items.append(h('li', { className: `op op-${op.op}` }, this.opText(op)));
      if (list.length > 300) items.append(h('li', {}, `… +${list.length - 300}`));
      ops.append(
        h(
          'details',
          { className: 'list-group-item plan-group', open: list.length <= 5 },
          h(
            'summary',
            { className: 'd-flex align-items-center gap-2' },
            h('span', { className: 'op-icon text-primary' }, icon(iconName)),
            h('span', { className: 'op-kind flex-grow-1' }, this.t(`op_${kind}`)),
            h('span', { className: 'badge rounded-pill text-bg-primary' }, String(list.length)),
          ),
          items,
        ),
      );
    }
    const skipped = h('ul', { className: 'plan-skipped small mb-0 mt-2' });
    for (const s of plan.skipped.slice(0, 200)) skipped.append(h('li', {}, `${short(s.path)}: ${s.detail}`));
    const actionable = plan.operations.length > 0;
    const notes = this.riskNotes(plan);
    const risks =
      notes.length > 0
        ? h(
            'div',
            { className: 'alert alert-warning risks', role: 'note' },
            h('strong', { className: 'd-block mb-1' }, this.t('riskTitle')),
            h('ul', { className: 'mb-0 ps-3' }, ...notes.map((r) => h('li', { className: 'note' }, r))),
          )
        : false;
    return this.section(
      'step4',
      this.t('step4'),
      actionable ? h('h3', { className: 'h6 text-body-secondary' }, this.t('planOps')) : h('p', { className: 'alert alert-secondary' }, this.t('planEmpty')),
      actionable ? ops : false,
      actionable ? h('p', { className: 'estimate text-body-secondary' }, this.t('estimate', { size: bytes(plan.estimate.savedBytes, this.lang) })) : false,
      risks,
      plan.skipped.length > 0
        ? h('details', { className: 'skipped mb-3' }, h('summary', {}, `${this.t('planSkipped')} (${plan.skipped.length})`), skipped)
        : false,
      h(
        'div',
        { className: 'actions d-flex flex-wrap gap-2' },
        h('button', { type: 'button', className: 'btn btn-primary btn-lg px-4', onclick: () => void this.run(), disabled: !actionable }, this.t('optimize')),
        h(
          'button',
          { type: 'button', className: 'btn btn-outline-secondary btn-lg d-inline-flex align-items-center gap-2', onclick: () => this.go('review') },
          icon('arrow-left'),
          this.t('changeOptions'),
        ),
      ),
    );
  }

  // ------------------------------------------------------------------ step 5
  private renderStages(): HTMLElement {
    const current = this.progress?.stage;
    const index = STAGES.indexOf(current as (typeof STAGES)[number]);
    const list = h('ol', { className: 'stages list-unstyled mb-4', 'data-role': 'stages' });
    STAGES.forEach((s, i) => {
      const state = s === current ? 'is-current' : index > i ? 'is-done' : '';
      const mark =
        s === current
          ? h('span', { className: 'spinner-border spinner-border-sm text-primary', 'aria-hidden': 'true' })
          : index > i
            ? icon('check-circle-fill', 'text-success')
            : icon('circle', 'text-body-tertiary');
      list.append(
        h(
          'li',
          { className: `${state} d-flex align-items-center gap-2`, 'aria-current': s === current ? 'step' : undefined },
          h('span', { className: 'stage-mark' }, mark),
          this.t(`stage_${s}`),
        ),
      );
    });
    return list;
  }

  private renderRunning(): HTMLElement {
    const cancel = h(
      'button',
      { type: 'button', className: 'btn btn-outline-danger', onclick: () => void this.cancel(), disabled: this.cancelling },
      this.t(this.cancelling ? 'cancelling' : 'cancel'),
    );
    return this.section('step5', this.t('step5'), this.renderStages(), this.renderProgressBar(), h('div', { className: 'actions mt-4' }, cancel));
  }

  private async run(): Promise<void> {
    const plan = this.plan!;
    this.cancelling = false;
    this.progress = undefined;
    this.go('running');
    try {
      const screenshot = plan.operations.some((o) => o.op === 'replace-screenshot') ? this.screenshot?.blob : undefined;
      this.result = await this.pipeline.optimize(plan.planHash, (e) => this.onProgress(e), screenshot);
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
    const tone: Record<string, [string, IconName]> = {
      optimized: ['success', 'check-circle-fill'],
      partial: ['warning', 'exclamation-triangle-fill'],
      'no-improvement': ['secondary', 'info-circle-fill'],
    };
    const [kind, statusIcon] = tone[report.status] ?? ['danger', 'x-circle-fill'];
    const children: Child[] = [
      h(
        'p',
        { className: `result-status status-${report.status} alert alert-${kind} d-flex align-items-center gap-2` },
        icon(statusIcon),
        this.t(`status_${report.status}`),
      ),
    ];
    // Never imply that videos were optimized when every planned one kept its original.
    const videos = report.operations.filter((o) => o.op === 'transcode-video');
    if (videos.length > 0 && !videos.some((o) => o.status === 'applied')) {
      children.push(h('p', { className: 'callout alert alert-light border', role: 'note' }, this.t('videosKept')));
    }
    if (output) {
      if (s.saved > 0) {
        children.push(
          h(
            'div',
            { className: 'saved-hero text-center my-4' },
            h('p', { className: 'saved-figure mb-1' }, this.t('savedShort', { percent: percent(s.saved / s.before, this.lang) })),
            h('p', { className: 'saved text-body-secondary mb-0' }, this.t('savedDetail', { size: bytes(s.saved, this.lang) })),
          ),
        );
      }
      const max = Math.max(s.before, s.after, 1);
      const bar = (label: string, value: number, cls: string): HTMLElement => {
        const fill = h('span', { className: `fill ${cls}` });
        fill.style.width = `${(value / max) * 100}%`;
        return h(
          'div',
          { className: 'compare-row' },
          h('span', { className: 'compare-label' }, label),
          h('span', { className: 'compare-track' }, fill),
          h('span', { className: 'num text-end' }, bytes(value, this.lang)),
        );
      };
      children.push(h('div', { className: 'compare mb-4' }, bar(this.t('before'), s.before, 'fill-before'), bar(this.t('after'), s.after, 'fill-after')));
      // A named File: browsers that ignore the download attribute for blob: URLs fall back to its name.
      const url = this.urls.createObjectURL(new File([output], fileName, { type: output.type || 'application/zip' }));
      const reportUrl = this.urls.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
      this.objectUrls.push(url, reportUrl);
      children.push(
        h(
          'div',
          { className: 'actions downloads d-flex flex-wrap gap-2 mb-4' },
          h(
            'a',
            { className: 'btn btn-primary btn-lg d-inline-flex align-items-center gap-2', href: url, download: fileName, 'data-testid': 'download' },
            icon('download'),
            this.t('download', { name: fileName }),
          ),
          h(
            'a',
            {
              className: 'btn btn-outline-secondary btn-lg d-inline-flex align-items-center gap-2',
              href: reportUrl,
              download: fileName.replace(/\.elpx$/, '_report.json'),
              'data-testid': 'download-report',
            },
            icon('filetype-json'),
            this.t('downloadReport'),
          ),
        ),
      );
    }
    children.push(this.renderOperationResults(report));
    children.push(
      h(
        'div',
        { className: 'actions mt-4' },
        h(
          'button',
          { type: 'button', className: 'btn btn-outline-primary d-inline-flex align-items-center gap-2', onclick: () => this.reset() },
          icon('arrow-repeat'),
          this.t('another'),
        ),
      ),
    );
    return this.section('step6', this.t('step6'), ...children);
  }

  private renderOperationResults(report: OptimizationReport): HTMLElement {
    const list = h('ul', { className: 'op-results list-group list-group-flush' });
    const mark: Record<OperationResult['status'], [IconName, string]> = {
      applied: ['check-circle-fill', 'text-success'],
      skipped: ['info-circle-fill', 'text-body-secondary'],
      reverted: ['info-circle-fill', 'text-body-secondary'],
      failed: ['x-circle-fill', 'text-danger'],
    };
    for (const o of report.operations) {
      const sizes = o.before !== undefined && o.after !== undefined ? ` ${bytes(o.before, this.lang)} → ${bytes(o.after, this.lang)}` : '';
      const [name, color] = mark[o.status];
      list.append(
        h(
          'li',
          { className: `list-group-item op-result op-${o.status} d-flex gap-2 small` },
          h('span', { className: color }, icon(name)),
          h(
            'span',
            {},
            h('span', { className: 'op-status fw-bold' }, this.t(o.status === 'applied' ? 'applied' : o.status === 'failed' ? 'failed' : 'reverted')),
            ` ${short(o.path)}${sizes}`,
            o.detail ? h('span', { className: 'op-detail d-block text-body-secondary' }, o.detail) : '',
          ),
        ),
      );
    }
    return h(
      'details',
      { className: 'op-details card', open: report.operations.length <= 8 },
      h('summary', { className: 'card-header' }, `${this.t('opsDetail')} (${report.operations.length})`),
      list,
    );
  }

  // ------------------------------------------------------------------ errors
  private showError(code: string, message: string): void {
    this.errorCode = code;
    this.errorMessage = message;
    this.go('error');
  }

  private renderError(): HTMLElement {
    const cancelled = this.errorCode === 'cancelled';
    return h(
      'section',
      { className: 'step step-error card', 'aria-labelledby': 'h-error', role: 'alert' },
      h(
        'div',
        { className: 'card-body' },
        h(
          'h2',
          { id: 'h-error', tabindex: -1, className: `h4 d-flex align-items-center gap-2 ${cancelled ? '' : 'text-danger'}` },
          icon(cancelled ? 'info-circle-fill' : 'x-circle-fill'),
          this.t(cancelled ? 'stage_done' : 'errorTitle'),
        ),
        h('p', {}, this.errorMessage),
        this.errorCode === 'legacy-elp' ? h('p', { className: 'alert alert-info' }, this.t('legacyHelp')) : false,
        h('div', { className: 'actions' }, h('button', { type: 'button', className: 'btn btn-primary', onclick: () => this.reset() }, this.t('tryAgain'))),
      ),
    );
  }

  private revokeUrls(): void {
    for (const u of this.objectUrls) this.urls.revokeObjectURL(u);
    this.objectUrls = [];
  }

  /** Forgets the new thumbnail. */
  private dropScreenshot(): void {
    if (this.screenshot) this.urls.revokeObjectURL(this.screenshot.url);
    this.screenshot = undefined;
  }

  /** Returns to the first step, releasing downloads. */
  reset(): void {
    this.revokeUrls();
    this.dropScreenshot();
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
