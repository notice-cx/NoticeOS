#!/usr/bin/env bash
# NoticeOS Postgres service: its first start (bead ro-ujb9.76.12).
#
# The image's entrypoint runs this once, on an empty data volume only: after
# initdb, before the server first listens on TCP, as the cluster's superuser
# on the container's own socket (compose.yaml mounts it into
# /docker-entrypoint-initdb.d). It builds what NoticeOS needs from its host
# (db/postgres/README.md):
#   - the three roles, from db/postgres/roles.sql as it is;
#   - a login for each, whose password the server receives only as the
#     SCRAM-SHA-256 verifier `pnpm postgres:secrets` wrote, never the password
#     itself: pg_stat_statements keeps an ALTER ROLE word for word;
#   - the empty noticeos database, owned by noticeos_owner, which only the
#     application and maintenance roles may connect to besides its owner;
#   - query statistics (pg_stat_statements) in it.
# It never builds the schema: that is the operator's `pnpm postgres:migrate`.
#
# Executed (the file is executable) or sourced by the entrypoint (a checkout
# that lost the executable bit), the body runs in a subshell, so its shell
# settings never reach the entrypoint, and a failure stops the first start.

(
  set -Eeuo pipefail
  secrets="${NOTICEOS_SECRETS_DIR:-/run/secrets}"
  roles_sql="${NOTICEOS_ROLES_SQL:-/etc/noticeos/roles.sql}"
  verifier='^SCRAM-SHA-256\$[0-9]+:[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*:[A-Za-z0-9+/]+=*$'
  for login in noticeos_owner noticeos_maint noticeos_app; do
    if ! [[ "$(cat "$secrets/$login" 2>/dev/null)" =~ $verifier ]]; then
      echo "noticeos first start: $secrets/$login is not a SCRAM-SHA-256 verifier; make the secret files with pnpm postgres:secrets" >&2
      exit 1
    fi
  done
  psql -v ON_ERROR_STOP=1 --no-psqlrc --no-password --username "${POSTGRES_USER:-postgres}" --dbname postgres \
    --set secrets="$secrets" --set roles_sql="$roles_sql" <<'SQL'
\i :roles_sql
\set verifier `cat :'secrets'/noticeos_owner`
ALTER ROLE noticeos_owner LOGIN PASSWORD :'verifier';
\set verifier `cat :'secrets'/noticeos_maint`
ALTER ROLE noticeos_maint LOGIN PASSWORD :'verifier';
\set verifier `cat :'secrets'/noticeos_app`
ALTER ROLE noticeos_app LOGIN PASSWORD :'verifier';
CREATE DATABASE noticeos OWNER noticeos_owner TEMPLATE template0 ENCODING 'UTF8';
REVOKE CONNECT ON DATABASE noticeos FROM PUBLIC;
GRANT CONNECT ON DATABASE noticeos TO noticeos_app, noticeos_maint;
\connect noticeos
CREATE EXTENSION pg_stat_statements;
SQL
)
