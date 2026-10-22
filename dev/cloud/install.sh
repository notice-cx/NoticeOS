#!/bin/bash
set -euo pipefail
umask 022
. "$(dirname -- "${BASH_SOURCE[0]}")/paths.sh"
cd "$NOTICEOS_REPO"
if [ "$(uname -s)/$(uname -m)" != Linux/x86_64 ] || [ "$(id -u)" -eq 0 ]; then
  echo 'Use a non-root Linux x86_64 task user.' >&2; exit 1
fi
# Relocated native binaries target the Debian 13 ABI.
. /etc/os-release
if [ "$ID/${VERSION_ID:-}" != debian/13 ]; then
  echo 'Native tool installation requires Debian 13; provision system tools on other hosts.' >&2; exit 1
fi
noticeos_owned_dir "$NOTICEOS_CLOUD_TOOLS"
noticeos_owned_dir "$NOTICEOS_CLOUD_STATE"
noticeos_owned_dir "$NOTICEOS_CLOUD_CACHE"
noticeos_headroom "$NOTICEOS_CLOUD_TOOLS"
mkdir -p "$NOTICEOS_CLOUD_TOOLS/bin" "$NOTICEOS_CLOUD_STATE/locks"
exec 8>"$NOTICEOS_CLOUD_STATE/locks/verification.lock"
flock -x 8
# Use only the local development daemon, retaining its proxy, CA and auth.
task_docker() { noticeos_managed_docker "$@"; }
task_docker info --format '{{.ServerVersion}}'
docker compose version
task_postgres() (
  local task_major="$1" task_folder="$2" task_image="$3" task_container task_pg_root
  task_pg_root="${NOTICEOS_CLOUD_TOOLS}/$task_folder"
  if [ -f "$task_pg_root/.noticeos-pg$task_major-image" ] && [ "$(cat "$task_pg_root/.noticeos-pg$task_major-image")" != "$task_image" ]; then
    echo "PostgreSQL $task_major cache has another image pin; select a new NOTICEOS_CLOUD_TOOLS directory." >&2; exit 1
  fi
  if [ ! -f "$task_pg_root/.noticeos-pg$task_major-image" ]; then
    task_docker pull "$task_image"
    task_container=$(task_docker create "$task_image")
    trap 'task_docker rm "$task_container" >/dev/null' EXIT
    mkdir -p "$task_pg_root/usr/lib/postgresql" "$task_pg_root/usr/share/postgresql" "$task_pg_root/usr/lib/x86_64-linux-gnu"
    task_docker cp "$task_container:/usr/lib/postgresql/$task_major" "$task_pg_root/usr/lib/postgresql/"
    task_docker cp "$task_container:/usr/share/postgresql/$task_major" "$task_pg_root/usr/share/postgresql/"
    task_docker cp -L "$task_container:/usr/share/postgresql/postgresql.conf.sample" "$task_pg_root/usr/share/postgresql/"
    task_docker cp -L "$task_container:/usr/lib/x86_64-linux-gnu/libpq.so.5" "$task_pg_root/usr/lib/x86_64-linux-gnu/libpq.so.5"
    if [ "$task_major" = 18 ]; then
      task_docker cp -L "$task_container:/usr/lib/x86_64-linux-gnu/liburing.so.2" "$task_pg_root/usr/lib/x86_64-linux-gnu/liburing.so.2"
    fi
    task_docker rm "$task_container" >/dev/null
    trap - EXIT
    printf '%s\n' "$task_image" > "$task_pg_root/.noticeos-pg$task_major-image"
  fi
)
task_postgres 18 postgres postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6
task_postgres 17 postgres17 postgres@sha256:b8faeff7712663c2773a190181e1246e37e364b887611c04658c28b44e2408fe
# Preserve the relocated psql launcher and extend matching-library selection
# to the other native tools used by deliberately sanitized child environments.
python3 - <<'PY'
from pathlib import Path
import os
import shlex
for major, dirname in [('18', 'postgres'), ('17', 'postgres17')]:
    root = Path(os.environ['NOTICEOS_CLOUD_TOOLS']) / dirname
    for name in ['postgres', 'psql', 'pg_config', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore', 'pg_isready', 'createdb', 'dropdb']:
        binary = root / f'usr/lib/postgresql/{major}/bin' / name
        real = binary.with_name(name + '.real')
        if not real.exists(): binary.rename(real)
        temp = binary.with_name(name + '.noticeos-new')
        # Some tests expose just psql into a sanitized PATH with no shell tools.
        # Absolute paths keep that launcher usable outside its bin directory.
        lib = root / 'usr/lib/x86_64-linux-gnu'
        temp.write_text('#!/bin/sh\nexport LD_LIBRARY_PATH=' + shlex.quote(str(lib))
                        + '${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\nexec '
                        + shlex.quote(str(real)) + ' "$@"\n')
        temp.chmod(0o755)
        temp.replace(binary)
PY
# APT verifies the Debian signatures and package hashes before extraction.
if [ ! -x "$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/bin/sqlite3" ]; then
  task_apt="$NOTICEOS_CLOUD_TOOLS/apt"
  mkdir -p "$task_apt/lists/partial" "$task_apt/archives/partial" "$task_apt/empty" "$NOTICEOS_CLOUD_TOOLS/sqlite"
  printf '%s\n' 'deb [signed-by=/usr/share/keyrings/debian-archive-keyring.gpg] https://deb.debian.org/debian trixie main' > "$task_apt/sources.list"
  python3 - "$task_apt" <<'PYAPT'
import json
from pathlib import Path
import sys
apt = Path(sys.argv[1])
(apt / "empty.conf").touch()
settings = {"Dir::Etc::main": str(apt / "empty.conf"), "Dir::Etc::parts": str(apt / "empty"),
            "Dir::Etc::sourcelist": str(apt / "sources.list"), "Dir::Etc::sourceparts": str(apt / "empty"),
            "Dir::State::lists": str(apt / "lists"), "Dir::Cache::archives": str(apt / "archives"),
            "Dir::Cache::pkgcache": "", "Dir::Cache::srcpkgcache": ""}
(apt / "apt.conf").write_text(''.join(f'{key} {json.dumps(value)};\n' for key, value in settings.items()))
PYAPT
  (
    cd "$NOTICEOS_CLOUD_TOOLS/sqlite"
    APT_CONFIG="$task_apt/apt.conf" apt-get update
    APT_CONFIG="$task_apt/apt.conf" apt-get download sqlite3 libsqlite3-0
    for task_deb in *.deb; do dpkg-deb -x "$task_deb" root; done
  )
fi
# Use a checksum-verified CLI release; authentication remains injected at runtime.
if [ ! -x "$NOTICEOS_CLOUD_TOOLS/github-cli/2.103.0/gh_2.103.0_linux_amd64/bin/gh" ]; then
  mkdir -p "$NOTICEOS_CLOUD_TOOLS/github-cli/2.103.0"
  (
    cd "$NOTICEOS_CLOUD_TOOLS/github-cli/2.103.0"
    curl -fsSL https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_checksums.txt -o checksums.txt
    curl -fsSL https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_linux_amd64.tar.gz -o gh_2.103.0_linux_amd64.tar.gz
    awk '$2 == "gh_2.103.0_linux_amd64.tar.gz" { print }' checksums.txt > expected.sha256
    test -s expected.sha256
    sha256sum --check expected.sha256
    tar --no-same-owner -xzf gh_2.103.0_linux_amd64.tar.gz
  )
fi
ln -sfn "$NOTICEOS_CLOUD_TOOLS/github-cli/2.103.0/gh_2.103.0_linux_amd64/bin/gh" "$NOTICEOS_CLOUD_TOOLS/bin/gh"
for task_major in 18 17; do
  task_folder=postgres
  if [ "$task_major" = 17 ]; then task_folder=postgres17; fi
  env -i PATH=/usr/bin:/bin "$NOTICEOS_CLOUD_TOOLS/$task_folder/usr/lib/postgresql/$task_major/bin/initdb" --version
done
LD_LIBRARY_PATH="$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/bin/sqlite3" --version
flock -u 8
exec 8>&-
bash "$NOTICEOS_CLOUD_SOURCE/prepare.sh" "$@"
