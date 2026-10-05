# Compiled preview image; build only the public source of one exact commit.
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG TARGETARCH
ARG NOTICEOS_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$NOTICEOS_SOURCE_COMMIT
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
RUN node --input-type=module -e 'import fs from "node:fs"; const commit=process.argv[1]; if(!/^[a-f0-9]{40}$/.test(commit))process.exit(1); fs.writeFileSync("/opt/noticeos/source-commit",commit+"\n");' "$NOTICEOS_SOURCE_COMMIT"
RUN pnpm install --frozen-lockfile --ignore-scripts --no-runtime \
    && node scripts/hosted-demo-build.mjs --out /opt/noticeos/demo-artifacts \
    && chmod 0755 /opt/noticeos/demo-artifacts \
    && mkdir -p /usr/share/noticeos/licenses \
    && cp deploy/compose/licenses/* /usr/share/noticeos/licenses/
ENV NODE_ENV=production WRANGLER_SEND_METRICS=false DO_NOT_TRACK=1
USER node
HEALTHCHECK --interval=10s --timeout=4s --start-period=120s --retries=6 CMD ["node", "deploy/demo/health.mjs", "--runtime", "/state/runtime/runtime.json"]
ENTRYPOINT ["node", "deploy/demo/entrypoint.mjs"]
