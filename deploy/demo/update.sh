#!/bin/sh
# Redeploy the public demo from one exact public commit.
#
# This is the README's update path, scripted: build an exact-commit image from
# the public source archive, change only the image tag in the private env
# file, recreate the namespace owner (dolt) and then the app, and check health
# through the configured public Host. It never runs prepare or setup, never
# edits the demo configuration (seed, cutoff and release identify the seeded
# history) and takes no backup: take the README's stopped backup first when
# the data matters.
#
# Usage:
#   update.sh --env /operator/demo.env --source /operator/src [--commit main|<sha>]
#             [--repo owner/name] [--project demo-preview]
#
# Needs curl, tar, sed and Docker with Compose on the demo host. Runs docker
# through sudo when the invoking user cannot reach the Docker daemon.
set -eu

ENV_FILE='' SOURCE_DIR='' COMMIT=main REPO=notice-cx/NoticeOS PROJECT=demo-preview
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
    *) usage ;;
  esac
done
[ -n "$ENV_FILE" ] && [ -n "$SOURCE_DIR" ] || usage
[ -f "$ENV_FILE" ] || { echo "env file not found: $ENV_FILE" >&2; exit 1; }
case "$SOURCE_DIR" in /*) ;; *) echo 'source dir must be absolute' >&2; exit 1 ;; esac

is_sha() { echo "$1" | grep -Eq '^[0-9a-f]{40}$'; }

if ! is_sha "$COMMIT"; then
  COMMIT=$(curl -fsSL -H 'Accept: application/vnd.github.sha' "https://api.github.com/repos/$REPO/commits/$COMMIT")
fi
is_sha "$COMMIT" || { echo "could not resolve a full commit hash for $REPO" >&2; exit 1; }

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER='sudo docker'

CURRENT=$(sed -n 's/^NOTICEOS_DEMO_IMAGE=noticeos-demo://p' "$ENV_FILE")
if [ "$CURRENT" = "$COMMIT" ]; then
  echo "already on $COMMIT"
  exit 0
fi

echo "fetching $REPO at $COMMIT"
rm -rf "$SOURCE_DIR"
mkdir -p "$SOURCE_DIR"
curl -fsSL "https://github.com/$REPO/archive/$COMMIT.tar.gz" | tar -xz -C "$SOURCE_DIR" --strip-components=1

echo "building noticeos-demo:$COMMIT"
$DOCKER build --build-arg "NOTICEOS_SOURCE_COMMIT=$COMMIT" \
  -f "$SOURCE_DIR/deploy/demo/Dockerfile" -t "noticeos-demo:$COMMIT" "$SOURCE_DIR"

sed -i "s|^NOTICEOS_DEMO_IMAGE=.*|NOTICEOS_DEMO_IMAGE=noticeos-demo:$COMMIT|" "$ENV_FILE"

# The app shares dolt's network namespace, so dolt is recreated first.
compose() { $DOCKER compose --env-file "$ENV_FILE" -p "$PROJECT" -f "$SOURCE_DIR/deploy/demo/compose.yaml" "$@"; }
compose up -d --wait --force-recreate dolt
compose up -d --wait --force-recreate app

CONFIG=$(sed -n 's/^NOTICEOS_DEMO_CONFIG=//p' "$ENV_FILE")
PORT=$(sed -n 's/^NOTICEOS_DEMO_HTTP_PORT=//p' "$ENV_FILE")
HOST=$(sed -n 's|.*"publicOrigin" *: *"https://\([^"/]*\)".*|\1|p' "$CONFIG")
[ -n "$HOST" ] && [ -n "$PORT" ] || { echo 'could not read the public Host or port from the configuration' >&2; exit 1; }
curl -fsS --header "Host: $HOST" "http://127.0.0.1:$PORT/__noticeos_health"
echo
echo "demo now runs $COMMIT"
