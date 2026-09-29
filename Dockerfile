# syntax=docker/dockerfile:1.7
# The CLI with Bun, ffmpeg/ffprobe and sharp (Alpine, non-root), published as
# ghcr.io/ateeducacion/elpx-optimizer. The web app is served from GitHub Pages.
# Base images are written in the FROM lines (not in ARGs) so Dependabot can update them.

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN bun scripts/build-cli.ts

FROM oven/bun:1.4.2-alpine AS cli
RUN apk add --no-cache ffmpeg \
  && addgroup -S elpx && adduser -S -G elpx -h /home/elpx elpx \
  && mkdir -p /work /app && chown elpx:elpx /work
WORKDIR /app
COPY --from=build /src/dist/cli/ /app/
RUN bun install --production --no-save && chmod 0555 /app/elpx-optimizer.mjs
USER elpx
WORKDIR /work
ENV ELPX_OPTIMIZER_FFMPEG=/usr/bin/ffmpeg ELPX_OPTIMIZER_FFPROBE=/usr/bin/ffprobe
HEALTHCHECK --interval=60s --timeout=10s CMD bun /app/elpx-optimizer.mjs --version || exit 1
ENTRYPOINT ["bun", "/app/elpx-optimizer.mjs"]
CMD ["--help"]
