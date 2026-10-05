# Build only the context produced by scripts/container-context.mjs.
# Official Node image index, including Linux amd64 and arm64.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS sqlite-build
# Official SQLite download page publishes this release's SHA3-256 checksum.
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates curl gcc libc6-dev \
    && curl --fail --location --silent --show-error https://www.sqlite.org/2026/sqlite-autoconf-3530400.tar.gz -o /tmp/sqlite.tar.gz \
    && node --input-type=module -e 'import fs from "node:fs";import {createHash} from "node:crypto";if(createHash("sha3-256").update(fs.readFileSync("/tmp/sqlite.tar.gz")).digest("hex")!=="454e45f61c6bd75b7420e7190732dea03ce6639c63ada47bbc592f67fc340338")process.exit(1)' \
    && tar -xzf /tmp/sqlite.tar.gz -C /tmp \
    && gcc -O2 -DSQLITE_THREADSAFE=1 -DSQLITE_ENABLE_COLUMN_METADATA -DSQLITE_ENABLE_FTS5 -DSQLITE_ENABLE_RTREE \
       /tmp/sqlite-autoconf-3530400/shell.c /tmp/sqlite-autoconf-3530400/sqlite3.c -o /usr/local/bin/sqlite3 -ldl -lpthread -lm \
    && sqlite3 --version
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG TARGETARCH
COPY --from=sqlite-build /usr/local/bin/sqlite3 /usr/local/bin/sqlite3
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates curl git lsof \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo '0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' | sha256sum --check - \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install --no-install-recommends -y postgresql-client-18=18.6-1.pgdg12+2 \
    && rm -rf /var/lib/apt/lists/*
RUN case "$TARGETARCH" in \
      amd64) digest=3219443a9734b89b93fb16ee8d65844759fa1b3cd3cf139c606b7353cfb0715c ;; \
      arm64) digest=c3b32c71a6c0cd6358a12c28272b17e6818db991da192f87df52339c222e423a ;; \
      *) exit 1 ;; \
    esac && curl --fail --location --silent --show-error "https://github.com/gastownhall/beads/releases/download/v1.3.1/beads_1.3.1_linux_${TARGETARCH}.tar.gz" -o /tmp/beads.tar.gz \
    && echo "$digest  /tmp/beads.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/beads.tar.gz -C /usr/local/bin bd && rm /tmp/beads.tar.gz \
    && bd version
RUN case "$TARGETARCH" in \
      amd64) digest=cd08696de8d185aa194c930f62cdf4a3599084534e589fbcb0d2207d1bc37370 ;; \
      arm64) digest=f8c19f6d8827e6ef4d21a694073cfb50777f4099136fb52d805c397f7b571cc2 ;; \
      *) exit 1 ;; \
    esac && curl --fail --location --silent --show-error "https://github.com/dolthub/dolt/releases/download/v2.4.0/dolt-linux-${TARGETARCH}.tar.gz" -o /tmp/dolt.tar.gz \
    && echo "$digest  /tmp/dolt.tar.gz" | sha256sum --check - \
    && tar -xzf /tmp/dolt.tar.gz -C /tmp \
    && install /tmp/dolt-linux-${TARGETARCH}/bin/dolt /usr/local/bin/dolt \
    && rm -rf /tmp/dolt.tar.gz /tmp/dolt-linux-${TARGETARCH} && dolt version
RUN npm install --global pnpm@12.8.1
WORKDIR /opt/noticeos
COPY . .
RUN pnpm install --frozen-lockfile \
    && chmod 644 node_modules/.pnpm-workspace-state-v1.json \
    && mkdir -p /opt/noticeos/apps/tower/node_modules/.vite-temp \
    && ln -s /state/.local .local && ln -s /state/.wrangler .wrangler \
    && ln -s /state/workers/ingest/.dev.secrets.json workers/ingest/.dev.secrets.json \
    && ln -s /state/workers/ingest/.dev.vars workers/ingest/.dev.vars
RUN mkdir -p /etc/noticeos && cp db/dolt/host/backup-metadata.sh /etc/noticeos/backup-metadata.sh
ENV NOTICEOS_HOME=/state NOTICEOS_INSTALLATION_DIR=/state/installation
ENV NOTICEOS_TASK_CLIENT_PROFILE=/state/task-client.json BEADS_BD_BIN=/usr/local/bin/bd
ENV NOTICEOS_VITE_CACHE_DIR=/state/.local/vite-cache WRANGLER_SEND_METRICS=false
USER node
HEALTHCHECK --interval=10s --timeout=5s --start-period=120s --retries=3 CMD ["node", "deploy/compose/health.mjs"]
ENTRYPOINT ["node", "deploy/compose/entrypoint.mjs"]
