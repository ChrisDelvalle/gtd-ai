#!/usr/bin/env python3
"""Exercise built deployment images in networkless, disposable namespaces."""

from pathlib import Path
import os
import shutil
import subprocess
import sys
import tomllib

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "deploy/multi-user"))
from stack_config import POSTGRES, MEILI
from staging_acceptance import NODE

version = tomllib.loads((root / "Cargo.toml").read_text())["package"]["version"]
env = {**os.environ}
for name in ("service", "adapter", "identity", "gateway"):
    image = subprocess.check_output(
        [
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            "gtd-" + name + ":" + version,
        ],
        text=True,
    ).strip()
    for scope in ("STAGING", "PRODUCTION"):
        env["GTD_TEST_" + scope + "_" + name.upper() + "_IMAGE"] = image
for image in (POSTGRES, MEILI, NODE):
    subprocess.run(["docker", "pull", image], check=True)
restic = shutil.which("restic")
if not restic:
    raise SystemExit("Install Restic to exercise encrypted recovery")
env.update(
    GTD_TEST_STAGING_CONFIG="1",
    GTD_TEST_STAGING_RUNTIME="1",
    GTD_TEST_STAGING_AUTH="1",
    GTD_TEST_PRODUCTION_CONFIG="1",
    GTD_TEST_PRODUCTION_OWNER="1",
    GTD_TEST_RESTIC=restic,
    GTD_TEST_STAGING_RECOVERY="1",
)
subprocess.run(
    [sys.executable, "-m", "unittest", "discover", "-s", "deploy/tests", "-v"],
    env=env,
    cwd=root,
    check=True,
    timeout=120,
)
subprocess.run(
    [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        "deploy/multi-user",
        "-p",
        "test_*.py",
        "-v",
    ],
    env=env,
    cwd=root,
    check=True,
    timeout=1200,
)
env.pop("GTD_TEST_STAGING_RECOVERY")
env["GTD_TEST_STAGING_APPLICATION_RECOVERY"] = "1"
subprocess.run(
    [
        sys.executable,
        "-m",
        "unittest",
        "discover",
        "-s",
        "deploy/multi-user",
        "-p",
        "test_staging.py",
        "-v",
    ],
    env=env,
    cwd=root,
    check=True,
    timeout=1200,
)
