#!/bin/sh
# Deploy the public demo from one exact public commit, every time.
#
# One command brings up the target release whatever moved on main:
#
#   compatible release  (same scenario version, same frozen migrations)
#     the README's update path: build the exact-commit image, change only
#     the image tag in the env file, recreate dolt then app, check health.
#     Seeded history is kept.
#
#   incompatible release (scenario version or frozen migrations changed)
#     a fresh generation: a new Compose project with new volumes and its own
#     demo configuration (release = target, cutoff = now, the rest copied),
#     prepared and seeded by the README's fresh-setup steps, then switched in
#     on the same loopback port. Nothing of a synthetic demo is migrated.
#     If the new generation does not pass health, the previous one comes back
#     and the command fails naming both commits. Old generations stay stopped
#     with their volumes; the purge command is printed, never run.
#
# After fetching the target source the script runs that commit's own copy of
# itself, and on success installs it over the copy it was started from, so the
# installed script never falls behind the release it deploys.
#
# Usage:
#   update.sh --env /operator/demo.env --source /operator/src [--commit main|<sha>]
#             [--repo owner/name] [--project name]
#
# The env file carries NOTICEOS_DEMO_IMAGE, NOTICEOS_DEMO_CONFIG,
# NOTICEOS_DEMO_HTTP_PORT and, once this script has run, NOTICEOS_DEMO_PROJECT.
# Needs curl, tar and Docker with Compose on the demo host; runs docker through
# sudo when the invoking user cannot reach the daemon. Takes no backup.
set -eu

ENV_FILE='' SOURCE_DIR='' COMMIT=main REPO=notice-cx/NoticeOS PROJECT='' FETCHED=0 SELF=''
usage() {
  echo 'usage: update.sh --env <demo.env> --source <dir> [--commit main|<sha>] [--repo owner/name] [--project name]' >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --env) ENV_FILE=$2; shift 2 ;;
    --source) SOURCE_DIR=$2; shift 2 ;;
    --commit) COMMIT=$2; shift 2 ;;
    --repo) REPO=$2; shift 2 ;;
    --project) PROJECT=$2; shift 2 ;;
    --fetched) FETCHED=1; shift ;;
    --self) SELF=$2; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$ENV_FILE" ] && [ -n "$SOURCE_DIR" ] || usage
