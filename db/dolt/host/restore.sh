#!/bin/bash
# Only used by explicit recovery into a newly created empty volume.
set -euo pipefail
umask 077
stage=$1
shift
[[ $stage =~ ^/var/lib/dolt/.noticeos-restore-[0-9a-f]{32}$ && $# -gt 0 ]] || exit 1
cd /var/lib/dolt
for entry in .* *; do
  [ "$entry" = . ] || [ "$entry" = .. ] || [ "$entry" = '*' ] || [ "$entry" = '.*' ] ||
    [ "$entry" = "${stage##*/}" ] || { echo 'Restore volume is not empty.' >&2; exit 1; }
done
# The CLI creates a temporary initial commit before syncing backup roots.
# Its identity is confined to this new volume and replaced by source config.
mkdir -p "$HOME/.dolt"
printf '{"user.name":"NoticeOS recovery","user.email":"recovery@example.com","metrics.disabled":"true"}\n' > "$HOME/.dolt/config_global.json"
for database in "$@"; do
  [[ $database =~ ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ ]] || exit 1
  # Pinned Dolt routes backup restore through SQL CREATE DATABASE: its
  # destination is a database name relative to this exact data directory.
  if ! dolt backup restore "file://$stage/databases/$database" "$database" >/dev/null 2>&1; then
    echo 'Task database snapshot restoration failed.' >&2
    exit 1
  fi
done
mkdir -p .doltcfg "$HOME/.dolt"
copy_optional() {
  local source=$1 target=$2
  if [ -f "$source" ] && [ ! -f "$source.absent" ]; then
    cp "$source" "$target"
  elif [ -f "$source.absent" ] && [ ! -e "$source" ]; then
    # The restore CLI may create fresh defaults; source absence is deliberate.
    rm -f "$target"
  else
    exit 1
  fi
}
copy_optional "$stage/metadata/privileges.db" .doltcfg/privileges.db
copy_optional "$stage/metadata/branch_control.db" .doltcfg/branch_control.db
copy_optional "$stage/metadata/server-config.json" .doltcfg/config.json
copy_optional "$stage/metadata/global-config.json" "$HOME/.dolt/config_global.json"
for database in "$@"; do
  copy_optional "$stage/metadata/databases/$database/config.json" "$database/.dolt/config.json"
  copy_optional "$stage/metadata/databases/$database/repo_state.json" "$database/.dolt/repo_state.json"
done
touch .noticeos-initialized
rm -r "$stage"
