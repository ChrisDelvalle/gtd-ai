#!/usr/bin/env python3
"""Build every deployment image from source; no installation credentials used."""

from pathlib import Path
import json
import os
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[1]
revision = subprocess.run(
    ["git", "rev-parse", "HEAD"], cwd=root, capture_output=True, text=True
)
requested = os.environ.get("GTD_SOURCE_REVISION")
if revision.returncode == 0:
    actual_revision = revision.stdout.strip()
    dirty = subprocess.check_output(
        ["git", "status", "--porcelain"], cwd=root, text=True
    ).strip()
    if requested != "development":
        if dirty:
            raise SystemExit(
                "Commit reviewed changes before building a release; use GTD_SOURCE_REVISION=development only for local development images"
            )
        if requested and requested != actual_revision:
            raise SystemExit("Source revision does not match this checkout")
        os.environ["GTD_SOURCE_REVISION"] = actual_revision
elif not requested:
    raise SystemExit(
        "A source archive build requires GTD_SOURCE_REVISION for its matching commit"
    )
output = root / "artifacts" / ("keycloak-" + str(time.time_ns()))
output.parent.mkdir(exist_ok=True)
subprocess.run(
    [
        sys.executable,
        str(root / "deploy/keycloak/build-keycloak-patch.py"),
        str(output),
    ],
    check=True,
)
provenance = json.loads((output / "build.json").read_text())
actual = subprocess.check_output(
    ["docker", "image", "inspect", "--format", "{{.Id}}", provenance["image"]],
    text=True,
).strip()
if actual != provenance["image_id"]:
    raise SystemExit("Patched identity image changed during build")
subprocess.run(
    ["docker", "compose", "-f", str(root / "compose.yaml"), "build"],
    cwd=root,
    check=True,
)
print(
    "Built service, adapter, operator, identity and gateway images. No services started."
)
