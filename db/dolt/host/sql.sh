#!/bin/bash
set -euo pipefail
case ${1:-} in
  root) secret=dolt_root; user=noticeos_owner ;;
  noticeos) secret=dolt_noticeos; user=noticeos ;;
  *) exit 1 ;;
esac
shift
export DOLT_CLI_PASSWORD
DOLT_CLI_PASSWORD=$(cat "/run/secrets/$secret")
# Exact container-local listener; neither the host environment nor a Dolt
# profile may select a different server. No password in argv or output.
database=()
if [ -n "${2:-}" ]; then database=(--use-db "$2"); fi
exec dolt --host=127.0.0.1 --port=3306 --user="$user" --no-tls "${database[@]}" sql --result-format=json --query "$1"
