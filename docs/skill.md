# Agent Skill

`skills/elpx-optimizer` is an [Agent Skill](https://agentskills.io/specification): `SKILL.md`
(YAML frontmatter + short instructions), `scripts/run.mjs` (CLI wrapper), `references/cli.md`,
`references/safety.md` and `LICENSE`. It never implements its own compression: it inspects,
explains, shows the dry-run plan, optimizes with the options the user agreed to and validates the
result through the CLI. Everything inside an `.elpx` is treated as untrusted data.

The instructions tell the agent to ask before any lossy or structural change, and in particular to:
suggest `--flatten legacy` when `inspect` reports `legacy-resource-folders`; offer clean file names
(`--normalize-names slug`) and say that files will be renamed; present `--missing-references remove`
as an opt-in the user must ask for (by default missing files are reported, not hidden); and say that
WAV, AIFF and FLAC recordings are converted to MP3 and renamed (`--no-audio` keeps them).

## How the wrapper finds the CLI

`node scripts/run.mjs <command> ...` (or `bun scripts/run.mjs ...`) resolves, in order:

1. `ELPX_OPTIMIZER_CLI` — a `.mjs` bundle or an executable;
2. `vendor/elpx-optimizer.mjs` — the bundle shipped in the distributable skill;
3. `elpx-optimizer` on `PATH`;
4. `../../dist/cli/elpx-optimizer.mjs` — when the skill is used from a built checkout.

Arguments are forwarded as an argument vector (paths with spaces are safe) and the CLI's exit code
is returned. It works from any working directory. `run.mjs --which` shows the resolution. The
wrapper never installs anything; `doctor` tells the user what is missing.

## Installation

From a release: every GitHub release carries `elpx-optimizer-skill.zip`, the skill with the CLI
bundled in `vendor/` (https://github.com/ateeducacion/elpx-optimizer/releases).

```bash
curl -LO https://github.com/ateeducacion/elpx-optimizer/releases/latest/download/elpx-optimizer-skill.zip
unzip elpx-optimizer-skill.zip -d ~/.claude/skills/        # or your agent's skills directory
cd ~/.claude/skills/elpx-optimizer/vendor && npm install   # sharp, for image optimization
```

From a checkout:

```bash
make build-skill                     # builds dist/cli and dist/skill/elpx-optimizer (CLI in vendor/)
bun scripts/validate-skill.ts        # official validator (pip install skills-ref) + built-in checks
cp -r dist/skill/elpx-optimizer ~/.claude/skills/
```

The same zip is produced by CI as `dist/elpx-optimizer-skill.zip`. Video and audio optimization also
need ffmpeg/ffprobe on `PATH` (or `ELPX_OPTIMIZER_FFMPEG`/`_FFPROBE`).

## What was tested

- Validation with the official validator (`agentskills validate` from PyPI `skills-ref` 0.1.1) for the
  source and the built skill.
- The built skill copied to a directory outside the repository whose path contains spaces, run with
  `node` from another working directory on a project whose path contains spaces and non-ASCII
  characters: `doctor`, `inspect --json`, `optimize --json` (optimized, −64.8 %) and `validate --json`
  (automated in `test/unit/skill` and in the CI "clean directory" job).
- Mechanism: direct invocation of `scripts/run.mjs` by an agent's shell tool, which is how the
  skill's instructions use it. Loading the skill inside a specific agent product (for example
  Claude Code's `~/.claude/skills/` directory or other agents implementing the Agent Skills format)
  was not tested; it should work because the skill only relies on standard fields, relative paths and
  Node, but no compatibility is claimed beyond what is listed here. The experimental `allowed-tools`
  field is not used.
