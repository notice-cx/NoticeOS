# Compiled preview image; build only the public source of one exact commit.
# The demo's own Ntasks (deploy/demo/ntasks.json): its Worker bundle, its
# migrations and its seed and provision tools, built from one exact commit.
FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68 AS ntasks
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.8.1
COPY deploy/demo/ntasks.json /opt/build/deploy/demo/ntasks.json
COPY scripts/demo-ntasks-build.mjs scripts/invoked-directly.mjs /opt/build/scripts/
RUN node /opt/build/scripts/demo-ntasks-build.mjs --out /opt/ntasks && rm -rf /opt/ntasks/.git

FROM node:26.13.0-bookworm-slim@sha256:add5c17c14752c54d2f3d519ec46a3815684d41c33f198bcb09fb998f7dcbf68
ARG TARGETARCH
ARG NOTICEOS_SOURCE_COMMIT
LABEL org.opencontainers.image.revision=$NOTICEOS_SOURCE_COMMIT
RUN apt-get update && apt-get install --no-install-recommends -y ca-certificates curl lsof \
    && mkdir -p /usr/share/postgresql-common/pgdg \
    && curl --fail --silent --show-error https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    && echo '0144068502a1eddd2a0280ede10ef607d1ec592ce819940991203941564e8e76  /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc' | sha256sum --check - \
    && echo 'deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update && apt-get install --no-install-recommends -y postgresql-client-18=18.6-1.pgdg12+2 \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.8.1
# The Worker bundle the ntasks service runs, and the seed and provision tools
# setup and preparation run, at the paths those tools find each other by.
COPY --from=ntasks /opt/ntasks/dist /opt/ntasks/dist
COPY --from=ntasks /opt/ntasks/LICENSE /opt/ntasks/LICENSE
COPY --from=ntasks /opt/ntasks/packages/domain /opt/ntasks/packages/domain
COPY --from=ntasks /opt/ntasks/tools/migrate /opt/ntasks/tools/migrate
COPY --from=ntasks /opt/ntasks/workers/api/migrations /opt/ntasks/workers/api/migrations
COPY --from=ntasks /opt/ntasks/workers/api/src/store/migrations /opt/ntasks/workers/api/src/store/migrations
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
