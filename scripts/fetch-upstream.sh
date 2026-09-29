#!/usr/bin/env sh
# Clones eXeLearning at the pinned SHA into .cache/upstream/exelearning and
# installs its dependencies. Used by the independent compatibility check
# (make compat). Requires git, bun and network access (only for this step).
set -eu
SHA="406a2158623da1862e9f50fdfd5e358b818c9aa8"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/.cache/upstream/exelearning"
if [ ! -d "$DIR/.git" ]; then
  mkdir -p "$(dirname "$DIR")"
  git clone --filter=blob:none https://github.com/exelearning/exelearning.git "$DIR"
fi
cd "$DIR"
if ! git cat-file -e "$SHA^{commit}" 2>/dev/null; then git fetch origin "$SHA"; fi
git -c advice.detachedHead=false checkout --quiet "$SHA"
test "$(git rev-parse HEAD)" = "$SHA"
if [ ! -d node_modules ]; then bun install --frozen-lockfile; fi
mkdir -p .elpx-harness
cp "$ROOT/test/compat/upstream-roundtrip.ts" .elpx-harness/roundtrip.ts
echo "eXeLearning $SHA ready in $DIR"
