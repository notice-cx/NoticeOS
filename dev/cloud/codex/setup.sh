#!/bin/bash
# Optional adapter for a Codex image's install_script.
set -euo pipefail
cloud_source=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
bash "$cloud_source/install.sh" "$@"
python3 "$cloud_source/codex/shell-hooks.py"
