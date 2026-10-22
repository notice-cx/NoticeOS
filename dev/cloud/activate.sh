# Source from Bash, or use test.sh to activate for a single command.
. "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh" || return 1
noticeos_toolchain=$(python3 "$NOTICEOS_CLOUD_SOURCE/requirements.py" tools) || return 1
if [ ! -x "$noticeos_toolchain/node_modules/.bin/node" ] || [ ! -x "$noticeos_toolchain/node_modules/.bin/pnpm" ]; then
  printf '%s\n' 'NoticeOS toolchain needs preparation: run bash dev/cloud/prepare.sh' >&2
  unset noticeos_toolchain
  return 1
fi
export PATH="$noticeos_toolchain/node_modules/.bin:$NOTICEOS_CLOUD_TOOLS/bin:$NOTICEOS_CLOUD_TOOLS/postgres/usr/lib/postgresql/18/bin:$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/bin:$PATH"
export LD_LIBRARY_PATH="$NOTICEOS_CLOUD_TOOLS/postgres/usr/lib/x86_64-linux-gnu:$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export NOTICEOS_TEST_PNPM_EXECUTABLE="$noticeos_toolchain/node_modules/pnpm/pnpm"
export npm_config_cache="$NOTICEOS_CLOUD_CACHE/npm"
export PNPM_HOME="$NOTICEOS_CLOUD_CACHE/pnpm-home"
export WRANGLER_SEND_METRICS=false
unset noticeos_toolchain
