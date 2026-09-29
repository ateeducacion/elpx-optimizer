# Contributing

Thanks for helping. Code, identifiers and comments are in English; user-facing text of the web app
exists in Spanish and English (`src/web/i18n.ts`).

## Setup

```bash
bun install --frozen-lockfile        # Bun ≥ 1.3, Node ≥ 22
npx playwright install chromium      # browser tests and E2E
# ffmpeg and ffprobe with libx264 on PATH for native media tests (PDF tests need nothing extra:
# qpdf comes from npm as WebAssembly)
make help
```

## Before opening a pull request

```bash
make lint typecheck        # ESLint, Prettier, TypeScript (the core is checked without DOM/Node types)
make coverage              # Vitest, Node + Chromium, ≥ 90 % lines/statements/functions/branches
make test-bun              # the same core and CLI under the Bun runtime
make e2e                   # Playwright against dist/web served statically
make skill-validate        # when touching skills/
make compat                # when touching format, reference or restructuring code: eXeLearning's own importer/exporters
```

## Rules

- `src/core` stays portable: no `node:*`, Bun, DOM globals, sharp, ffmpeg.wasm or qpdf-wasm imports.
  Put runtime code in `src/adapters/*` behind the interfaces in `src/core/media/engine.ts`,
  `src/core/io/*` and `src/core/optimize/optimize.ts`.
- Never loosen a safety rule to make a test pass: missing files are reported, not hidden (taking out
  their references stays an explicit opt-in); unknown or ambiguous references protect files from
  removal, moves and renames; originals are kept on any doubt.
- The web app's styles come from `src/web/theme.scss` (Bootstrap compiled with Sass at build time)
  and `src/web/styles.css`; no CDN, and the Content-Security-Policy in `vite.config.ts` must not be
  loosened. Every interface string needs its Spanish and English text in `src/web/i18n.ts`.
- Add a regression test for every bug fix. Tests use real ZIPs, real codecs and real FFmpeg where
  possible; fakes are for failures and timeouts.
- Fixtures must be synthetic (`scripts/generate-*`) or come from eXeLearning with provenance. Never
  add private projects.
- Document every function with a short comment before it. Keep diagnostics codes stable and
  regenerate `docs/diagnostics.md` (`bun scripts/generate-diagnostics-doc.ts`) when adding one.
- Dependencies are pinned to exact versions. Dependabot (`.github/dependabot.yml`) opens grouped
  weekly pull requests for Bun (`package.json`, `bun.lock`), the Docker base images and the GitHub
  Actions. When a component the builds redistribute changes (sharp, ffmpeg.wasm, jSquash, fflate,
  `@noble/hashes`, `@neslinesli93/qpdf-wasm`), update its entry in `THIRD-PARTY-NOTICES.md` (and
  `licenses/qpdf-wasm-NOTICES.txt` and `QPDF_VERSION` for qpdf). Keep the `Dockerfile` base images
  as literal `FROM` lines, without `ARG`s, so Dependabot can update them, and `bun.lock` at
  `"lockfileVersion": 1` (Dependabot cannot read 2; CI checks it).
- Releases: bump the version (`package.json`, `src/core/version.ts`, the skill's `SKILL.md`), merge,
  and publish a GitHub release whose title is only the tag (`vX.Y.Z`), not marked as a pre-release
  (the docs link `releases/latest`). `.github/workflows/release.yml` pushes the images, deploys GitHub
  Pages and attaches the assets. To publish an existing release again (for example after a failed
  image job), run the workflow by hand with its tag.
- Updating eXeLearning compatibility: bump the SHA in `scripts/fetch-upstream.sh`,
  `src/core/version.ts` and `docs/upstream-review.md`, then run `make compat`.
