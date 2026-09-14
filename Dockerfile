# syntax=docker/dockerfile:1
# bddb — kanban dashboard for beads. See docs/deployment.md.
#
# The image carries the dashboard, the `bd` binary (for `bd serve`) and git (bd needs it).
# No dolt, no data, no volumes: the container connects to *your* dolt sql-server over TCP
# (BDDB_DOLT_HOST/BDDB_DOLT_PORT). The beads version inside must match your host's `bd` minor.
#
#   docker build --build-arg BEADS_VERSION=1.3.0-rc.2 -t bddb .
#   docker run --rm -p 7331:7331 --add-host=host.docker.internal:host-gateway bddb
#   docker run --rm --add-host=host.docker.internal:host-gateway bddb doctor
#
# BEADS_VERSION must equal the `github:gastownhall/beads` pin in mise.toml (scripts/check-pins.sh).
ARG BEADS_VERSION=1.3.0-rc.2
ARG BDDB_VERSION=0.0.0-dev

# ---------------------------------------------------------------------------------------------
# bd: download the beads release for the target architecture and verify it against checksums.txt
# (runs on the build platform; the archive is picked by TARGETARCH — amd64 / arm64).
FROM --platform=$BUILDPLATFORM debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171 AS bd
ARG BEADS_VERSION
ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /bd
RUN base="https://github.com/gastownhall/beads/releases/download/v${BEADS_VERSION}" \
 && asset="beads_${BEADS_VERSION}_linux_${TARGETARCH}.tar.gz" \
 && curl -fsSL --retry 3 -o "$asset" "$base/$asset" \
 && curl -fsSL --retry 3 -o checksums.txt "$base/checksums.txt" \
 && grep -E " ${asset}\$" checksums.txt | sha256sum -c - \
 && tar -xzf "$asset" bd \
 && chmod 0755 bd

# ---------------------------------------------------------------------------------------------
# build: bundle server + SPA (platform-independent JavaScript, so it runs on the build platform).
FROM --platform=$BUILDPLATFORM oven/bun:1.4@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS build
WORKDIR /src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
COPY scripts/build-server.sh ./scripts/
RUN scripts/build-server.sh dist/server

# ---------------------------------------------------------------------------------------------
# runtime
FROM oven/bun:1.4-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61 AS runtime
ARG BEADS_VERSION
ARG BDDB_VERSION

# git: bd resolves its repository root through git and `bd serve` refuses to start without it.
# hadolint ignore=DL3008
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /tmp/bddb && chown bun:bun /tmp/bddb

COPY --from=bd /bd/bd /usr/local/bin/bd
COPY --from=build /src/dist/server /app/server
COPY docker/bddb /usr/local/bin/bddb

ENV BDDB_HOST=0.0.0.0 \
    BDDB_PORT=7331 \
    BDDB_DOLT_HOST=host.docker.internal \
    BDDB_DOLT_PORT=3308 \
    BDDB_WORK_DIR=/tmp/bddb \
    BDDB_BD_PATH=/usr/local/bin/bd

LABEL org.opencontainers.image.title="bddb" \
      org.opencontainers.image.description="Kanban dashboard for beads over the bd serve HTTP API" \
      org.opencontainers.image.source="https://github.com/umum-ai/beads-dashboard" \
      org.opencontainers.image.url="https://github.com/umum-ai/beads-dashboard" \
      org.opencontainers.image.documentation="https://github.com/umum-ai/beads-dashboard/blob/main/docs/deployment.md" \
      org.opencontainers.image.version="${BDDB_VERSION}" \
      org.opencontainers.image.licenses="MIT" \
      org.beads.version="${BEADS_VERSION}"

USER 1000:1000
WORKDIR /app
EXPOSE 7331
# Honours BDDB_PORT and BDDB_BASE_PATH (normalised like config.ts: trailing slashes dropped, one
# leading slash); /healthz means "process alive", /readyz "a database is ready".
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "const b = (process.env.BDDB_BASE_PATH ?? '').trim().replace(/\\/+$/, ''); const p = b === '' ? '' : (b.startsWith('/') ? b : '/' + b); fetch(`http://127.0.0.1:${process.env.BDDB_PORT ?? 7331}${p}/healthz`).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["bddb"]
CMD ["serve"]
