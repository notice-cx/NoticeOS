# Shared paths for the Bash entry points; no downloads or shell-profile edits.
NOTICEOS_CLOUD_SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
export NOTICEOS_REPO="${NOTICEOS_REPO:-$(cd "$NOTICEOS_CLOUD_SOURCE/../.." && pwd -P)}"
export NOTICEOS_CLOUD_CACHE="${NOTICEOS_CLOUD_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/noticeos-cloud}"
export NOTICEOS_CLOUD_TOOLS="${NOTICEOS_CLOUD_TOOLS:-$NOTICEOS_CLOUD_CACHE/tools}"
export NOTICEOS_CLOUD_STATE="${NOTICEOS_CLOUD_STATE:-${XDG_STATE_HOME:-$HOME/.local/state}/noticeos-cloud}"
export NOTICEOS_TEST_RUNTIME_ROOT="${NOTICEOS_TEST_RUNTIME_ROOT:-/var/tmp/noticeos-tests-$(id -u)}"

for noticeos_path in "$NOTICEOS_REPO" "$NOTICEOS_CLOUD_CACHE" "$NOTICEOS_CLOUD_TOOLS" "$NOTICEOS_CLOUD_STATE" "$NOTICEOS_TEST_RUNTIME_ROOT"; do
  case "$noticeos_path" in
    /*) ;;
    *) printf 'NoticeOS cloud paths must be absolute: %s\n' "$noticeos_path" >&2; return 1;;
  esac
done
unset noticeos_path
# Repository fixtures embed process.execPath in executable shebangs.
case "$NOTICEOS_CLOUD_TOOLS" in
  *[[:space:]]*) echo 'NOTICEOS_CLOUD_TOOLS must not contain whitespace; choose a tool path suitable for executable shebangs.' >&2; return 1;;
esac

noticeos_owned_dir() {
  mkdir -p -- "$1" || return
  if [ -L "$1" ] || [ "$(stat -c %u -- "$1")" != "$(id -u)" ]; then
    printf 'Expected an owned directory, without a symlink: %s\n' "$1" >&2
    return 1
  fi
}
noticeos_headroom() {
  local task_free
  task_free=$(df -Pk -- "$1" | awk 'NR==2 {print $4}')
  if [ "$task_free" -lt 12582912 ]; then
    printf 'At least 12 GiB free is required on %s before preparation or verification.\n' "$1" >&2
    return 1
  fi
}
noticeos_managed_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
noticeos_task_tools_key() {
  sha256sum deploy/compose/Dockerfile scripts/dolt-host.mjs scripts/task-store-test-tools.mjs | sha256sum | cut -d ' ' -f 1
}
