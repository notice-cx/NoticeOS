#!/bin/bash
set -euo pipefail
umask 077
cd /var/lib/dolt
if [ ! -f .noticeos-initialized ]; then
  # Refuse adopting a pre-existing volume, including a failed partial setup.
  [ -z "$(ls -A)" ] || { echo 'Task data is not empty; explicit recovery is required.' >&2; exit 1; }
  root_password=$(cat /run/secrets/dolt_root)
  task_password=$(cat /run/secrets/dolt_noticeos)
  [[ $root_password =~ ^[0-9a-f]{64}$ && $task_password =~ ^[0-9a-f]{64}$ ]] || exit 1
  mkdir -p "$HOME/.dolt"
  printf '{"metrics.disabled":"true"}\n' > "$HOME/.dolt/config_global.json"
  # Initialize grants offline, before opening the listener. SQL and passwords
  # travel only over stdin; even a failed SQL command cannot log the statement.
  if ! printf "CREATE USER 'noticeos_owner'@'localhost' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON *.* TO 'noticeos_owner'@'localhost' WITH GRANT OPTION; CREATE USER 'noticeos'@'%%' IDENTIFIED BY '%s'; GRANT ALL PRIVILEGES ON *.* TO 'noticeos'@'%%'; DROP USER IF EXISTS 'root'@'localhost';\n" "$root_password" "$task_password" |
    dolt --data-dir=/var/lib/dolt --doltcfg-dir=/var/lib/dolt/.doltcfg sql --batch >/dev/null 2>&1; then
    echo 'Task credentials could not be initialized; explicit recovery is required.' >&2
    exit 1
  fi
  unset root_password task_password
  touch .noticeos-initialized
fi
exec dolt sql-server --config=/etc/noticeos/server.yaml
