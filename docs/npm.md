# Publishing the CLI on npm (analysis)

Question: is it worth publishing the CLI on npm, so that anyone with Node can run
`npx elpx-optimizer optimize curso.elpx` without installing anything else, and would it work?

Short answer: it works today, with the package the build already produces, and it is worth
publishing. Video and audio still need FFmpeg on the machine, as with any other native install. The
steps are at the end.

## What exists already

- `bun run build:cli` writes `dist/cli/`: `elpx-optimizer.mjs` (the whole CLI bundled, 640 KB),
  `qpdf-runner.mjs`, `LICENSE`, `README.md` and a `package.json` with `bin: { "elpx-optimizer": … }`,
  `engines.node` and two dependencies, `sharp` and `@neslinesli93/qpdf-wasm`
  (`scripts/build-cli.ts`). `npm pack` turns it into a 169 KB tarball.
- CI already installs that tarball with npm in a clean directory and runs `npx elpx-optimizer`
  `doctor`, `inspect`, `optimize` and `validate` on a project with spaces in its name (job "Build and
  test packaged distributions"). The release attaches the tarball to the GitHub release.

So the only missing piece is the registry.

## Verified

From an empty directory, on macOS arm64 with Node 26, using the packed tarball (then still named
`elpx-optimizer-cli`) the way npx uses a published package:

```sh
npx -y --package=./elpx-optimizer-cli-0.1.1.tgz elpx-optimizer doctor
npx -y --package=./elpx-optimizer-cli-0.1.1.tgz elpx-optimizer optimize "mi curso.elpx" --json
```

`doctor` found every capability (FFmpeg from the system, sharp 0.35.5 with libvips 8.18.7, qpdf
12.2.0 in WebAssembly) and reported the web app as not included. `optimize` turned the 2.9 MB test
course into 1.1 MB (−62 %). The first run, including the download of sharp, took under 4 seconds.

## What a user gets with npx

| Capability                   | With `npx elpx-optimizer`                                                                                                                                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inspect`, `validate`        | Always: pure JavaScript.                                                                                                                                                                                                                                         |
| PDFs                         | Always: qpdf compiled to WebAssembly, run in a child process (`qpdf-runner.mjs`).                                                                                                                                                                                |
| Images                       | sharp installs a prebuilt libvips for the platform through optional dependencies (`@img/sharp-*`), with no build and no install script. Where no prebuilt binary exists, sharp is loaded lazily, so the rest keeps working and `doctor` says why images are off. |
| Video and audio              | Only when `ffmpeg` and `ffprobe` are on `PATH` (or given with `--ffmpeg`/`--ffprobe` or `ELPX_OPTIMIZER_FFMPEG`/`FFPROBE`). Otherwise the plan leaves them unchanged with the reason `engine-unavailable`, and `doctor` says so.                                 |
| `serve` (the static web app) | Not included: `dist/web` weighs tens of megabytes because of the ffmpeg.wasm cores. The web app is on GitHub Pages.                                                                                                                                              |

### FFmpeg is not bundled

`ffmpeg-static` or similar packages would download a GPL FFmpeg build (tens of MB per platform) in a
postinstall script. That is blocked by `--ignore-scripts` and by many corporate proxies, adds a
binary this project cannot rebuild or verify, and changes the licensing of what is distributed. The
native engine already detects FFmpeg and explains its absence, the Docker image
(`ghcr.io/ateeducacion/elpx-optimizer`) carries it, and the web app has ffmpeg.wasm. Not
recommended.

### Node version

`engines.node` is `>=22.12.0`. npm only warns when it does not match, so on an older Node the CLI
would start and fail with an unrelated error. A one-line check at the start of `src/cli/bin.ts`
(compare `process.versions.node` and print "elpx-optimizer needs Node 22.12 or newer") would turn
that into a clear message.

## Name

As of 2026-09-29 neither `elpx-optimizer`, `elpx-optimizer-cli` nor `@ateeducacion/elpx-optimizer`
exists on npm.

- `elpx-optimizer` (unscoped): `npx elpx-optimizer optimize curso.elpx`. The shortest command, and
  the same name as the binary, the repository and the Docker image. Recommended.
- `@ateeducacion/elpx-optimizer`: `npx @ateeducacion/elpx-optimizer optimize curso.elpx` also works,
  since the package has a single binary. Longer to type, but the scope shows who publishes it.
- The former package name, `elpx-optimizer-cli`, would give `npx elpx-optimizer-cli …`; this pull
  request renames the package to `elpx-optimizer`.

Either way, the package should belong to an npm organization (`ateeducacion`) with at least two
maintainers, not to one personal account. An unscoped package can be owned by an organization.

## Security

Publishing adds a supply-chain channel, so:

- Publish only from `release.yml` with npm trusted publishing (OIDC from GitHub Actions, no token
  stored in the repository) and provenance, so each version links to the commit and the workflow
  that built it.
- npm only lets a trusted publisher be configured for a package that already exists, so the first
  version is published by hand by a maintainer with two-factor authentication. Then trusted
  publishing is set up (repository `ateeducacion/elpx-optimizer`, workflow `release.yml`), and
  publishing with a token is turned off in the package settings.
- The two runtime dependencies are pinned to exact versions, as in the root `package.json`.

## Is it worth it?

Yes. The cost is small, because the package and its test already exist. What it gives:

- A zero-install command for anyone with Node: IT staff processing many courses, CI pipelines of
  publishers, and AI agents.
- Pinned versions (`npx elpx-optimizer@0.1.1 …`) without downloading release assets.
- The Agent Skill (`skills/elpx-optimizer/scripts/run.mjs`) could fall back to
  `npx -y elpx-optimizer@<its version>` when no CLI is found, instead of asking for a vendor install.

What it does not change: video and audio still need FFmpeg, and the Docker image remains the
complete option.

## Steps

1. Create the npm organization `ateeducacion` (or use an existing one) with two or more maintainers,
   all with two-factor authentication.
2. Merge the packaging changes in this pull request:
   - the package is named `elpx-optimizer`, with `repository`, `homepage`, `bugs` and `keywords`;
   - the tarball becomes `elpx-optimizer-<version>.tgz`;
   - the release gains an `npm` job, which only runs when the repository variable `NPM_PUBLISH` is
     `true`.
3. Publish the first version by hand from the release tarball
   (`npm publish elpx-optimizer-<version>.tgz --access public`).
4. In the package settings on npmjs.com, add the trusted publisher and disallow token publishing.
5. Set `NPM_PUBLISH=true` in the repository variables. Later releases publish themselves.
6. Optional: the Node version check in `bin.ts`, and the `npx` fallback in the skill.
