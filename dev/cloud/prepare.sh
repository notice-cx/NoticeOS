#!/bin/bash
set -euo pipefail
umask 022
. "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh"
cd "$NOTICEOS_REPO"
if [ "$(uname -s)/$(uname -m)" != Linux/x86_64 ] || [ "$(id -u)" -eq 0 ]; then
  echo 'Use a non-root Linux x86_64 task user.' >&2; exit 1
fi
task_prepare_store=0
task_browser_args=()
for task_arg in "$@"; do
  case "$task_arg" in
    --task-store) task_prepare_store=1;;
    --with-deps) task_browser_args+=(--with-deps);;
    *) echo 'Usage: bash dev/cloud/prepare.sh [--with-deps] [--task-store]' >&2; exit 2;;
  esac
done
noticeos_owned_dir "$NOTICEOS_CLOUD_STATE"
noticeos_owned_dir "$NOTICEOS_CLOUD_CACHE"
mkdir -p "$NOTICEOS_CLOUD_STATE/locks"
# Exclude preparation from tests and other preparations sharing these caches.
exec 8>"$NOTICEOS_CLOUD_STATE/locks/verification.lock"
flock -x 8
task_checkout_lock=$(printf '%s' "$(pwd -P)" | sha256sum | cut -d ' ' -f 1)
exec 9>"$NOTICEOS_CLOUD_STATE/locks/$task_checkout_lock.lock"
flock -x 9
noticeos_headroom "$NOTICEOS_CLOUD_CACHE"
noticeos_headroom "$NOTICEOS_REPO"
task_tools=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" tools)
task_node=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" node)
task_pnpm=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" pnpm)
task_key=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" dependencies)
mkdir -p "$task_tools" "$NOTICEOS_CLOUD_CACHE/npm"
if [ ! -x "$task_tools/node_modules/.bin/node" ] || [ ! -x "$task_tools/node_modules/.bin/pnpm" ]; then
  npm --cache "$NOTICEOS_CLOUD_CACHE/npm" install --prefix "$task_tools" --no-audit --no-fund "node@$task_node" "pnpm@$task_pnpm"
fi
. "$NOTICEOS_CLOUD_SOURCE/activate.sh"
test "$(node --version)" = "v$task_node"
test "$(pnpm --version)" = "$task_pnpm"
# Explicit frozen setup after checkout. Test commands never install dependencies.
task_store="${NOTICEOS_CLOUD_CACHE}/pnpm/$task_key"
task_prepared=0
if node -e 'const fs=require("node:fs");try{process.exit(JSON.parse(fs.readFileSync("node_modules/.noticeos-environment.json")).key===process.argv[1]?0:1)}catch{process.exit(1)}' "$task_key" && pnpm exec node --version >/dev/null 2>&1; then
  task_prepared=1
fi
if [ "$task_prepared" -eq 0 ]; then
  # Fetch into a separate virtual store before touching working modules.
  task_fetch="${NOTICEOS_CLOUD_CACHE}/fetch/$task_key"
  mkdir -p "$task_fetch"
  cp pnpm-lock.yaml pnpm-workspace.yaml "$task_fetch/"
  CI=1 pnpm --dir "$task_fetch" --config.ignoreScripts=true --config.managePackageManagerVersions=false fetch --store-dir "$task_store"
  CI=1 pnpm install --offline --frozen-lockfile --store-dir "$task_store"
else
  printf '%s\n' 'Dependency inputs and pnpm preflight match; reusing prepared node_modules.'
fi
node -e 'const fs=require("node:fs");fs.writeFileSync("node_modules/.noticeos-environment.json",JSON.stringify({key:process.argv[1]}));' "$task_key"
# Retain the exact browser cache across dependency reconciliations and revisions.
task_browser_version=$(node --input-type=module -e 'import {createRequire} from "node:module";const r=createRequire(process.cwd()+"/apps/tower/package.json");console.log(r("@playwright/test/package.json").version)')
task_browser_cache="${NOTICEOS_CLOUD_CACHE}/browsers/playwright-$task_browser_version-$(uname -m)"
task_browser_local=$(node --input-type=module -e 'import {JOURNEY_BROWSERS} from "./apps/tower/e2e/journey-browsers.mjs";console.log(JOURNEY_BROWSERS)')
mkdir -p "$(dirname "$task_browser_local")" "$(dirname "$task_browser_cache")"
if [ -d "$task_browser_local" ] && [ ! -L "$task_browser_local" ] && [ ! -e "$task_browser_cache" ]; then
  mv "$task_browser_local" "$task_browser_cache"
fi
mkdir -p "$task_browser_cache"
if [ -L "$task_browser_local" ] || [ ! -e "$task_browser_local" ]; then ln -sfn "$task_browser_cache" "$task_browser_local"; fi
# The repository owns the browser destination; do not select a personal browser.
pnpm --filter @noticeos/tower run journey:install "${task_browser_args[@]}"
node --input-type=module <<'NODE'
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
const r = createRequire(process.cwd() + '/apps/tower/package.json');
const { JOURNEY_BROWSERS } = await import(pathToFileURL(process.cwd() + '/apps/tower/e2e/journey-browsers.mjs'));
process.env.PLAYWRIGHT_BROWSERS_PATH = JOURNEY_BROWSERS;
const { chromium } = r('@playwright/test');
const executable = chromium.executablePath();
const linked = spawnSync('ldd', [executable], { encoding: 'utf8' });
if (linked.status !== 0 || /not found/.test(linked.stdout)) throw Error('Chromium Linux dependencies are missing: ' + linked.stdout);
console.log(JSON.stringify({ playwright: r('@playwright/test/package.json').version,
  lucide: r('lucide-react/package.json').version, browserCache: JOURNEY_BROWSERS, executable }));
NODE
printf 'Prepared checkout %s with dependency key %s\n' "$(git rev-parse --short HEAD)" "$task_key"
# Prepare pinned fixture tools explicitly, before test commands need them.
if [ "$task_prepare_store" -eq 0 ]; then exit 0; fi
task_store_key=$(noticeos_task_tools_key)
task_store_tools="${NOTICEOS_CLOUD_CACHE}/task-tools/$task_store_key"
if [ ! -f "$task_store_tools/runtime.env" ]; then
  task_pending=$(mktemp -d "$NOTICEOS_CLOUD_CACHE/task-tools.pending.XXXXXXXX")
  env -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    DOCKER_HOST=unix:///var/run/docker.sock NODE_USE_ENV_PROXY=1 \
    node scripts/task-store-test-tools.mjs --out "$task_pending/tools" > "$task_pending/runtime.env"
  mv "$task_pending/runtime.env" "$task_pending/tools/runtime.env"
  mkdir -p "$(dirname "$task_store_tools")"
  ln -s "$task_pending/tools" "$task_store_tools"
fi
# A restored task can have retained client files and a freshly started daemon.
# Inspect only the platform-managed endpoint, never a selected remote context.
task_dolt_id=$(awk -F= '$1=="NOTICEOS_TEST_DOLT_IMAGE_ID" {print $2}' "$task_store_tools/runtime.env")
if [[ ! "$task_dolt_id" =~ ^sha256:[0-9a-f]{64}$ ]]; then echo 'Invalid pinned Dolt image cache metadata' >&2; exit 1; fi
if ! env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  docker --host=unix:///var/run/docker.sock image inspect "$task_dolt_id" >/dev/null 2>&1; then
  task_dolt_image=$(node --input-type=module -e 'import {DOLT_IMAGE} from "./scripts/dolt-host.mjs";console.log(DOLT_IMAGE)')
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock pull "$task_dolt_image"
fi
