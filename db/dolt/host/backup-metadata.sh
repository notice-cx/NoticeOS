#!/bin/bash
# The same non-versioned metadata generation for both backup transports.
set -euo pipefail
umask 077
source_root=$1
source_home=$2
target=$3
shift 3
[[ $source_root = /var/lib/dolt || $source_root = /dolt-data ]] || exit 1
[[ $source_home = "$source_root/.noticeos-home" ]] || exit 1
[[ $target =~ ^(/tmp/noticeos-backup-[0-9a-f]{32}|/backup-staging/noticeos-backup-[0-9a-f]{32})/(before|after)$ ]] || exit 1
[ $# -gt 0 ] || exit 1

copy_optional() {
  local source=$1 output=$2
  [ ! -L "$source" ] || exit 1
  if [ -e "$source" ]; then
    [ -f "$source" ] || exit 1
    cp "$source" "$output"
  else
    : > "$output.absent"
  fi
}

mkdir -p "$target/databases"
copy_optional "$source_root/.doltcfg/privileges.db" "$target/privileges.db"
[ -s "$target/privileges.db" ] || exit 1
copy_optional "$source_root/.doltcfg/branch_control.db" "$target/branch_control.db"
copy_optional "$source_root/.doltcfg/config.json" "$target/server-config.json"
copy_optional "$source_home/.dolt/config_global.json" "$target/global-config.json"
for database in "$@"; do
  [[ $database =~ ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ ]] || exit 1
  mkdir "$target/databases/$database"
  copy_optional "$source_root/$database/.dolt/config.json" "$target/databases/$database/config.json"
  copy_optional "$source_root/$database/.dolt/repo_state.json" "$target/databases/$database/repo_state.json"
done
