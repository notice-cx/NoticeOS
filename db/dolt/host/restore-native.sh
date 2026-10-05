#!/bin/bash
# Explicit native-source recovery only: new empty volume, protected cold copy,
# and target-only credentials adapted before any network listener opens.
set -euo pipefail
umask 077
stage=$1
global_name=$2
[[ $stage =~ ^/var/lib/dolt/.noticeos-native-restore-[0-9a-f]{32}$ && $global_name =~ ^[a-zA-Z][a-zA-Z0-9_-]{0,62}$ ]] || exit 1
cd /var/lib/dolt
for entry in .* *; do
  [ "$entry" = . ] || [ "$entry" = .. ] || [ "$entry" = '*' ] || [ "$entry" = '.*' ] ||
    [ "$entry" = "${stage##*/}" ] || { echo 'Native restore volume is not empty.' >&2; exit 1; }
done
[ -d "$stage/data" ] && [ -f "$stage/capture.json" ] || exit 1
[ ! -e "$stage/data/.noticeos-initialized" ] || exit 1
cp -R "$stage/data/." .
mkdir -p "$HOME/.dolt"
if [ -f "$stage/metadata/$global_name" ] && [ ! -e "$stage/metadata/$global_name.absent" ]; then
  cp "$stage/metadata/$global_name" "$HOME/.dolt/config_global.json"
elif [ -f "$stage/metadata/$global_name.absent" ] && [ ! -e "$stage/metadata/$global_name" ]; then
  printf '{}\n' > "$HOME/.dolt/config_global.json"
else
  exit 1
fi
# Source global config remains byte-exact in immutable capture custody. This
# one setting changes only on the new target, before any Dolt client uploads.
dolt config --global --add metrics.disabled true >/dev/null 2>&1
root_password=$(cat /run/secrets/dolt_root)
task_password=$(cat /run/secrets/dolt_noticeos)
[[ $root_password =~ ^[0-9a-f]{64}$ && $task_password =~ ^[0-9a-f]{64}$ ]] || exit 1
# Source SQL grants are preserved in the capture and on the original source.
# Add the target profile's accounts; retain other original principals/grants.
# Existing target account names refuse, never silently replace credentials.
if ! printf "CREATE USER 'noticeos_owner'@'localhost' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON *.* TO 'noticeos_owner'@'localhost' WITH GRANT OPTION; CREATE USER 'noticeos'@'%%' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON *.* TO 'noticeos'@'%%'; DROP USER IF EXISTS 'root'@'localhost';\n" "$root_password" "$task_password" |
  dolt --data-dir=/var/lib/dolt --doltcfg-dir=/var/lib/dolt/.doltcfg sql --batch >/dev/null 2>&1; then
  echo 'Native target credentials could not be adapted; explicit recovery is required.' >&2
  exit 1
fi
unset root_password task_password
touch .noticeos-initialized
rm -r "$stage"
