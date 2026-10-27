# syntax=docker/dockerfile:1

# ---------- 1. build the web frontend ----------
FROM node:22-trixie-slim AS webbuild
WORKDIR /app/web
COPY web/package.json ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---------- 2. build the server ----------
FROM node:22-trixie-slim AS serverbuild
# native deps for better-sqlite3 / sharp fallback compilation
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json ./
RUN npm install --no-audit --no-fund
COPY server/ ./
RUN npm run build && npm prune --omit=dev

# ---------- 3. runtime ----------
# trixie (Debian 13) ships Mesa 25.x, which has full VAAPI encode support for
# recent AMD GPUs such as RDNA3 iGPUs.
FROM node:22-trixie-slim

# Hardware transcoding support:
#   AMD           -> mesa-va-drivers (VAAPI)
#   Intel         -> intel-media-va-driver-non-free (VAAPI, broadest encode
#                    support) plus libvpl2/libmfx-gen1.2 for Quick Sync.
#                    These live in Debian's non-free component and only exist
#                    for amd64, so other architectures skip them.
#   NVIDIA        -> nothing here: the NVIDIA Container Toolkit injects the
#                    driver libraries at run time (see docker-compose.yml).
RUN set -eux; \
    extra=""; \
    if [ "$(dpkg --print-architecture)" = "amd64" ]; then \
      sed -i 's/^Components: main$/Components: main non-free non-free-firmware/' /etc/apt/sources.list.d/debian.sources; \
      extra="intel-media-va-driver-non-free libvpl2 libmfx-gen1.2"; \
    fi; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
      ffmpeg \
      mesa-va-drivers \
      libva2 \
      libva-drm2 \
      vainfo \
      tini \
      ca-certificates \
      $extra; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=serverbuild /app/server/node_modules ./node_modules
COPY --from=serverbuild /app/server/dist ./dist
COPY --from=serverbuild /app/server/package.json ./package.json
COPY --from=webbuild /app/web/dist ./public

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    DATA_DIR=/config \
    CACHE_DIR=/cache \
    MEDIA_DIR=/media

RUN mkdir -p /config /cache /media && chown -R 1000:1000 /config /cache

# Starts as root purely to fix the ownership of bind-mounted folders, then drops
# to PUID:PGID before exec'ing the app. Nothing in the app itself needs root.
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 8080
VOLUME ["/config", "/cache"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/server.cjs"]
