#!/usr/bin/env python3
"""Read NoticeOS tool pins and dependency inputs without using its node_modules."""
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import sys

repo = Path(os.environ.get("NOTICEOS_REPO", Path(__file__).resolve().parents[2])).resolve()
if len(sys.argv) > 2:
    repo = Path(sys.argv[2]).resolve()
manifest = json.loads((repo / "package.json").read_text())
if manifest.get("name") != "noticeos":
    raise SystemExit("Expected a NoticeOS checkout")
ci = (repo / ".github/workflows/ci.yml").read_text()
pins = set(re.findall(r"node-version:\s*['\"]?(\d+\.\d+\.\d+)", ci))
if len(pins) != 1:
    raise SystemExit("CI must select one exact Node version; update environment setup for changed pin format")
node = pins.pop()
engine = manifest.get("engines", {}).get("node", "")
minimum = re.fullmatch(r">=(\d+\.\d+\.\d+)", engine)
if minimum:
    satisfied = tuple(map(int, node.split('.'))) >= tuple(map(int, minimum.group(1).split('.')))
else:
    satisfied = engine == node
if not satisfied:
    raise SystemExit("CI Node pin must satisfy the repository engine; update setup for unsupported range syntax")
match = re.fullmatch(r"pnpm@(\d+\.\d+\.\d+)(?:\+sha\d+\.[a-f0-9]+)?", manifest.get("packageManager", ""))
if not match:
    raise SystemExit("Expected an exact pnpm packageManager pin")
pnpm = match.group(1)
key = f"{sys.platform}-{platform.machine()}-node-{node}-pnpm-{pnpm}"
cache = Path(os.environ.get("NOTICEOS_CLOUD_CACHE", Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "noticeos-cloud"))
tools = Path(os.environ.get("NOTICEOS_CLOUD_TOOLS", cache / "tools")) / "toolchains" / key
inputs = [repo / "package.json", repo / "pnpm-lock.yaml", repo / "pnpm-workspace.yaml"]
for group in ("apps", "workers", "packages"):
    inputs.extend(sorted((repo / group).glob("*/package.json")))
inputs.append(repo / "docs/package.json")
inputs.extend(repo / name for name in (".npmrc", ".pnpmfile.cjs"))
inputs.extend(sorted((repo / "patches").rglob("*")))
digest = hashlib.sha256(key.encode())
for path in inputs:
    if path.is_file():
        digest.update(str(path.relative_to(repo)).encode())
        digest.update(path.read_bytes())
value = {"repo": str(repo), "node": node, "pnpm": pnpm, "key": key,
         "tools": str(tools), "dependencies": digest.hexdigest()}
field = sys.argv[1] if len(sys.argv) > 1 else "json"
print(json.dumps(value) if field == "json" else value[field])
