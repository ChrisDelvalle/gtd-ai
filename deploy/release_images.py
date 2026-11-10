"""Retain exact application images beside a database bundle in encrypted backups."""

import hashlib
import json
from pathlib import Path
import re
import subprocess

import gtd


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def capture(images, directory):
    ids = sorted(set(images.values()))
    if not ids or any(not re.fullmatch("sha256:[a-f0-9]{64}", value) for value in ids):
        raise ValueError("Release backup requires immutable image IDs")
    directory.mkdir(mode=0o700)
    archive = directory / "images.tar"
    with archive.open("xb") as stream:
        result = subprocess.run(
            ["docker", "image", "save", *ids],
            stdout=stream,
            stderr=subprocess.PIPE,
            timeout=600,
        )
        if result.returncode:
            raise RuntimeError("Release image capture failed; backup was not accepted")
    gtd.atomic_json(
        directory / "manifest.json",
        {
            "format": 1,
            "images": ids,
            "bytes": archive.stat().st_size,
            "sha256": digest(archive),
        },
    )


def restore(images, directory):
    archive = directory / "images.tar"
    control = directory / "manifest.json"
    if (
        not directory.is_dir()
        or directory.is_symlink()
        or {p.name for p in directory.iterdir()} != {"images.tar", "manifest.json"}
    ):
        raise ValueError("Recovery requires the paired release image archive")
    if (
        any(not p.is_file() or p.is_symlink() for p in (archive, control))
        or control.stat().st_size > 65536
    ):
        raise ValueError("Invalid release image archive")
    value = json.loads(control.read_text())
    ids = sorted(set(images.values()))
    if not ids or any(not re.fullmatch("sha256:[a-f0-9]{64}", image) for image in ids):
        raise ValueError("Invalid recovery image identity")
    if value != {
        "format": 1,
        "images": ids,
        "bytes": archive.stat().st_size,
        "sha256": digest(archive),
    }:
        raise ValueError(
            "Release image archive does not match the recovery configuration"
        )
    missing = False
    for image in ids:
        result = subprocess.run(
            ["docker", "image", "inspect", image],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=30,
        )
        missing = missing or result.returncode != 0
    if missing:
        gtd.run("docker", "image", "load", "--input", str(archive), timeout=600)
    for image in ids:
        gtd.run("docker", "image", "inspect", image)
