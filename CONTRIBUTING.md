# Contributing

Thanks for helping. Code, identifiers and comments are in English; user-facing text of the web app
exists in Spanish and English (`src/web/i18n.ts`).

## Setup

```bash
bun install --frozen-lockfile        # Bun ≥ 1.3, Node ≥ 22
npx playwright install chromium      # browser tests and E2E
# ffmpeg and ffprobe with libx264 on PATH for native media tests
make help
```

## Before opening a pull request

```bash
make lint typecheck        # ESLint, Prettier, TypeScript (the core is checked without DOM/Node types)
make coverage              # Vitest, Node + Chromium, ≥ 90 % lines/statements/functions/branches
make test-bun              # the same core and CLI under the Bun runtime
make e2e                   # Playwright against dist/web served statically
make skill-validate        # when touching skills/
make compat                # when touching format handling: eXeLearning's own importer/exporters
```

## Rules

- `src/core` stays portable: no `node:*`, Bun, DOM globals, sharp or ffmpeg.wasm imports. Put runtime
  code in `src/adapters/*` behind the interfaces in `src/core/media/engine.ts`, `src/core/io/*` and
  `src/core/optimize/optimize.ts`.
- Never loosen a safety rule to make a test pass: missing files are reported, not hidden; unknown or
  ambiguous references protect files; originals are kept on any doubt.
- Add a regression test for every bug fix. Tests use real ZIPs, real codecs and real FFmpeg where
  possible; fakes are for failures and timeouts.
- Fixtures must be synthetic (`scripts/generate-*`) or come from eXeLearning with provenance. Never
  add private projects.
- Document every function with a short comment before it. Keep diagnostics codes stable and
  regenerate `docs/diagnostics.md` (`bun scripts/generate-diagnostics-doc.ts`) when adding one.
- Updating eXeLearning compatibility: bump the SHA in `scripts/fetch-upstream.sh`,
  `src/core/version.ts` and `docs/upstream-review.md`, then run `make compat`.
