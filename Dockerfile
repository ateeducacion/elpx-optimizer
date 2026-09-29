# syntax=docker/dockerfile:1.7
# Multi-stage build:
#   --target web : static hosting of the web app (nginx, non-root, no ffmpeg, no API).
#   --target cli : the CLI with Bun, ffmpeg/ffprobe and sharp (Alpine, non-root).
# Base images are written in the FROM lines (not in ARGs) so Dependabot can update them.

FROM oven/bun:1.4.0-alpine AS deps
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS build
COPY . .
RUN bun x vite build && bun scripts/build-cli.ts

# ---------------------------------------------------------------- web
FROM nginxinc/nginx-unprivileged:1.29-alpine AS web
# Set ELPX_ISOLATION=on to send COOP/COEP (enables the multi-thread FFmpeg core).
ENV ELPX_ISOLATION=off NGINX_ENVSUBST_OUTPUT_DIR=/tmp NGINX_ENVSUBST_FILTER=^ELPX_
COPY docker/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker/isolation.sh /docker-entrypoint.d/05-elpx-isolation.sh
COPY --from=build /src/dist/web /usr/share/nginx/html
USER 101
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1

# ---------------------------------------------------------------- cli
FROM oven/bun:1.4.0-alpine AS cli
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