[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
case "$SOURCE_DIR" in /*) ;; *) echo 'source dir must be absolute' >&2; exit 1 ;; esac
if [ -z "$SELF" ]; then case "$0" in /*) SELF=$0 ;; *) SELF=$PWD/$0 ;; esac; fi

RAW=${NOTICEOS_DEMO_RAW_BASE:-https://raw.githubusercontent.com}
is_sha() { echo "$1" | grep -Eq '^[0-9a-f]{40}$'; }
env_value() { sed -n "s/^$2=//p" "$1" | head -n 1; }
json_value() { sed -n "s|.*\"$2\" *: *\"\([^\"]*\)\".*|\1|p" "$1" | head -n 1; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%S.000Z; }
write_env() { # file image config port project
  printf 'NOTICEOS_DEMO_IMAGE=noticeos-demo:%s\nNOTICEOS_DEMO_CONFIG=%s\nNOTICEOS_DEMO_HTTP_PORT=%s\nNOTICEOS_DEMO_PROJECT=%s\n' \
    "$2" "$3" "$4" "$5" > "$1"
}

if ! is_sha "$COMMIT"; then
  COMMIT=$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$COMMIT")
fi
is_sha "$COMMIT" || { echo "could not resolve a full commit hash for $REPO" >&2; exit 1; }

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER='sudo docker'
compose() { # env project compose-file args...
  e=$1; p=$2; f=$3; shift 3
  $DOCKER compose --env-file "$e" -p "$p" -f "$f" "$@"
}
health() { # config port
  h=$(json_value "$1" publicOrigin | sed 's|^https://||; s|/.*||')
  [ -n "$h" ] || { echo 'could not read the public Host from the configuration' >&2; return 1; }
  curl -fsS --header "Host: $h" "http://127.0.0.1:$2/__noticeos_health"; echo
}

CURRENT=$(env_value "$ENV_FILE" NOTICEOS_DEMO_IMAGE | sed 's/^noticeos-demo://')
CONFIG=$(env_value "$ENV_FILE" NOTICEOS_DEMO_CONFIG)
PORT=$(env_value "$ENV_FILE" NOTICEOS_DEMO_HTTP_PORT)
[ -n "$PROJECT" ] || PROJECT=$(env_value "$ENV_FILE" NOTICEOS_DEMO_PROJECT)
[ -n "$PROJECT" ] || PROJECT=demo-preview
[ -n "$CONFIG" ] && [ -n "$PORT" ] || { echo "env file lacks NOTICEOS_DEMO_CONFIG or NOTICEOS_DEMO_HTTP_PORT: $ENV_FILE" >&2; exit 1; }
GENERATIONS=$(dirname "$ENV_FILE")/generations
COMPOSE_FILE=$SOURCE_DIR/deploy/demo/compose.yaml

if [ "$CURRENT" = "$COMMIT" ]; then
  echo "already on $COMMIT"
  exit 0
fi

# Keep what the running generation needs for a rollback before its source goes.
if [ -n "$CURRENT" ] && [ ! -f "$GENERATIONS/$PROJECT/compose.yaml" ] && [ -f "$COMPOSE_FILE" ]; then
  mkdir -p "$GENERATIONS/$PROJECT"
  cp "$COMPOSE_FILE" "$GENERATIONS/$PROJECT/compose.yaml"
  cp "$ENV_FILE" "$GENERATIONS/$PROJECT/demo.env"
fi

if [ "$FETCHED" != 1 ]; then
  echo "fetching $REPO at $COMMIT"
  rm -rf "$SOURCE_DIR"
  mkdir -p "$SOURCE_DIR"
  curl -fsSL "https://github.com/$REPO/archive/$COMMIT.tar.gz" | tar -xz -C "$SOURCE_DIR" --strip-components=1
fi
THEIRS=$SOURCE_DIR/deploy/demo/update.sh
if [ "$FETCHED" != 1 ] && [ -f "$THEIRS" ] && ! cmp -s "$SELF" "$THEIRS"; then
  echo "continuing with the target commit's own update script"
  exec sh "$THEIRS" --env "$ENV_FILE" --source "$SOURCE_DIR" --commit "$COMMIT" --repo "$REPO" --project "$PROJECT" --fetched --self "$SELF"
fi

# Compatibility: the running release's scenario version and frozen migrations against the target's.
FRESH=0
if [ -z "$CURRENT" ]; then
  FRESH=1
else
  theirs_version=$(grep -oE 'SCENARIO_VERSION = [0-9]+' "$SOURCE_DIR/scripts/demo-scenario.mts" | head -n 1)
  ours_version=$(curl -fsSL "$RAW/$REPO/$CURRENT/scripts/demo-scenario.mts" 2>/dev/null | grep -oE 'SCENARIO_VERSION = [0-9]+' | head -n 1 || true)
  ours_migrations=$(curl -fsSL "$RAW/$REPO/$CURRENT/db/postgres/frozen-migrations.sha256" 2>/dev/null || true)
  if [ -z "$ours_version" ] || [ "$ours_version" != "$theirs_version" ]; then FRESH=1; fi
  if [ -z "$ours_migrations" ] || [ "$ours_migrations" != "$(cat "$SOURCE_DIR/db/postgres/frozen-migrations.sha256")" ]; then FRESH=1; fi
fi

echo "building noticeos-demo:$COMMIT"
$DOCKER build --build-arg "NOTICEOS_SOURCE_COMMIT=$COMMIT" \
  -f "$SOURCE_DIR/deploy/demo/Dockerfile" -t "noticeos-demo:$COMMIT" "$SOURCE_DIR"

install_self() {
  if [ -n "$SELF" ] && [ -f "$THEIRS" ] && ! cmp -s "$SELF" "$THEIRS"; then
    cp "$THEIRS" "$SELF" && chmod +x "$SELF" && echo "installed this release's update script at $SELF"
  fi
}

if [ "$FRESH" = 0 ]; then
  echo "compatible release: swapping the app in place, data kept"
  write_env "$ENV_FILE" "$COMMIT" "$CONFIG" "$PORT" "$PROJECT"
  # The app shares dolt's network namespace, so dolt is recreated first.
  compose "$ENV_FILE" "$PROJECT" "$COMPOSE_FILE" up -d --wait --force-recreate dolt
  compose "$ENV_FILE" "$PROJECT" "$COMPOSE_FILE" up -d --wait --force-recreate app
  health "$CONFIG" "$PORT"
  install_self
  echo "demo now runs $COMMIT"
  exit 0
fi

# A fresh generation: new project, new volumes, its own configuration.
n=$(echo "$PROJECT" | sed -n 's/^demo-g\([0-9][0-9]*\)$/\1/p')
NEW=demo-g$(( ${n:-1} + 1 ))
while [ -d "$GENERATIONS/$NEW" ]; do NEW=demo-g$(( ${NEW#demo-g} + 1 )); done
NEW_DIR=$GENERATIONS/$NEW
NEW_CONFIG=$NEW_DIR/demo.json
NEW_ENV=$NEW_DIR/demo.env
origin=$(json_value "$CONFIG" publicOrigin); seed=$(json_value "$CONFIG" seed); expires=$(json_value "$CONFIG" serviceExpiresAt)
[ -n "$origin" ] && [ -n "$seed" ] && [ -n "$expires" ] || { echo "could not read publicOrigin, seed and serviceExpiresAt from $CONFIG" >&2; exit 1; }
now=$(now_iso)
if [ "$expires" \< "$now" ] || [ "$expires" = "$now" ]; then
  echo "serviceExpiresAt $expires is not in the future: set a new expiry in $CONFIG and rerun" >&2; exit 1
fi
echo "incompatible release: preparing fresh generation $NEW (scenario or schema changed)"
mkdir -p "$NEW_DIR"; chmod 700 "$NEW_DIR"
printf '{\n  "version": 1,\n  "publicOrigin": "%s",\n  "seed": "%s",\n  "cutoff": "%s",\n  "release": "%s",\n  "serviceExpiresAt": "%s"\n}\n' \
  "$origin" "$seed" "$now" "$COMMIT" "$expires" > "$NEW_CONFIG"
chmod 600 "$NEW_CONFIG"
write_env "$NEW_ENV" "$COMMIT" "$NEW_CONFIG" "$PORT" "$NEW"
chmod 600 "$NEW_ENV"
cp "$COMPOSE_FILE" "$NEW_DIR/compose.yaml"
compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" config --quiet
compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" run --rm --no-deps prepare

OLD_ENV=$GENERATIONS/$PROJECT/demo.env
OLD_COMPOSE=$GENERATIONS/$PROJECT/compose.yaml
[ -f "$OLD_COMPOSE" ] || OLD_COMPOSE=$COMPOSE_FILE
[ -f "$OLD_ENV" ] || OLD_ENV=$ENV_FILE
rollback() {
  echo "fresh generation $NEW failed; bringing $PROJECT back" >&2
  compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" stop app dolt postgres || true
  if [ -n "$CURRENT" ]; then
    compose "$OLD_ENV" "$PROJECT" "$OLD_COMPOSE" up -d --wait postgres dolt || true
    compose "$OLD_ENV" "$PROJECT" "$OLD_COMPOSE" up -d --wait app || true
    health "$CONFIG" "$PORT" || true
  fi
  echo "deploy of $COMMIT failed; $PROJECT at ${CURRENT:-nothing} is back; the new volumes of $NEW are kept for diagnosis" >&2
  exit 1
}
if [ -n "$CURRENT" ]; then
  echo "stopping $PROJECT to free port $PORT"
  compose "$OLD_ENV" "$PROJECT" "$OLD_COMPOSE" stop app dolt postgres || true
fi
compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" up -d --wait postgres dolt || rollback
compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" run --rm setup || rollback
compose "$NEW_ENV" "$NEW" "$COMPOSE_FILE" up -d --wait app || rollback
health "$NEW_CONFIG" "$PORT" || rollback
cp "$NEW_ENV" "$ENV_FILE"
install_self
echo "demo now runs $COMMIT as generation $NEW"
if [ -n "$CURRENT" ]; then
  echo "previous generation $PROJECT is stopped with its volumes; to purge it once you are sure:"
  echo "  $DOCKER compose --env-file $OLD_ENV -p $PROJECT -f $OLD_COMPOSE down --volumes"
fi
