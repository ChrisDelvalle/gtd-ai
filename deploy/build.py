#!/usr/bin/env python3
"""Build every deployment image from source; no installation credentials used."""

from pathlib import Path
import argparse
import shutil
import json
import os
import subprocess
import sys
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument(
    "--cache-dir", type=Path,
    help="Optional external BuildKit layer cache (requires a compatible Docker driver)",
)
args = parser.parse_args()
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
compose = ["docker", "compose", "-f", str(root / "compose.yaml")]
if args.cache_dir:
    cache = args.cache_dir.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    # Only the operator target exports: it includes the expensive Rust service
    # layers too. All application targets can reuse them without duplicate
    # exports. Cache mounts are ephemeral; a miss always builds from source.
    current, fresh = cache / "current", cache / "next"
    if fresh.exists():
        shutil.rmtree(fresh)
    sources = [f"type=local,src={current}"] if (current / "index.json").exists() else []
    override = {
        "services": {
            name: {"build": {"cache_from": sources}}
            for name in ("service", "adapter", "operator")
        }
    }
    override["services"]["operator"]["build"]["cache_to"] = [
        f"type=local,dest={fresh},mode=max"
    ]
    cache_config = output / "compose-cache.json"
    cache_config.write_text(json.dumps(override))
    compose.extend(["-f", str(cache_config)])
    # Compose delegates to Bake but does not forward filesystem entitlements
    # for external cache sources. Use its resolved build definition and grant
    # only the explicit cache paths, rather than disabling Bake's checks.
    bake_config = output / "bake-cache.json"
    bake_config.write_bytes(subprocess.check_output([*compose, "build", "--print"], cwd=root))
    build = ["docker", "buildx", "bake", "-f", str(bake_config), "--load"]
    if sources:
        build.extend(["--allow", f"fs.read={current}"])
    # Bake checks the existing parent when the output directory is new.
    build.extend(["--allow", f"fs.write={cache}"])
else:
    build = [*compose, "build"]
subprocess.run(build, cwd=root, check=True)
if args.cache_dir:
    # Replace instead of accumulating stale layers indefinitely. The previous
    # cache remains intact if building or exporting failed.
    if current.exists():
        shutil.rmtree(current)
    fresh.rename(current)
print(
    "Built service, adapter, operator, identity and gateway images. No services started."
)
