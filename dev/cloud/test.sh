#!/bin/bash
set -euo pipefail
if [ "$#" -eq 0 ]; then echo 'Usage: bash dev/cloud/test.sh [--task-store] <command> [arguments]' >&2; exit 2; fi
. "$(dirname -- "${BASH_SOURCE[0]}")/activate.sh"
cd "$NOTICEOS_REPO"
umask 022
if [ "$(id -u)" -eq 0 ]; then echo 'Run database tests as a non-root task user.' >&2; exit 1; fi
noticeos_owned_dir "$NOTICEOS_CLOUD_STATE"
mkdir -p "$NOTICEOS_CLOUD_STATE/locks"
# Docker bridge churn disrupts Chromium requests; serialize verification gates.
exec 8>"$NOTICEOS_CLOUD_STATE/locks/verification.lock"
flock -x 8
task_checkout_lock=$(printf '%s' "$(pwd -P)" | sha256sum | cut -d ' ' -f 1)
exec 9>"$NOTICEOS_CLOUD_STATE/locks/$task_checkout_lock.lock"
flock -s 9
task_key=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" dependencies)
node -e 'const fs=require("node:fs");let x;try{x=JSON.parse(fs.readFileSync("node_modules/.noticeos-environment.json"))}catch{}if(x?.key!==process.argv[1]){console.error("Checkout dependencies need explicit preparation: bash dev/cloud/prepare.sh");process.exit(1)}' "$task_key"
# Keep pnpm's normal stale-dependency interlock active.
pnpm exec node --version >/dev/null
noticeos_owned_dir "$NOTICEOS_TEST_RUNTIME_ROOT"
noticeos_headroom "$NOTICEOS_TEST_RUNTIME_ROOT"
noticeos_headroom "$NOTICEOS_REPO"
task_reaper=$(command -v docker-init || command -v tini || true)
if [ -z "$task_reaper" ]; then echo 'Install docker-init or tini before running tests.' >&2; exit 1; fi
task_docker_config="${DOCKER_CONFIG:-$HOME/.docker}"
task_run=$(mktemp -d "$NOTICEOS_TEST_RUNTIME_ROOT/test.XXXXXXXX")
# Every fixture tree must be outside Git, including synthetic parent markers.
node --input-type=module -e 'import {assertTaskFixtureOutsideGit} from "./scripts/test-fixtures/hosted-task-projects.mjs";assertTaskFixtureOutsideGit(process.argv[1]);' "$task_run"
mkdir -m 700 "$task_run/home" "$task_run/tmp" "$task_run/cache" "$task_run/config" "$task_run/data"
task_vars=()
if [ "${1:-}" = --task-store ]; then
  shift
  task_store_key=$(noticeos_task_tools_key)
  task_store_tools="${NOTICEOS_CLOUD_CACHE}/task-tools/$task_store_key"
  if [ ! -f "$task_store_tools/runtime.env" ]; then
    echo 'Pinned task tools need explicit preparation: bash dev/cloud/prepare.sh --task-store' >&2
    exit 1
  fi
  while IFS= read -r task_line; do
    case "$task_line" in NOTICEOS_TEST_*=*|DOCKER_CONFIG=*) task_vars+=("$task_line");; *) echo 'Unexpected task tool binding' >&2; exit 1;; esac
  done < "$task_store_tools/runtime.env"
  mkdir -m 700 "$task_run/task-store-evidence"
  task_vars+=("NOTICEOS_TEST_HOSTED_TASK_EVIDENCE=$task_run/task-store-evidence")
fi
if [ "$#" -eq 0 ]; then echo 'Usage: bash dev/cloud/test.sh [--task-store] <command> [arguments]' >&2; exit 2; fi
printf 'Owned verification paths: %s\n' "$task_run" >&2
# Keep proxy/CA and injected authentication inherited; never store their values.
# Tini adopts orphaned children and preserves the test command's exit status.
set +e
env HOME="$task_run/home" TMPDIR="$task_run/tmp" XDG_CACHE_HOME="$task_run/cache" \
  XDG_CONFIG_HOME="$task_run/config" XDG_DATA_HOME="$task_run/data" DOCKER_CONFIG="$task_docker_config" \
  NOTICEOS_REQUIRE_POSTGRES=1 UNIT_TEST_WORKERS="${UNIT_TEST_WORKERS:-2}" \
  JOURNEY_WORKERS="${JOURNEY_WORKERS:-2}" "${task_vars[@]}" \
  "$task_reaper" -s -- "$@"
task_status=$?
set -e
printf 'Verification exited %s; runtime output remains at %s\n' "$task_status" "$task_run" >&2
exit "$task_status"
