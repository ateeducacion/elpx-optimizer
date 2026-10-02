import type { AnalysisResult, InventoryEntry, ReferenceRecord } from '../core/analyze/model.js';
import type { Diagnostic } from '../core/diagnostics.js';
import type { ProgressEvent } from '../core/media/engine.js';
import { APP_DEFAULTS, type OptionsInput } from '../core/plan/options.js';
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
import { chooseTheme } from './theme.js';
import { VIDEO_PROFILES, type Preset } from '../core/media/video-policy.js';
import { IMAGE_PROFILES } from '../core/media/image-policy.js';
import { ODF_FORMATS } from '../core/media/odf-policy.js';
import { AUDIO_PROFILES } from '../core/media/audio-policy.js';

/** What the UI needs from the pipeline (the real client or a test double). */
export interface PipelineApi {
  analyze(file: File, onProgress?: (e: ProgressEvent) => void, threading?: ThreadingPreference): Promise<AnalysisResult>;
  plan(options: OptionsInput): Promise<OptimizationPlan>;
  /** Returns an image, audio, video or PDF of the analyzed project for a local preview (optional). */
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

type View = 'start' | 'analyzing' | 'review' | 'running' | 'result' | 'error';
type SortKey = 'path' | 'kind' | 'size' | 'usage';
type StepKey = 'step1' | 'step2' | 'step3' | 'step4' | 'step5' | 'step6';
type Child = Node | string | false | undefined;

const REPO_URL = 'https://github.com/ateeducacion/elpx-optimizer';
const ATE_URL = 'https://www3.gobiernodecanarias.org/medusa/ecoescuela/ate/';
const SKILL_URL = `${REPO_URL}/blob/main/skills/elpx-optimizer/SKILL.md`;
const CLI_DOCS_URL = `${REPO_URL}/blob/main/docs/cli.md`;
const SKILL_ZIP_URL = `${REPO_URL}/releases/latest/download/elpx-optimizer-skill.zip`;
const SKILL_DOCS_URL = `${REPO_URL}/blob/main/docs/skill.md`;

const STAGES = ['engine-load', 'extract', 'transcode', 'encode-image', 'pdf', 'validate', 'package', 'verify'] as const;

/** The stepper position of each view (1-based; 0 hides the current marker): project, optimize, download. */
const VIEW_STEP: Record<View, number> = { start: 1, analyzing: 1, review: 2, running: 2, result: 3, error: 0 };

/** A folder eXeLearning 3 named after an ODE ID (14 digits and 6 letters or digits). */
const LEGACY_FOLDER = /(?:^|\/)(\d{14}[A-Z0-9]{6})\//;

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
  /** Whether the files and advanced sections are open (kept across re-renders). */
  private advancedOpen = false;
  /** Cards whose files are unfolded (kept across re-renders), and whether media are recompressed at all. */
  private readonly openCards = new Set<string>();
  private recompress = true;
  /** The latest plan request, the one that produced this.plan, and the options it was made for. */
  private planRequest = 0;
  private planFor = -1;
  private planKey = '';
  private planError = '';
  private planTimer: ReturnType<typeof setTimeout> | undefined;
  private sort: { key: SortKey; dir: 1 | -1 } = { key: 'size', dir: -1 };
  // Clean names and removing unused files are on by default in the web app (the CLI changes nothing unless asked).
  private options: OptionsInput = { preset: 'balanced', ...APP_DEFAULTS };
  private threading: ThreadingPreference;
  private cancelling = false;
  private objectUrls: string[] = [];
  private themeObserver: MutationObserver | undefined;
  /** The new screenshot.png chosen in the options. */
  private screenshot: { readonly blob: Blob; readonly url: string; readonly sha256: string; readonly size: number } | undefined;
  private readonly main: HTMLElement;
  private readonly stepper: HTMLElement;
  private readonly engineLine: HTMLElement;
  private readonly status: HTMLElement;
  private licensesPanel: HTMLDialogElement | undefined;
  private helpPanel: HTMLDialogElement | undefined;
  private skillPanel: HTMLDialogElement | undefined;
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
            'button',
            {
              type: 'button',
              className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center gap-1 skill-button',
              'aria-haspopup': 'dialog',
              title: this.t('skillLink'),
              'aria-label': this.t('skillLink'),
              onclick: () => this.skillPanel?.showModal(),
            },
            icon('robot'),
            h('span', { className: 'd-none d-md-inline' }, this.t('skillButton')),
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
            h('span', { className: 'd-none d-sm-inline' }, this.t('language')),
          ),
          this.themeButton(),
        ),
      ),
    );
    const body = h('div', { className: 'container-lg app-body' }, this.stepper, this.engineLine, this.main, this.status);
    this.licensesPanel = this.renderLicenses();
    this.helpPanel = this.renderHelp();
    this.skillPanel = this.renderSkill();
    replace(this.root, header, body, this.renderFooter(), this.licensesPanel, this.helpPanel, this.skillPanel);
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
    const npx = 'npx elpx-optimizer';
    const docker = 'docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" ateeducacion/elpx-optimizer';
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
      h('h4', { className: 'h6 mt-3' }, this.t('helpNpxTitle')),
      h('p', { className: 'small' }, this.t('helpNpx')),
      h(
        'ol',
        { className: 'help-steps ps-3' },
        step(this.t('helpStep1'), 'sudo apt install ffmpeg      # Ubuntu\nbrew install ffmpeg          # macOS', this.t('helpStep1Note')),
        step(this.t('helpStep3'), `${npx} doctor`),
        step(this.t('helpStep4'), `${npx} inspect curso.elpx`),
        step(this.t('helpStep5'), `${npx} optimize curso.elpx --dry-run`),
        step(this.t('helpStep6'), `${npx} optimize curso.elpx`, this.t('helpStep6Note')),
        step(this.t('helpStepMore'), `${npx} optimize curso.elpx \\\n  --remove-unused safe --deduplicate exact`),
      ),
      h('h4', { className: 'h6 mt-4' }, this.t('helpDockerTitle')),
      h('p', { className: 'small' }, this.t('helpDocker')),
      h(
        'ol',
        { className: 'help-steps ps-3' },
        step(this.t('helpStep4'), `${docker} inspect curso.elpx`),
        step(this.t('helpStep5'), `${docker} optimize curso.elpx --dry-run`),
        step(this.t('helpStep6'), `${docker} optimize curso.elpx`, this.t('helpStep6Note')),
      ),
      h('p', { className: 'small text-body-secondary' }, this.t('helpDockerWindows')),
      h('p', { className: 'small' }, this.t('helpDockerAlias')),
      this.codeBlock(
        'elpx() {\n  docker run --rm --user "$(id -u):$(id -g)" \\\n    -v "$PWD:/work" ateeducacion/elpx-optimizer "$@"\n}\nelpx optimize curso.elpx',
      ),
      h('p', {}, h('a', { ...external, href: CLI_DOCS_URL }, this.t('helpCliDocs'))),
    );
  }

  /** How to install the Agent Skill: the download, and the installers that take it from GitHub. */
  private renderSkill(): HTMLDialogElement {
    const external = { target: '_blank', rel: 'noopener noreferrer' };
    const option = (title: string, ...body: Child[]): HTMLElement => h('section', { className: 'mb-4' }, h('h3', { className: 'h6' }, title), ...body);
    return this.sidePanel(
      'skill',
      this.t('helpSkillTitle'),
      h('p', { className: 'small' }, this.t('skillIntro')),
      option(
        this.t('skillZipTitle'),
        h('p', { className: 'small' }, this.t('skillZip')),
        h(
          'a',
          { ...external, href: SKILL_ZIP_URL, download: '', className: 'btn btn-primary btn-sm d-inline-flex align-items-center gap-1 mb-2' },
          icon('download'),
          this.t('skillDownload'),
        ),
        this.codeBlock(`unzip elpx-optimizer-skill.zip -d ~/.claude/skills/\ncd ~/.claude/skills/elpx-optimizer/vendor && npm install`),
      ),
      option(this.t('skillNpxTitle'), this.codeBlock('npx skills add ateeducacion/elpx-optimizer')),
      option(this.t('skillGhTitle'), this.codeBlock('gh skill install ateeducacion/elpx-optimizer elpx-optimizer')),
      h('p', { className: 'small' }, this.t('skillNeedsCli')),
      this.codeBlock('npm install -g elpx-optimizer'),
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

  /** Sun or moon: switches between light and dark, and shows the scheme it switches to. */
  private themeButton(): HTMLButtonElement {
    const html = document.documentElement;
    const button = h('button', {
      type: 'button',
      className: 'btn btn-sm btn-outline-secondary d-inline-flex align-items-center theme-button',
      onclick: () => chooseTheme(html.dataset['bsTheme'] === 'dark' ? 'light' : 'dark'),
    });
    const paint = (): void => {
      const dark = html.dataset['bsTheme'] === 'dark';
      const label = this.t(dark ? 'themeLight' : 'themeDark');
      button.setAttribute('aria-label', label);
      button.title = label;
      replace(button, icon(dark ? 'sun' : 'moon-stars'));
    };
    paint();
    // Repaints for the button and for system changes followed by main.ts; one observer per page.
    this.themeObserver?.disconnect();
    this.themeObserver = new MutationObserver(paint);
    this.themeObserver.observe(html, { attributes: true, attributeFilter: ['data-bs-theme'] });
    return button;
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
    for (let i = 1; i <= 3; i++) {
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
    if (this.view !== 'review') this.dropPreviews();
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
    this.clearPlan();
    this.result = undefined;
    this.excluded.clear();
    // A new project starts with its cards and advanced options folded.
    this.openCards.clear();
    this.advancedOpen = false;
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

  // ------------------------------------------------------------------ step 2: review and optimize
  /**
   * One form: the project and what will be done on the left, the level, the estimated result and
   * the button on the right. The plan is made again whenever an option changes (planning encodes
   * nothing), so the estimate is the core's and the button runs the plan it shows.
   */
  private renderReview(): HTMLElement {
    const a = this.analysis!;
    const form = h('form', { className: 'options review-form', 'aria-labelledby': 'h-step2', novalidate: true });
    form.append(
      h(
        'div',
        { className: 'row g-4 align-items-start' },
        h(
          'div',
          { className: 'col-lg-8 review-main d-flex flex-column gap-4' },
          this.renderProject(a),
          this.renderActions(a),
          this.renderScreenshot(),
          this.renderAdvanced(),
          this.renderDiagnosticsLink(a.diagnostics),
        ),
        h('div', { className: 'col-lg-4 options-col' }, this.renderChoose()),
      ),
      this.renderMobileBar(),
    );
    form.addEventListener('change', (e) => {
      if ((e.target as HTMLInputElement).name === 'preset') this.updateLevelHints(form);
      this.syncRemoved(form);
      this.schedulePlan(form);
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.optimizeNow(form);
    });
    this.updateLevelHints(form);
    this.syncRemoved(form);
    this.schedulePlan(form, 0);
    return form;
  }

  /** The project: its name, what it holds and what takes up its space. */
  private renderProject(a: AnalysisResult): HTMLElement {
    const p = a.package!;
    const files = a.entries.filter((e) => !e.isDirectory && (e.role === 'user-asset' || e.path === 'screenshot.png')).length;
    return h(
      'section',
      { className: 'project card', 'aria-labelledby': 'h-step2' },
      h(
        'div',
        { className: 'card-body d-flex flex-column gap-3' },
        h(
          'div',
          { className: 'd-flex align-items-start gap-3' },
          h(
            'div',
            { className: 'flex-grow-1 min-w-0' },
            h('h2', { id: 'h-step2', tabindex: -1, className: 'project-title h4 mb-1 text-break' }, p.title ?? a.input.name),
            h(
              'p',
              { className: 'project-meta text-body-secondary mb-0' },
              [
                a.input.name,
                bytes(a.input.size, this.lang),
                this.t(p.pages === 1 ? 'pagesOne' : 'pagesMany', { count: p.pages }),
                this.t(files === 1 ? 'filesOne' : 'filesCount', { count: files }),
                this.t(p.variant === 'v4' ? 'variantV4' : 'variantV3'),
              ].join(' · '),
            ),
          ),
          h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary flex-none', onclick: () => this.reset() }, this.t('changeFile')),
        ),
        this.renderWeight(a),
      ),
    );
  }

  /** What will be done, in plain words: one card per finding, with its switch, what it saves and its files. */
  private renderActions(a: AnalysisResult): HTMLElement {
    const o = this.options;
    const name = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
    const list = (paths: readonly string[]): string => {
      const names = [...new Set(paths.map(name))];
      return names.length > 3 ? `${names.slice(0, 3).join(', ')}…` : names.join(', ');
    };
    const files = (items: readonly Child[]): HTMLElement => h('ul', { className: 'action-files list-unstyled mb-0' }, ...items);
    const fileItem = (path: string, extra?: string): HTMLElement =>
      h(
        'li',
        { className: 'd-flex gap-3 align-items-baseline' },
        this.fileName(path),
        extra ? h('span', { className: 'num text-body-secondary ms-auto flex-none' }, extra) : false,
      );
    const cards: Child[] = [this.renderMediaAction(a)];
    const unused = a.entries.filter((e) => e.role === 'user-asset' && e.usage === 'unreferenced');
    if (unused.length > 0) {
      cards.push(
        this.actionCard({
          name: 'removeUnused',
          checked: o.removeUnused === 'safe',
          iconName: 'trash3',
          title: this.t(unused.length === 1 ? 'actUnusedOne' : 'actUnused', { count: unused.length }),
          desc: this.t('actUnusedDesc', { names: list(unused.map((e) => e.path)) }),
          amount: `−${bytes(
            unused.reduce((s, e) => s + e.size, 0),
            this.lang,
          )}`,
          details: files(unused.map((e) => fileItem(e.path, bytes(e.size, this.lang)))),
        }),
      );
    }
    if (a.duplicates.length > 0) {
      const copies = a.duplicates.reduce((s, d) => s + d.paths.length - 1, 0);
      cards.push(
        this.actionCard({
          name: 'deduplicate',
          checked: o.deduplicate === 'exact',
          iconName: 'files',
          title: this.t(copies === 1 ? 'actDupOne' : 'actDup', { count: copies }),
          desc: this.t('actDupDesc', { names: list(a.duplicates.map((d) => d.paths[0]!)) }),
          amount: `−${bytes(
            a.duplicates.reduce((s, d) => s + d.size * (d.paths.length - 1), 0),
            this.lang,
          )}`,
          details: files(
            a.duplicates.map((d) =>
              h(
                'li',
                {},
                h('span', { className: 'd-block text-break' }, d.paths.map(short).join(' = ')),
                h(
                  'span',
                  { className: 'file-where d-block small text-body-secondary' },
                  this.t('dupGroup', { count: d.paths.length, size: bytes(d.size, this.lang) }),
                ),
              ),
            ),
          ),
        }),
      );
    }
    const renames = this.nameChanges();
    cards.push(
      this.actionCard({
        name: 'normalizeNames',
        checked: o.normalizeNames !== 'off',
        iconName: 'pencil-square',
        title: this.t('normalizeNames'),
        desc: this.namesHelp(),
        // Nothing to rename: the switch keeps the preference but cannot be changed here.
        disabled: renames.length === 0,
        details:
          renames.length > 0
            ? files(
                renames.map(([from, to]) =>
                  h('li', { className: 'text-break' }, short(from), h('span', { className: 'text-body-secondary' }, ' → '), h('strong', {}, to)),
                ),
              )
            : undefined,
      }),
    );
    const legacy = a.package!.legacyFolders;
    if (legacy.files > 0) {
      const moved = a.entries.filter((e) => !e.isDirectory && LEGACY_FOLDER.test(e.path));
      cards.push(
        this.actionCard({
          name: 'flatten',
          checked: o.flatten === 'legacy',
          iconName: 'folder-symlink',
          title: this.t(legacy.files === 1 ? 'actFlattenOne' : 'actFlatten', { count: legacy.files }),
          desc: this.t('actFlattenDesc'),
          details: files(
            moved.map((e) =>
              h(
                'li',
                { className: 'text-break' },
                short(e.path),
                h('span', { className: 'text-body-secondary' }, ' → '),
                h('strong', {}, `content/resources/${name(e.path)}`),
              ),
            ),
          ),
        }),
      );
    }
    const broken = brokenReferences(a.references);
    if (broken.length > 0) {
      // The same missing file is referenced in several forms (editable, published, search index): count it once.
      const uses = new Map<string, number>();
      for (const r of broken) {
        const missing = name((r.target ?? r.value).split(/[?#]/)[0]!);
        uses.set(missing, (uses.get(missing) ?? 0) + 1);
      }
      const missing = [...uses.keys()];
      cards.push(
        this.actionCard({
          name: 'missingReferences',
          checked: o.missingReferences === 'remove',
          iconName: 'eraser',
          title: this.t(missing.length === 1 ? 'actBrokenOne' : 'actBroken', { count: missing.length, name: missing[0]! }),
          desc: this.t(broken.length === 1 ? 'actBrokenDescOne' : 'actBrokenDesc', { count: broken.length }),
          warning: true,
          details: files(
            [...uses].map(([file, n]) =>
              h(
                'li',
                { className: 'd-flex gap-3' },
                h('span', { className: 'text-break' }, file),
                h('span', { className: 'text-body-secondary ms-auto flex-none' }, this.t(n === 1 ? 'usesOne' : 'uses', { count: n })),
              ),
            ),
          ),
        }),
      );
    }
    return h(
      'section',
      { className: 'actions-section', 'aria-labelledby': 'h-actions' },
      h('h3', { id: 'h-actions', className: 'h5 mb-1' }, this.t('actionsTitle')),
      h('p', { className: 'text-body-secondary mb-3' }, this.t('actionsLead')),
      h('div', { className: 'action-list card' }, ...cards),
    );
  }

  /** A file's path as it will be while "clean file names" is on (the switch decides), as it is otherwise. */
  private shownPath(path: string): string {
    const on = this.main.querySelector<HTMLInputElement>('input[name="normalizeNames"]')?.checked ?? this.options.normalizeNames !== 'off';
    const to = on ? new Map(this.nameChanges()).get(path) : undefined;
    return to === undefined ? path : path.slice(0, path.lastIndexOf('/') + 1) + to;
  }

  /** The files that would get a clean name, as [path, new name] (the plan settles names that collide). */
  private nameChanges(): [string, string][] {
    return this.analysis!.entries.filter((e) => !e.isDirectory && e.role === 'user-asset' && !e.path.startsWith('custom/'))
      .map((e): [string, string] => [e.path, cleanFileName(e.path.slice(e.path.lastIndexOf('/') + 1))])
      .filter(([path, to]) => path.slice(path.lastIndexOf('/') + 1) !== to);
  }

  /**
   * One finding: its row (icon, what it does, what it saves, its switch, whose name is the option
   * it sets) and, folded underneath, the files it concerns.
   */
  private actionCard(c: {
    readonly name: string;
    readonly checked: boolean;
    readonly iconName: IconName;
    readonly title: string;
    readonly desc: string;
    readonly amount?: string;
    readonly warning?: boolean;
    readonly details?: HTMLElement;
    readonly detailsLabel?: string;
    readonly role?: string;
    readonly disabled?: boolean;
  }): HTMLElement {
    const id = `opt-${c.name}`;
    const open = this.openCards.has(c.name);
    const details = c.details
      ? h(
          'details',
          { className: 'action-details', open },
          h('summary', {}, c.detailsLabel ?? this.t('actShow', { count: c.details.children.length })),
          h('div', { className: 'action-details-body' }, c.details),
        )
      : false;
    if (details) details.addEventListener('toggle', () => (details.open ? this.openCards.add(c.name) : this.openCards.delete(c.name)));
    return h(
      'div',
      { className: `action-item action-${c.name}${c.role ? ` action-${c.role}` : ''}${c.warning ? ' action-warning' : ''}`, 'data-role': c.role },
      h(
        'div',
        { className: 'action' },
        h('span', { className: 'action-icon', 'aria-hidden': 'true' }, icon(c.iconName)),
        h(
          'label',
          { className: 'action-text flex-grow-1', for: id },
          h('span', { className: 'action-title d-block' }, c.title),
          h('span', { className: 'action-desc d-block' }, c.desc),
        ),
        c.amount ? h('span', { className: 'action-amount num' }, c.amount) : h('span', { className: 'action-amount num' }),
        h(
          'span',
          { className: 'form-check form-switch m-0 flex-none' },
          h('input', {
            type: 'checkbox',
            role: 'switch',
            name: c.name,
            id,
            checked: c.checked,
            disabled: c.disabled,
            className: 'form-check-input',
            'aria-label': c.title,
          }),
        ),
      ),
      details,
    );
  }

  /** Recompressing media: its switch, what the plan recompresses at this level, and every file with its own switch. */
  private renderMediaAction(a: AnalysisResult): HTMLElement {
    const card = this.actionCard({
      name: 'recompress',
      checked: this.recompress,
      iconName: 'image',
      title: '',
      desc: '',
      details: this.renderInventory(a.entries),
      detailsLabel: this.t('actShowAll', { count: this.inventoryRows(a.entries).length }),
      role: 'media',
    });
    this.fillMediaSummary(card);
    return card;
  }

  /** Writes what the current plan recompresses into the media card (its switch and files stay). */
  private fillMediaSummary(card: Element): void {
    const plan = this.plan;
    const kinds: [PlanOperation['op'], string][] = [
      ['transcode-video', 'kindVideo'],
      ['recompress-image', 'kindImage'],
      ['transcode-audio', 'kindAudio'],
      ['optimize-pdf', 'kindPdf'],
      ['optimize-odf', 'kindOdf'],
    ];
    const media = (plan?.operations ?? []).filter((o) => kinds.some(([k]) => k === o.op));
    const parts = kinds
      .map(([op, key]) => [media.filter((o) => o.op === op).length, key] as const)
      .filter(([n]) => n > 0)
      .map(([n, key]) => this.t(n === 1 ? `${key}One` : key, { count: n }));
    const saving = media.reduce((s, o) => s + ('estimatedBytes' in o && o.estimatedBytes !== undefined ? Math.max(0, o.size - o.estimatedBytes) : 0), 0);
    const title = !this.recompress
      ? this.t('actMediaOff')
      : !plan
        ? this.t('actMediaPending')
        : parts.length > 0
          ? this.t('actMedia', { what: parts.join(', ') })
          : this.t('actMediaNone');
    const desc = !this.recompress ? this.t('actMediaOffDesc') : this.t(parts.length > 0 || !plan ? 'actMediaDesc' : 'actMediaNoneDesc');
    card.querySelector('.action-title')!.textContent = title;
    card.querySelector('.action-desc')!.textContent = desc;
    card.querySelector('.action-amount')!.textContent = this.recompress && saving > 0 ? `≈ −${bytes(saving, this.lang)}` : '';
    card.querySelector('input[name="recompress"]')!.setAttribute('aria-label', this.t('actMediaSwitch'));
  }

  /** Files removed by "remove unused files" leave the list of files to recompress while it is on. */
  private syncRemoved(form: HTMLFormElement): void {
    const removing = form.querySelector<HTMLInputElement>('input[name="removeUnused"]')?.checked === true;
    for (const tr of form.querySelectorAll<HTMLElement>('.inventory tr[data-unused]')) tr.hidden = removing;
    // The table shows the names the files will have while "clean file names" is on, the original ones otherwise.
    const clean = form.querySelector<HTMLInputElement>('input[name="normalizeNames"]')?.checked === true;
    for (const n of form.querySelectorAll<HTMLElement>('.inventory [data-clean]')) n.textContent = clean ? n.dataset.clean! : n.dataset.original!;
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
    return h('figure', { className: 'weight mb-0' }, h('figcaption', { className: 'small text-body-secondary mb-2' }, this.t('weight')), bar, legend);
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
    return h('div', { className: 'problems' }, h('p', { className: 'problems-summary text-body-secondary' }, summary), items);
  }

  /** The technical findings stay one click away, in a side panel. */
  private renderDiagnosticsLink(list: readonly Diagnostic[]): HTMLElement {
    const count = (s: string): number => list.filter((d) => d.severity === s).length;
    const label =
      list.length === 0 ? this.t('problemsNone') : this.t('problemsLink', { errors: count('error'), warnings: count('warning'), info: count('info') });
    return h(
      'p',
      { className: 'mb-0' },
      h(
        'button',
        {
          type: 'button',
          className: 'btn btn-link p-0 problems-link',
          'aria-haspopup': 'dialog',
          disabled: list.length === 0,
          onclick: () => {
            const panel = this.sidePanel('problems', this.t('problems'), this.renderDiagnostics(list));
            panel.addEventListener('close', () => panel.remove());
            this.root.append(panel);
            panel.showModal();
          },
        },
        label,
      ),
    );
  }

  /** The files the table lists: the project's own, and its thumbnail. */
  private inventoryRows(entries: readonly InventoryEntry[]): InventoryEntry[] {
    return entries.filter((e) => e.role === 'user-asset' || e.path === 'screenshot.png');
  }

  private renderInventory(entries: readonly InventoryEntry[]): HTMLElement {
    const rows = this.inventoryRows(entries);
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
      const optimizable = e.kind === 'image' || e.kind === 'video' || e.kind === 'audio' || pdf || (e.kind === 'document' && ODF_FORMATS.has(e.format));
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
      const lead = this.pipeline.preview && (e.kind === 'image' || e.kind === 'video' || e.kind === 'audio' || pdf) ? this.previewButton(e) : undefined;
      body.append(
        h(
          'tr',
          { 'data-path': e.path, 'data-unused': e.role === 'user-asset' && e.usage === 'unreferenced' ? 'true' : undefined },
          h(
            'th',
            { scope: 'row', className: 'path fw-normal' },
            h(
              'span',
              { className: 'd-flex gap-2 align-items-baseline' },
              lead ?? h('span', { className: 'kind-icon preview-button text-body-secondary', 'aria-hidden': 'true' }, icon(kindIcon)),
              this.fileName(e.path, e.role === 'user-asset' && !e.path.startsWith('custom/')),
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
      { className: 'inventory-card' },
      h('div', { className: 'table-wrap table-responsive', tabindex: 0, role: 'region', 'aria-label': this.t('resources') }, table),
      h('p', { className: 'small text-body-secondary mb-0 pt-2' }, this.t('filesHelp')),
    );
  }

  /** A file's name, with where it is underneath (eXeLearning 3 folders named by their ID's end). */
  private fileName(path: string, renamable = false): HTMLElement {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash + 1);
    const legacy = LEGACY_FOLDER.exec(folder);
    const where =
      path === 'screenshot.png'
        ? this.t('thumbnailFile')
        : legacy
          ? this.t('legacyFolder', { id: legacy[1]!.slice(-6) })
          : folder === 'content/resources/'
            ? ''
            : short(folder);
    return h(
      'span',
      { className: 'file-name min-w-0' },
      h(
        'span',
        {
          className: 'd-block text-break',
          ...(renamable && cleanFileName(path.slice(slash + 1)) !== path.slice(slash + 1)
            ? { 'data-original': path.slice(slash + 1), 'data-clean': cleanFileName(path.slice(slash + 1)) }
            : {}),
        },
        path.slice(slash + 1),
      ),
      where ? h('span', { className: 'file-where d-block small text-body-secondary text-break' }, where) : false,
    );
  }

  /** Opens a file of the project in a window: image, video, audio (with its player) or PDF. */
  private previewButton(e: InventoryEntry): HTMLButtonElement {
    const pdf = e.format === 'pdf';
    const label = this.t(e.kind === 'audio' ? 'playAudio' : e.kind === 'video' ? 'playVideo' : pdf ? 'viewPdf' : 'viewImage', { name: short(e.path) });
    const button = h(
      'button',
      {
        type: 'button',
        className: 'preview-button btn btn-sm btn-light rounded-circle',
        'aria-label': label,
        title: label,
        'aria-haspopup': 'dialog',
        'data-path': e.path,
        onclick: () => void this.openPreview(e, button),
      },
      icon(e.kind === 'audio' ? 'music-note-beamed' : e.kind === 'video' ? 'camera-video' : pdf ? 'file-earmark-pdf' : 'image'),
    );
    return button;
  }

  /** Fetches a resource for preview, showing a spinner on the button meanwhile. */
  private async fetchBlob(e: InventoryEntry, button: HTMLButtonElement): Promise<Blob | undefined> {
    const request = ++this.previewRequest;
    const content = [...button.childNodes];
    button.disabled = true;
    replace(button, h('span', { className: 'spinner-border spinner-border-sm', 'aria-hidden': 'true' }));
    try {
      const blob = await this.pipeline.preview!(e.path);
      // Another preview, or leaving the review (see dropPreviews), replaced this one meanwhile.
      return request === this.previewRequest ? blob : undefined;
    } catch (error) {
      this.announce(this.t('previewFailed', { name: short(e.path), message: (error as Error).message }));
      return undefined;
    } finally {
      button.disabled = false;
      replace(button, ...content);
    }
  }

  /** Drops any preview still being read (a later answer is ignored). */
  private dropPreviews(): void {
    this.previewRequest++;
  }

  /** Shows an image or a PDF, or plays a video or an audio, in a modal window. */
  private async openPreview(e: InventoryEntry, button: HTMLButtonElement): Promise<void> {
    const blob = await this.fetchBlob(e, button);
    if (!blob) return;
    const url = this.urls.createObjectURL(blob);
    let media: HTMLElement;
    let release = (): void => undefined;
    if (e.format === 'pdf') {
      // Drawn page by page into a canvas by pdf.js (loaded now): the document is shown, never run.
      const canvas = h('canvas', { className: 'preview-media preview-pdf', role: 'img', 'aria-label': short(e.path) });
      const status = h('span', { className: 'small text-body-secondary', 'aria-live': 'polite' });
      const prev = h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', disabled: true }, this.t('pdfPrev'));
      const next = h('button', { type: 'button', className: 'btn btn-sm btn-outline-secondary', disabled: true }, this.t('pdfNext'));
      media = h(
        'div',
        { className: 'pdf-view d-flex flex-column align-items-center gap-2' },
        canvas,
        h('div', { className: 'd-flex align-items-center gap-2' }, prev, status, next),
      );
      void (async () => {
        try {
          const { openPdf } = await import('./pdf-preview.js');
          const pdf = await openPdf(new Uint8Array(await blob.arrayBuffer()));
          release = () => void pdf.destroy();
          let page = 1;
          const show = async (): Promise<void> => {
            prev.disabled = page <= 1;
            next.disabled = page >= pdf.pages;
            status.textContent = this.t('pdfPage', { page, pages: pdf.pages });
            // A drawing overtaken by another page, or by closing the window, is cancelled: not an error.
            await pdf.render(page, canvas as HTMLCanvasElement, Math.min(900, Math.max(280, media.clientWidth || 800))).catch(() => undefined);
          };
          prev.addEventListener('click', () => void ((page = Math.max(1, page - 1)), show()));
          next.addEventListener('click', () => void ((page = Math.min(pdf.pages, page + 1)), show()));
          await show();
        } catch (error) {
          status.textContent = this.t('previewFailed', { name: short(e.path), message: (error as Error).message });
        }
      })();
    } else {
      media =
        e.kind === 'video'
          ? // The player's own download would save the blob: URL without a name; the header offers a named one.
            h('video', { src: url, controls: true, autoplay: true, playsinline: true, controlslist: 'nodownload', className: 'preview-media' })
          : e.kind === 'audio'
            ? h('audio', { src: url, controls: true, autoplay: true, controlslist: 'nodownload', className: 'preview-audio w-100' })
            : h('img', { src: url, alt: short(e.path), className: 'preview-media preview-image' });
    }
    const size = e.image?.width
      ? `${e.image.width}×${e.image.height ?? '?'} · `
      : e.video?.width
        ? `${e.video.width}×${e.video.height ?? '?'} · `
        : e.pdf
          ? `${this.t(e.pdf.pages === 1 ? 'pdfPagesOne' : 'pdfPages', { count: e.pdf.pages })} · `
          : '';
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
      if (media instanceof HTMLMediaElement) media.pause();
      media.removeAttribute('src');
      release();
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
    const form = this.main.querySelector<HTMLFormElement>('form.review-form');
    if (form) this.syncRemoved(form);
  }

  /** The right column: the level, the estimated result and the button that runs it. */
  private renderChoose(): HTMLElement {
    const o = this.options;
    const group = h('div', { className: 'list-group preset-group' });
    for (const p of ['conservative', 'balanced', 'aggressive'] as const) {
      group.append(
        h(
          'label',
          { className: 'list-group-item d-flex gap-3 align-items-start radio' },
          h('input', { type: 'radio', name: 'preset', value: p, checked: (o.preset ?? 'balanced') === p, className: 'form-check-input flex-shrink-0 mt-1' }),
          h(
            'span',
            {},
            h('strong', { className: 'd-block' }, this.t(`preset_${p}`)),
            h('span', { className: 'help small text-body-secondary' }, this.t(`preset_${p}_help`)),
          ),
        ),
      );
    }
    const check = (text: string): HTMLElement => h('li', { className: 'd-flex gap-2' }, icon('check-circle-fill', 'text-success flex-none'), text);
    return h(
      'aside',
      { className: 'panel card options-card', 'aria-labelledby': 'h-step3' },
      h(
        'div',
        { className: 'card-body d-flex flex-column gap-3' },
        h('h2', { id: 'h-step3', tabindex: -1, className: 'h5 mb-0' }, this.t('step3')),
        h('fieldset', {}, h('legend', { className: 'form-label fw-bold fs-6' }, this.t('preset')), group),
        h('hr', { className: 'my-1' }),
        this.renderEstimate(),
        h(
          'button',
          { type: 'submit', className: 'btn btn-primary btn-lg w-100 optimize-button', disabled: !this.plan || this.plan.operations.length === 0 },
          this.t('optimize'),
        ),
        h(
          'ul',
          { className: 'promises list-unstyled small d-flex flex-column gap-2 mb-0' },
          check(this.t('promiseOriginal')),
          check(this.t('promiseLocal')),
          check(this.t('promiseEditable')),
        ),
      ),
    );
  }

  /** On narrow screens, the estimate and the button stay at the bottom of the screen. */
  private renderMobileBar(): HTMLElement {
    const plan = this.plan;
    const before = this.analysis!.input.size;
    const saved = plan ? Math.min(before, plan.estimate.savedBytes) : 0;
    return h(
      'div',
      { className: 'mobile-bar d-lg-none', 'data-role': 'mobile-bar' },
      h(
        'div',
        { className: 'flex-grow-1 min-w-0' },
        h('span', { className: 'd-block small text-body-secondary' }, this.t('estimateTitle')),
        h('span', { className: 'mobile-bar-figure' }, plan && saved > 0 ? `≈ −${percent(saved / Math.max(1, before), this.lang)}` : '—'),
      ),
      h('button', { type: 'submit', className: 'btn btn-primary optimize-button', disabled: !plan || plan.operations.length === 0 }, this.t('optimize')),
    );
  }

  /** The estimate of the current plan (made by the core before anything is encoded). */
  private renderEstimate(): HTMLElement {
    const plan = this.plan;
    const box = h(
      'div',
      { className: 'estimate-block', 'data-role': 'estimate', 'aria-live': 'polite' },
      h('h3', { className: 'h6 mb-2' }, this.t('estimateTitle')),
    );
    if (this.planError) {
      box.append(h('p', { className: 'text-danger small mb-0' }, this.t('planError', { message: this.planError })));
      return box;
    }
    if (!plan) {
      box.append(h('p', { className: 'text-body-secondary small mb-0' }, this.t('estimatePending')));
      return box;
    }
    if (plan.operations.length === 0) {
      box.append(h('p', { className: 'text-body-secondary mb-0 plan-empty' }, this.t('planEmpty')));
      return box;
    }
    const before = this.analysis!.input.size;
    const saved = Math.min(before, plan.estimate.savedBytes);
    const after = before - saved;
    const bar = (label: string, value: number, cls: string): HTMLElement => {
      const fill = h('span', { className: `fill ${cls}` });
      fill.style.width = `${(value / Math.max(1, before)) * 100}%`;
      return h(
        'div',
        { className: 'compare-row' },
        h('span', { className: 'compare-label' }, label),
        h('span', { className: 'compare-track' }, fill),
        h('span', { className: 'num text-end' }, `${label === this.t('after') ? '≈ ' : ''}${bytes(value, this.lang)}`),
      );
    };
    if (saved > 0) box.append(h('p', { className: 'estimate-figure mb-0' }, `≈ −${percent(saved / Math.max(1, before), this.lang)}`));
    box.append(
      h(
        'p',
        { className: 'estimate-detail text-body-secondary small' },
        this.t(saved > 0 ? 'estimateDetail' : 'estimateNoSaving', { size: bytes(saved, this.lang) }),
      ),
      h('div', { className: 'compare compare-sm' }, bar(this.t('before'), before, 'fill-before'), bar(this.t('after'), after, 'fill-after')),
    );
    if (plan.skipped.length > 0) {
      box.append(
        h(
          'details',
          { className: 'skipped small mt-2' },
          h('summary', {}, `${this.t('planSkipped')} (${plan.skipped.length})`),
          h(
            'ul',
            { className: 'plan-skipped mb-0 ps-3 mt-1' },
            ...plan.skipped.slice(0, 200).map((x) => h('li', {}, `${short(this.shownPath(x.path))}: ${x.detail}`)),
          ),
        ),
      );
    }
    const notes = this.riskNotes(plan);
    if (notes.length > 0) {
      box.append(
        h(
          'details',
          { className: 'risks small mt-2' },
          h('summary', {}, this.t('riskTitle')),
          h('ul', { className: 'mb-0 ps-3 mt-1' }, ...notes.map((r) => h('li', { className: 'note' }, r))),
        ),
      );
    }
    return box;
  }

  /** Advanced options: every value defaults to the level's, shown as the field's placeholder. */
  private renderAdvanced(): HTMLElement {
    const o = this.options;
    const num = (name: string, label: string, min: number, max: number, value: number | undefined): HTMLElement =>
      h(
        'div',
        {},
        h('label', { className: 'form-label small mb-1', for: `opt-${name}` }, this.t(label)),
        h('input', {
          type: 'number',
          id: `opt-${name}`,
          name,
          min,
          max,
          inputmode: 'numeric',
          value: value ?? '',
          className: 'form-control form-control-sm',
          'data-level': name,
        }),
      );
    const check = (name: string, label: string, checked: boolean): HTMLElement =>
      h(
        'div',
        { className: 'form-check mb-0' },
        h('input', { type: 'checkbox', name, id: `opt-${name}`, checked, className: 'form-check-input' }),
        h('label', { className: 'form-check-label', for: `opt-${name}` }, this.t(label)),
      );
    const res = h('select', { name: 'maxResolution', id: 'opt-maxResolution', className: 'form-select form-select-sm' });
    res.append(h('option', { value: 'profile', selected: o.video?.maxResolution === undefined, 'data-level': 'maxResolution' }, this.t('byPreset')));
    for (const r of ['original', '2160', '1440', '1080', '720', '480', '360']) {
      res.append(h('option', { value: r, selected: String(o.video?.maxResolution ?? '') === r }, r === 'original' ? this.t('original') : `${r}p`));
    }
    const current = o.images?.maxDimension;
    const size = h('select', { name: 'imageSize', id: 'opt-imageSize', className: 'form-select form-select-sm' });
    size.append(h('option', { value: 'profile', selected: current === undefined, 'data-level': 'imageSize' }, this.t('imageSizeProfile')));
    for (const px of [1280, 1600, 1920, 2560]) size.append(h('option', { value: px, selected: current === px }, `${px} px`));
    size.append(h('option', { value: 'none', selected: current === null }, this.t('imageSizeNone')));
    const group = (title: string, ...children: HTMLElement[]): HTMLElement =>
      h('fieldset', { className: 'adv-group' }, h('legend', { className: 'fw-bold fs-6' }, this.t(title)), ...children);
    const details = h(
      'details',
      { className: 'advanced card', open: this.advancedOpen },
      h(
        'summary',
        { className: 'card-header d-flex align-items-center gap-2' },
        icon('gear'),
        h('h3', { className: 'h5 mb-0 flex-grow-1' }, this.t('advanced')),
        h('span', { className: 'small text-body-secondary d-none d-sm-inline' }, this.t('advancedLead')),
      ),
      h(
        'div',
        { className: 'card-body adv-grid' },
        group(
          'advVideo',
          check('video', 'videoEnabled', o.video?.enabled !== false),
          h('div', {}, h('label', { className: 'form-label small mb-1', for: 'opt-maxResolution' }, this.t('videoResolution')), res),
          num('crf', 'videoQuality', 16, 35, o.video?.crf),
          num('audioBitrate', 'audioBitrate', 64, 320, o.video?.audioBitrate),
        ),
        group(
          'advImages',
          check('images', 'imagesEnabled', o.images?.enabled !== false),
          h('div', {}, h('label', { className: 'form-label small mb-1', for: 'opt-imageSize' }, this.t('imageSize')), size),
          num('jpegQuality', 'jpegQuality', 30, 100, o.images?.jpegQuality),
          num('webpQuality', 'webpQuality', 30, 100, o.images?.webpQuality),
          check('png', 'optimizePng', o.images?.png !== false),
          check('stripMetadata', 'stripMetadata', o.images?.stripMetadata === true),
          check('includeScreenshot', 'includeScreenshot', o.images?.includeScreenshot === true),
        ),
        group('advAudio', check('audio', 'audioEnabled', o.audio?.enabled !== false), num('audioFilesBitrate', 'audioFilesBitrate', 64, 320, o.audio?.bitrate)),
        group(
          'advPdf',
          check('pdf', 'pdfEnabled', o.pdf?.enabled !== false),
          check('pdfLossless', 'pdfLossless', o.pdf?.images === false),
          check('odf', 'odfEnabled', o.odf?.enabled !== false),
          check('multithread', 'threadsMulti', this.threading !== 'single'),
        ),
      ),
    );
    details.addEventListener('toggle', () => (this.advancedOpen = details.open));
    return details;
  }

  /** Shows the chosen level's values where an advanced field is left to the level. */
  private updateLevelHints(form: HTMLFormElement): void {
    const preset = (new FormData(form).get('preset') ?? 'balanced') as Preset;
    const video = VIDEO_PROFILES[preset];
    const image = IMAGE_PROFILES[preset];
    const values: Record<string, string> = {
      crf: String(video.crf),
      audioBitrate: String(video.audioBitrateKbps),
      jpegQuality: String(image.jpegQuality),
      webpQuality: String(image.webpQuality),
      audioFilesBitrate: String(AUDIO_PROFILES[preset].bitrateKbps),
    };
    for (const el of form.querySelectorAll<HTMLInputElement>('input[data-level]')) {
      el.placeholder = this.t('levelValue', { value: values[el.dataset['level']!]! });
    }
    const res = form.querySelector('option[data-level="maxResolution"]');
    if (res) res.textContent = `${this.t('byPreset')} (${video.maxShortSide === 'original' ? this.t('original') : `${video.maxShortSide}p`})`;
    const size = form.querySelector('option[data-level="imageSize"]');
    if (size) size.textContent = `${this.t('imageSizeProfile')} (${image.maxDimension} px)`;
  }

  /**
   * The project thumbnail: a new screenshot.png drawn from the first page or chosen by the user
   * (the current one is previewed from its row in the contents).
   */
  private renderScreenshot(): HTMLElement {
    const box = h('section', { className: 'screenshot card', 'aria-labelledby': 'h-screenshot' });
    // A new thumbnail changes the options (its hash): plan again.
    const changed = (): void => void box.dispatchEvent(new Event('change', { bubbles: true }));
    const status = h('p', { className: 'screenshot-status small mb-0', 'aria-live': 'polite' });
    const fill = (): void => {
      const a = this.analysis!;
      const preview = this.screenshot
        ? h('img', {
            className: 'screenshot-preview screenshot-thumb border rounded',
            src: this.screenshot.url,
            alt: this.t('screenshotNew'),
            width: 128,
            height: 72,
          })
        : h('span', { className: 'screenshot-thumb screenshot-empty border rounded', 'aria-hidden': 'true' }, icon('image'));
      const current = this.t(this.screenshot ? 'screenshotReadyShort' : a.package?.hasScreenshot ? 'screenshotCurrent' : 'screenshotNone');
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
          changed();
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
                changed();
                status.textContent = '';
              },
            },
            this.t('screenshotDiscard'),
          ),
        );
      }
      replace(
        box,
        h(
          'div',
          { className: 'card-body d-flex flex-column gap-2' },
          h(
            'div',
            { className: 'd-flex align-items-start gap-3' },
            preview,
            h(
              'div',
              { className: 'flex-grow-1 min-w-0 d-flex flex-column gap-2' },
              h(
                'div',
                {},
                h('h3', { id: 'h-screenshot', className: 'h6 mb-1' }, this.t('screenshot')),
                h('p', { className: 'small text-body-secondary mb-0 screenshot-current' }, current),
              ),
              h('div', { className: 'd-flex flex-wrap gap-2' }, ...buttons),
            ),
          ),
          file,
          h('p', { className: 'form-text mt-0 mb-0' }, this.t('screenshotHelp')),
          status,
        ),
      );
    };
    fill();
    return box;
  }

  /** How many files would get a clean name, with one example. */
  private namesHelp(): string {
    const changes = this.analysis!.entries.filter((e) => !e.isDirectory && e.role === 'user-asset' && !e.path.startsWith('custom/'))
      .map((e) => e.path.slice(e.path.lastIndexOf('/') + 1))
      .filter((name) => cleanFileName(name) !== name);
    return changes.length === 0
      ? this.t('normalizeNamesClean')
      : this.t(changes.length === 1 ? 'normalizeNamesHelpOne' : 'normalizeNamesHelp', {
          count: changes.length,
          from: changes[0]!,
          to: cleanFileName(changes[0]!),
        });
  }

  /** Reads the options form into OptionsInput. */
  readOptions(form: HTMLFormElement): OptionsInput {
    const data = new FormData(form);
    const n = (k: string): number | undefined => {
      const v = String(data.get(k) ?? '').trim();
      return v === '' ? undefined : Number(v);
    };
    const on = (k: string): boolean => data.get(k) !== null;
    // The media card's switch turns every kind off; without it (a bare form) each kind decides.
    if (form.elements.namedItem('recompress')) this.recompress = on('recompress');
    const media = (k: string): boolean => this.recompress && on(k);
    // A card is shown only when the project needs it: without its switch, the choice made before stays.
    const kept = <K extends 'removeUnused' | 'deduplicate' | 'flatten' | 'missingReferences'>(
      k: K,
      yes: NonNullable<OptionsInput[K]>,
      no: NonNullable<OptionsInput[K]>,
    ): NonNullable<OptionsInput[K]> => (form.elements.namedItem(k) ? (on(k) ? yes : no) : (this.options[k] ?? no));
    const video: NonNullable<OptionsInput['video']> = { enabled: media('video') };
    const res = String(data.get('maxResolution') ?? '');
    if (res && res !== 'profile') video.maxResolution = res;
    const crf = n('crf');
    if (crf !== undefined) video.crf = crf;
    const ab = n('audioBitrate');
    if (ab !== undefined) video.audioBitrate = ab;
    const images: NonNullable<OptionsInput['images']> = {
      enabled: media('images'),
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
    const audio: NonNullable<OptionsInput['audio']> = { enabled: media('audio') };
    // Unchecked, the preset decides whether images inside PDFs are converted.
    const pdf: NonNullable<OptionsInput['pdf']> = { enabled: media('pdf'), ...(on('pdfLossless') ? { images: false } : {}) };
    const odf: NonNullable<OptionsInput['odf']> = { enabled: media('odf') };
    const afb = n('audioFilesBitrate');
    if (afb !== undefined) audio.bitrate = afb;
    this.threading = on('multithread') ? 'auto' : 'single';
    return {
      preset: String(data.get('preset') ?? 'balanced') as OptionsInput['preset'],
      video,
      images,
      audio,
      pdf,
      odf,
      removeUnused: kept('removeUnused', 'safe', 'off'),
      deduplicate: kept('deduplicate', 'exact', 'off'),
      flatten: kept('flatten', 'legacy', 'off'),
      missingReferences: kept('missingReferences', 'remove', 'keep'),
      // Read from the switch itself: it stays checked, but disabled (so absent from FormData), when names are already clean.
      normalizeNames: form.querySelector<HTMLInputElement>('input[name="normalizeNames"]')?.checked ? 'slug' : 'off',
      exclude: [...this.excluded],
      ...(this.screenshot ? { screenshot: { sha256: this.screenshot.sha256, size: this.screenshot.size } } : {}),
    };
  }

  /** Makes the plan again shortly after the options change. */
  private schedulePlan(form: HTMLFormElement, delay = 150): void {
    clearTimeout(this.planTimer);
    this.planTimer = setTimeout(() => void this.refreshPlan(form), delay);
  }

  /** Plans the current options; an answer overtaken by a newer request is dropped. */
  private async refreshPlan(form: HTMLFormElement): Promise<void> {
    if (this.view !== 'review' || !form.isConnected) return;
    const options = this.readOptions(form);
    // The choices are kept at once (a re-render, e.g. another language, shows them), planned or not.
    this.options = options;
    const key = JSON.stringify(options);
    if (key === this.planKey && this.plan && this.planFor === this.planRequest) return;
    const request = ++this.planRequest;
    try {
      const plan = await this.pipeline.plan(options);
      if (request !== this.planRequest) return;
      Object.assign(this, { plan, planFor: request, planKey: key, planError: '' });
    } catch (error) {
      if (request !== this.planRequest) return;
      Object.assign(this, { plan: undefined, planKey: '', planError: (error as Error).message });
    }
    this.updatePlanView();
  }

  /** Refreshes what depends on the plan: the media card, the estimate and the button. */
  private updatePlanView(): void {
    if (this.view !== 'review') return;
    const media = this.main.querySelector('[data-role="media"]');
    if (media) this.fillMediaSummary(media);
    this.main.querySelector('[data-role="estimate"]')?.replaceWith(this.renderEstimate());
    this.main.querySelector('[data-role="mobile-bar"]')?.replaceWith(this.renderMobileBar());
    for (const button of this.main.querySelectorAll<HTMLButtonElement>('.optimize-button')) button.disabled = !this.plan || this.plan.operations.length === 0;
  }

  /** Runs the plan of the current options, planning them first when the last plan is not theirs. */
  private async optimizeNow(form: HTMLFormElement): Promise<void> {
    clearTimeout(this.planTimer);
    const options = this.readOptions(form);
    const key = JSON.stringify(options);
    // The worker keeps only the last plan it made: reuse ours only when it is that one.
    if (!(this.plan && key === this.planKey && this.planFor === this.planRequest)) {
      const request = ++this.planRequest;
      try {
        const plan = await this.pipeline.plan(options);
        Object.assign(this, { plan, planFor: request, planKey: key, planError: '', options });
      } catch (error) {
        this.showError((error as { code?: string }).code ?? 'error', (error as Error).message);
        return;
      }
    }
    if (this.plan!.operations.length === 0) {
      this.updatePlanView();
      return;
    }
    this.options = options;
    await this.run();
  }

  /** Warnings about the plan, derived from its operations so they follow the interface language. */
  private riskNotes(plan: OptimizationPlan): string[] {
    const ops = plan.operations;
    const has = (kind: PlanOperation['op']): boolean => ops.some((o) => o.op === kind);
    const notes: string[] = [];
    if (ops.some((o) => o.op === 'transcode-video' || o.op === 'transcode-audio' || ((o.op === 'recompress-image' || o.op === 'optimize-odf') && o.lossy)))
      notes.push(this.t('risk_lossy'));
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
    const hero: Child[] = [
      h(
        'p',
        { className: `result-status status-${report.status} text-${kind} d-flex align-items-center justify-content-center gap-2 fw-bold mb-0` },
        icon(statusIcon),
        this.t(`status_${report.status}`),
      ),
    ];
    // Never imply that videos were optimized when every planned one kept its original.
    const videos = report.operations.filter((o) => o.op === 'transcode-video');
    const videosKept = videos.length > 0 && !videos.some((o) => o.status === 'applied');
    if (output) {
      if (s.saved > 0) {
        hero.push(
          h('p', { className: 'saved-figure mb-0' }, this.t('savedShort', { percent: percent(s.saved / s.before, this.lang) })),
          h(
            'p',
            { className: 'saved text-body-secondary mb-0' },
            this.t('savedDetail', { size: bytes(s.saved, this.lang), before: bytes(s.before, this.lang), after: bytes(s.after, this.lang) }),
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
      // A named File: browsers that ignore the download attribute for blob: URLs fall back to its name.
      const url = this.urls.createObjectURL(new File([output], fileName, { type: output.type || 'application/zip' }));
      this.objectUrls.push(url);
      hero.push(
        h('div', { className: 'compare w-100' }, bar(this.t('before'), s.before, 'fill-before'), bar(this.t('after'), s.after, 'fill-after')),
        h(
          'a',
          {
            className: 'btn btn-primary btn-lg d-inline-flex align-items-center gap-2 download-button',
            href: url,
            download: fileName,
            'data-testid': 'download',
          },
          icon('download'),
          this.t('download'),
        ),
        h('p', { className: 'small text-body-secondary mb-0 download-name' }, this.t('downloadName', { name: fileName })),
      );
    }
    const reportUrl = this.urls.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' }));
    this.objectUrls.push(reportUrl);
    return h(
      'div',
      { className: 'result-view d-flex flex-column align-items-center gap-4' },
      h(
        'section',
        { className: 'step step-step6 card result-hero', 'aria-labelledby': 'h-step6' },
        h(
          'div',
          { className: 'card-body d-flex flex-column align-items-center text-center gap-3' },
          h('h2', { id: 'h-step6', tabindex: -1, className: 'visually-hidden' }, this.t('step6')),
          ...hero,
        ),
      ),
      videosKept ? h('p', { className: 'callout alert alert-light border mb-0 result-width', role: 'note' }, this.t('videosKept')) : false,
      h(
        'section',
        { className: 'card changes result-width', 'aria-labelledby': 'h-changes' },
        h(
          'div',
          { className: 'card-body d-flex flex-column gap-3' },
          h('h3', { id: 'h-changes', className: 'h5 mb-0' }, this.t('changesTitle')),
          this.renderChanges(report),
          this.renderOperationResults(report),
          h(
            'p',
            { className: 'mb-0' },
            h(
              'a',
              {
                href: reportUrl,
                download: fileName.replace(/\.elpx$/, '_report.json'),
                'data-testid': 'download-report',
                className: 'd-inline-flex align-items-center gap-1',
              },
              icon('filetype-json'),
              this.t('downloadReport'),
            ),
          ),
        ),
      ),
      h(
        'button',
        { type: 'button', className: 'btn btn-outline-primary d-inline-flex align-items-center gap-2', onclick: () => this.reset() },
        icon('arrow-repeat'),
        this.t('another'),
      ),
    );
  }

  /** What changed, in plain words, from the report. */
  private renderChanges(report: OptimizationReport): HTMLElement {
    const ops = report.operations;
    const applied = (op: string): OperationResult[] => ops.filter((o) => o.op === op && o.status === 'applied');
    const saved = (list: readonly OperationResult[]): number => list.reduce((s, o) => s + Math.max(0, (o.before ?? 0) - (o.after ?? 0)), 0);
    const items: [IconName, string][] = [];
    const media: [string, string][] = [
      ['transcode-video', 'chVideo'],
      ['recompress-image', 'chImage'],
      ['transcode-audio', 'chAudio'],
      ['optimize-pdf', 'chPdf'],
      ['optimize-odf', 'chOdf'],
    ];
    for (const [op, key] of media) {
      const list = applied(op);
      if (list.length > 0)
        items.push(['check-circle-fill', this.t(list.length === 1 ? `${key}One` : key, { count: list.length, size: bytes(saved(list), this.lang) })]);
    }
    const kept = ops.filter((o) => media.some(([m]) => m === o.op) && (o.status === 'reverted' || o.status === 'skipped')).length;
    if (kept > 0) items.push(['info-circle-fill', this.t(kept === 1 ? 'chKeptOne' : 'chKept', { count: kept })]);
    const failed = ops.filter((o) => o.status === 'failed').length;
    if (failed > 0) items.push(['x-circle-fill', this.t(failed === 1 ? 'chFailedOne' : 'chFailed', { count: failed })]);
    const simple: [string, string][] = [
      ['remove-unused', 'chUnused'],
      ['deduplicate', 'chDup'],
      ['move-resource', 'chMoved'],
      ['rename-resource', 'chRenamed'],
      ['remove-missing-reference', 'chUnlinked'],
      ['replace-screenshot', 'chScreenshot'],
    ];
    for (const [op, key] of simple) {
      const n = applied(op).length;
      if (n > 0) items.push(['check-circle-fill', this.t(n === 1 ? `${key}One` : key, { count: n })]);
    }
    const passed = report.validations.filter((v) => v.ok).length;
    if (report.validations.length > 0) items.push(['shield-lock', this.t('chVerified', { passed, total: report.validations.length })]);
    const tone: Partial<Record<IconName, string>> = {
      'check-circle-fill': 'text-success',
      'info-circle-fill': 'text-body-secondary',
      'x-circle-fill': 'text-danger',
      'shield-lock': 'text-primary',
    };
    return h(
      'ul',
      { className: 'changes-list list-unstyled d-flex flex-column gap-2 mb-0' },
      ...items.map(([name, text]) =>
        h('li', { className: 'd-flex gap-2 align-items-start' }, h('span', { className: `flex-none ${tone[name] ?? ''}` }, icon(name)), text),
      ),
    );
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
    return h('details', { className: 'op-details' }, h('summary', {}, `${this.t('opsDetail')} (${report.operations.length})`), list);
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

  /** Forgets the plan and any planning in flight. */
  private clearPlan(): void {
    clearTimeout(this.planTimer);
    this.planRequest++;
    this.plan = undefined;
    this.planKey = '';
    this.planError = '';
  }

  /** Returns to the first step, releasing downloads. */
  reset(): void {
    this.revokeUrls();
    this.dropScreenshot();
    this.file = undefined;
    this.analysis = undefined;
    this.clearPlan();
    this.result = undefined;
    this.go('start');
  }

  /** Current view (for tests and debugging). */
  get currentView(): View {
    return this.view;
  }
}
