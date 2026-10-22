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
# Removes download and staging files a finished preparation no longer reads:
# only owned paths inside the cache or tool folders, never those folders.
# Callers hold the verification lock, so no test or preparation is using them.
noticeos_discard() {
  local task_path task_parent task_cache task_tools
  task_cache=$(cd -P -- "$NOTICEOS_CLOUD_CACHE" && pwd) || return
  task_tools=$(cd -P -- "$NOTICEOS_CLOUD_TOOLS" 2>/dev/null && pwd) || task_tools=$task_cache
  for task_path in "$@"; do
    [ -e "$task_path" ] || [ -L "$task_path" ] || continue
    task_parent=$(cd -P -- "$(dirname -- "$task_path")" && pwd) || return
    case "$task_parent/" in
      "$task_cache"/*|"$task_tools"/*) ;;
      *) printf 'Refusing to discard outside the cloud caches: %s\n' "$task_path" >&2; return 1;;
    esac
    if [ "$(stat -c %u -- "$task_path")" != "$(id -u)" ]; then
      printf 'Refusing to discard a path another user owns: %s\n' "$task_path" >&2
      return 1
    fi
    rm -rf -- "$task_path"
  done
}
noticeos_managed_docker() {
  env -u DOCKER_HOST -u DOCKER_CONTEXT -u DOCKER_TLS -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
    docker --host=unix:///var/run/docker.sock "$@"
}
# Changes only when the pinned task tools or the way they are prepared change.
noticeos_task_tools_key() {
  node "$NOTICEOS_REPO/scripts/task-store-test-tools.mjs" --key
}
