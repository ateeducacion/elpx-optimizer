# elpx-optimizer — common tasks. Requires Bun (>= 1.3) and Node (>= 22).
# Native video tests need ffmpeg/ffprobe; E2E needs Playwright browsers.

BUN ?= bun
NPX ?= npx
IMAGE ?= elpx-optimizer

.PHONY: help install dev build build-web build-cli build-skill lint format typecheck test test-node test-browser test-bun coverage e2e e2e-install fixtures skill-validate compat check docker clean

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-16s %s\n", $$1, $$2}'

install: ## Install dependencies from the lockfile
	$(BUN) install --frozen-lockfile

dev: ## Start the web app in development mode
	$(BUN) run dev

build: build-web build-cli build-skill ## Build web app, CLI bundle and skill

build-web: ## Build the static web app into dist/web
	$(BUN) run build:web

build-cli: ## Bundle the CLI into dist/cli
	$(BUN) scripts/build-cli.ts

build-skill: build-cli ## Assemble the distributable skill into dist/skill
	$(BUN) scripts/build-skill.ts

lint: ## ESLint and Prettier check
	$(NPX) eslint .
	$(NPX) prettier --check .

format: ## Format the code base
	$(NPX) prettier --write .

typecheck: ## TypeScript (core without DOM/Node types, node, web and everything)
	$(BUN) run typecheck

test-node: ## Unit and integration tests (Node)
	$(NPX) vitest run --project node

test-browser: ## Browser adapter and UI tests (headless Chromium)
	$(NPX) vitest run --project browser

test-bun: ## Smoke tests under the Bun runtime
	$(BUN) test test/bun

test: test-node test-browser test-bun ## All unit/integration tests

coverage: ## Coverage (V8, Node + Chromium merged) with 90% thresholds
	$(NPX) vitest run --coverage

e2e-install: ## Install Playwright browsers
	$(NPX) playwright install chromium firefox webkit

e2e: build-web ## End-to-end tests of the static web app
	$(NPX) playwright test

fixtures: ## Regenerate synthetic fixtures (needs ffmpeg)
	node scripts/generate-media-fixtures.mjs
	$(BUN) scripts/generate-elpx-fixtures.ts

skill-validate: ## Validate the Agent Skill (official validator when installed)
	$(BUN) scripts/validate-skill.ts

compat: build-cli ## Independent check with eXeLearning's own importer/exporters (network for the first run)
	sh scripts/fetch-upstream.sh
	$(BUN) test/compat/run-compat.ts

check: lint typecheck coverage test-bun skill-validate e2e ## Everything CI runs (except compat and Docker)

docker: ## CLI Docker image (Bun, ffmpeg, sharp)
	docker build --target cli -t $(IMAGE) .

clean: ## Remove build and test outputs
	rm -rf dist coverage coverage-* test-results playwright-report
