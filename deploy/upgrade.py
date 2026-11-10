#!/usr/bin/env python3
"""Switch paired application images at compatibility 13; never restore user data."""

import argparse
import json
import os
import re
import time
from pathlib import Path
import gtd


def image(value):
    if not re.fullmatch("sha256:[a-f0-9]{64}", value):
        raise ValueError("Use a locally built immutable sha256 image ID")
    gtd.run("docker", "image", "inspect", value)
    return value


def switch(root, manifest, layout, images):
    receipt = gtd.private_read(root / "operator/verified-backup.json")
    if (
        receipt.get("database_identity") != manifest["database_identity"]
        or not 0 <= time.time() - receipt["verified_at"] <= 3600
    ):
        raise ValueError(
            "A verified backup from this installation within the past hour is required"
        )
    if not manifest.get("enrolled") or manifest.get("recovery_pending"):
        raise ValueError("Installation is not ready for an upgrade")
    stack = gtd.private_read(root / "compose.json", max_bytes=65536)
    before = {name: stack["services"][name]["image"] for name in ("service", "adapter")}
    for name, value in images.items():
        stack["services"][name]["image"] = image(value)
    journal = root / "operator" / ("release-" + str(time.time_ns()) + ".json")
    gtd.atomic_json(
        journal,
        {
            "database_identity": manifest["database_identity"],
            "before": before,
            "after": images,
            "completed": False,
        },
    )
    gtd.compose(
        root, "--profile", "application", "stop", "gateway", "adapter", "service"
    )
    with gtd.Session(
        manifest["project"] + "-database-1",
        layout.database,
        time.monotonic() + 30,
        port=layout.ports["database"],
    ) as db:
        meta = db.query("SELECT row_to_json(m) FROM gtd.schema_meta m;")
        if (
            meta["identity"] != manifest["database_identity"]
            or meta["compatibility"] != 13
        ):
            raise ValueError(
                "Database differs or requires a separately rehearsed migration; writers remain stopped"
            )
    gtd.atomic_json(root / "compose.json", stack)
    try:
        gtd.compose(root, "--profile", "application", "up", "-d", "service", "adapter")
        gtd.wait_ready(layout)
    except BaseException:
        gtd.compose(root, "--profile", "application", "stop", "adapter", "service")
        for name, value in before.items():
            stack["services"][name]["image"] = value
        gtd.atomic_json(root / "compose.json", stack)
        # Previous files remain recoverable, but do not reopen ingress after an
        # uncertain upgrade. An operator must inspect before resuming service.
        raise RuntimeError(
            "Upgrade did not become ready; prior image configuration restored, ingress remains stopped"
        ) from None
    manifest["images"].update(images)
    gtd.atomic_json(root / "manifest.json", manifest)
    gtd.atomic_json(
        journal,
        {
            "database_identity": manifest["database_identity"],
            "before": before,
            "after": images,
            "completed": True,
        },
    )
    gtd.compose(root, "--profile", "application", "up", "-d", "gateway")
    print("Paired release is ready. Retained release journal: " + journal.name)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", default="installation.toml")
    parser.add_argument("--expected-database", required=True)
    parser.add_argument("--service-image", required=True)
    parser.add_argument("--adapter-image", required=True)
    args = parser.parse_args()
    value, root, layout = gtd.config(args.config)
    manifest = gtd.read_manifest(root, args.expected_database)
    gtd.match_configuration(value, manifest)
    with gtd.lock(root / "operator/activation.lock"):
        switch(
            root,
            manifest,
            layout,
            {"service": args.service_image, "adapter": args.adapter_image},
        )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, (ValueError, RuntimeError))
            else "Upgrade failed; inspect the private release journal"
        ) from None
