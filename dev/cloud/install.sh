#!/bin/bash
# Native tools for a Debian 13 host: PostgreSQL 18, SQLite and the GitHub CLI.
# Then prepare.sh with the same arguments ([--browser] [--with-deps] [--task-store]).
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
# PostgreSQL 18 is the only supported major. Its binaries come from the pinned
# image, through the local development daemon only (retaining its proxy, CA and
# auth). A postgres17 folder from an earlier setup stays for older checkouts.
task_pg_image=postgres@sha256:edb0c08dc33befd0262ab3b5cf1c4f3f8cfd8b09e88c05b45adee29d6761ddb6
task_pg_root="$NOTICEOS_CLOUD_TOOLS/postgres"
task_pg_bin="$task_pg_root/usr/lib/postgresql/18/bin"
if [ -f "$task_pg_root/.noticeos-pg18-image" ] && [ "$(cat "$task_pg_root/.noticeos-pg18-image")" != "$task_pg_image" ]; then
  echo 'PostgreSQL 18 cache has another image pin; select a new NOTICEOS_CLOUD_TOOLS directory.' >&2; exit 1
fi
if [ ! -f "$task_pg_root/.noticeos-pg18-image" ]; then
  (
    task_docker() { noticeos_managed_docker "$@"; }
    task_docker info --format '{{.ServerVersion}}'
    task_docker pull "$task_pg_image"
    task_container=$(task_docker create "$task_pg_image")
    trap 'task_docker rm "$task_container" >/dev/null' EXIT
    mkdir -p "$task_pg_root/usr/lib/postgresql" "$task_pg_root/usr/share/postgresql" "$task_pg_root/usr/lib/x86_64-linux-gnu"
    task_docker cp "$task_container:/usr/lib/postgresql/18" "$task_pg_root/usr/lib/postgresql/"
    task_docker cp "$task_container:/usr/share/postgresql/18" "$task_pg_root/usr/share/postgresql/"
    task_docker cp -L "$task_container:/usr/share/postgresql/postgresql.conf.sample" "$task_pg_root/usr/share/postgresql/"
    # PostgreSQL 18 links io_uring and NUMA libraries older hosts may lack.
    for task_lib in libpq.so.5 liburing.so.2 libnuma.so.1; do
      task_docker cp -L "$task_container:/usr/lib/x86_64-linux-gnu/$task_lib" "$task_pg_root/usr/lib/x86_64-linux-gnu/$task_lib"
    done
  )
  # Preserve the relocated psql launcher and extend matching-library selection
  # to the other native tools used by deliberately sanitized child environments.
  python3 - "$task_pg_root" "$task_pg_bin" <<'PY'
from pathlib import Path
import shlex
import sys
root, bin_dir = Path(sys.argv[1]), Path(sys.argv[2])
lib = root / 'usr/lib/x86_64-linux-gnu'
for name in ['postgres', 'psql', 'pg_config', 'pg_ctl', 'initdb', 'pg_dump', 'pg_restore', 'pg_isready', 'createdb', 'dropdb']:
    binary = bin_dir / name
    real = binary.with_name(name + '.real')
    if not real.exists(): binary.rename(real)
    temp = binary.with_name(name + '.noticeos-new')
    # Some tests expose just psql into a sanitized PATH with no shell tools.
    # Absolute paths keep that launcher usable outside its bin directory.
    temp.write_text('#!/bin/sh\nexport LD_LIBRARY_PATH=' + shlex.quote(str(lib))
                    + '${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\nexec '
                    + shlex.quote(str(real)) + ' "$@"\n')
    temp.chmod(0o755)
    temp.replace(binary)
PY
  printf '%s\n' "$task_pg_image" > "$task_pg_root/.noticeos-pg18-image"
fi
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
task_gh="$NOTICEOS_CLOUD_TOOLS/github-cli/2.103.0"
if [ ! -x "$task_gh/gh_2.103.0_linux_amd64/bin/gh" ]; then
  mkdir -p "$task_gh"
  (
    cd "$task_gh"
    curl -fsSL https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_checksums.txt -o checksums.txt
    curl -fsSL https://github.com/cli/cli/releases/download/v2.103.0/gh_2.103.0_linux_amd64.tar.gz -o gh_2.103.0_linux_amd64.tar.gz
    awk '$2 == "gh_2.103.0_linux_amd64.tar.gz" { print }' checksums.txt > expected.sha256
    test -s expected.sha256
    sha256sum --check expected.sha256
    tar --no-same-owner -xzf gh_2.103.0_linux_amd64.tar.gz
  )
fi
ln -sfn "$task_gh/gh_2.103.0_linux_amd64/bin/gh" "$NOTICEOS_CLOUD_TOOLS/bin/gh"
# initdb --version loads fewer libraries than the server, so check every binary.
for task_binary in "$task_pg_bin"/*.real; do
  task_missing=$(LD_LIBRARY_PATH="$task_pg_root/usr/lib/x86_64-linux-gnu" ldd "$task_binary" | grep 'not found' || true)
  if [ -n "$task_missing" ]; then
    printf 'PostgreSQL 18 %s needs libraries this host lacks:\n%s\nRemove %s and run install.sh again to copy them from the image.\n' \
      "$(basename "$task_binary" .real)" "$task_missing" "$task_pg_root" >&2
    exit 1
  fi
done
env -i PATH=/usr/bin:/bin "$task_pg_bin/initdb" --version
env -i PATH=/usr/bin:/bin "$task_pg_bin/postgres" --version
LD_LIBRARY_PATH="$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" \
  "$NOTICEOS_CLOUD_TOOLS/sqlite/root/usr/bin/sqlite3" --version
"$NOTICEOS_CLOUD_TOOLS/bin/gh" --version
# The tools run from their extracted files; package lists, archives and the
# CLI's download are not read again.
noticeos_discard "$NOTICEOS_CLOUD_TOOLS/apt" "$NOTICEOS_CLOUD_TOOLS"/sqlite/*.deb \
  "$task_gh/checksums.txt" "$task_gh/expected.sha256" "$task_gh/gh_2.103.0_linux_amd64.tar.gz"
flock -u 8
exec 8>&-
bash "$NOTICEOS_CLOUD_SOURCE/prepare.sh" "$@"
