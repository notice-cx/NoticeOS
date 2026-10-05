#!/bin/bash
# Online logical snapshots; never copy live Dolt chunk/data files. The few
# non-versioned configuration files are atomically replaced by pinned Dolt.
set -euo pipefail
umask 077
stage=$1
shift
[[ $stage =~ ^/tmp/noticeos-backup-[0-9a-f]{32}$ && $# -gt 0 ]] || exit 1
mkdir "$stage"
mkdir "$stage/databases" "$stage/status"

metadata() {
  /bin/bash /etc/noticeos/backup-metadata.sh /var/lib/dolt /var/lib/dolt/.noticeos-home "$1" "${databases[@]}"
}
databases=("$@")
for database in "${databases[@]}"; do
  [[ $database =~ ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ ]] || exit 1
done
metadata "$stage/before"
for database in "${databases[@]}"; do
  /bin/bash /etc/noticeos/sql.sh root "CALL DOLT_BACKUP('sync-url', 'file://$stage/databases/$database');" "$database" > "$stage/status/$database.json" 2>/dev/null
done
metadata "$stage/after"
# Stable, complete configuration generations, including missing-vs-present.
# Each database snapshot is consistent; databases are captured sequentially.
diff -r "$stage/before" "$stage/after" >/dev/null || exit 1
mv "$stage/before" "$stage/metadata"
rm -r "$stage/after"
