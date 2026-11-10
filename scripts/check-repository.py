#!/usr/bin/env python3
"""Check the source export, not ignored local operational files."""

from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote

root = Path(__file__).resolve().parents[1]
r = subprocess.run(["git", "ls-files", "--cached", "-z"], cwd=root, capture_output=True)
if r.returncode:
    raise SystemExit(
        "Initialize Git and stage the reviewed source before checking the export"
    )
paths = [Path(p) for p in r.stdout.decode().split("\0") if p]
known = {str(p) for p in paths}
errors = []
allowed_keys = {"tests/fixtures/identity/a.pem", "tests/fixtures/identity/b.pem"}
for path in paths:
    p = root / path
    if not p.is_file() or p.is_symlink():
        errors.append(f"{path}: missing or symbolic source")
        continue
    if any(
        part in {"node_modules", "target", "private", "secrets", "test-results"}
        for part in path.parts
    ):
        errors.append(f"{path}: non-source directory")
    if p.stat().st_size > 1024 * 1024:
        errors.append(f"{path}: file exceeds 1 MiB; review artifact provenance")
    if path.suffix.lower() in {
        ".db",
        ".sqlite",
        ".sqlite3",
        ".har",
        ".zip",
        ".gz",
        ".tar",
        ".key",
    }:
        errors.append(f"{path}: private/generated file type")
    if path.suffix == ".pem" and str(path) not in allowed_keys:
        errors.append(f"{path}: unreviewed key material")
    if path.suffix.lower() in {".png", ".jpg", ".jpeg", ".ico"}:
        continue
    text = subprocess.check_output(["git", "show", ":" + str(path)], cwd=root).decode(
        errors="replace"
    )
    # Match private workstation paths without embedding anyone's actual identifiers.
    if re.search(r"/(?:Users|home)/[^/\s]+/", text):
        errors.append(f"{path}: personal absolute path")
    if path.suffix == ".md":
        prose = re.sub(r"```.*?```", "", text, flags=re.S)
        for target in re.findall(r"\]\(([^)]+)\)", prose):
            target = target.split(' "')[0].split("#")[0]
            if not target or re.match(r"[a-z]+:", target):
                continue
            resolved = (p.parent / unquote(target)).resolve()
            if (
                not resolved.is_relative_to(root)
                or str(resolved.relative_to(root)) not in known
            ):
                errors.append(f"{path}: missing tracked link {target}")
# The two documented RSA advisory exceptions are bound to this exact chain.
import tomllib

packages = {
    p["name"]: p["version"]
    for p in tomllib.loads((root / "Cargo.lock").read_text())["package"]
}
for name, version in {
    "openidconnect": "4.0.1",
    "rsa": "0.9.10",
    "crypto-bigint": "0.5.5",
}.items():
    if packages.get(name) != version:
        errors.append("Re-review the narrowly scoped advisory exception for " + name)
for path in (root / "src").rglob("*.rs"):
    if re.search(
        r"CoreRsaPrivateSigningKey|rsa::RsaPrivateKey|rsa::pkcs1v15::DecryptingKey",
        path.read_text(),
    ):
        errors.append(
            str(path.relative_to(root)) + ": private RSA use requires advisory review"
        )
if errors:
    print("\n".join(errors))
    sys.exit(1)
print(f"Reviewed source structure and documentation links: {len(paths)} files")
