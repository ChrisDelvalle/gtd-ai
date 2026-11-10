#!/usr/bin/env python3
"""Restore a verified backup into a NEW private installation; never open ingress."""

import argparse
import base64
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import time
import uuid

import gtd
import release_images
from postgres_bundle import (
    inspect_bundle,
    verify,
    bounded,
    application_state,
    identity_state,
)

FILES = {
    "manifest": "manifest.json",
    "compose": "compose.json",
    "database_environment": "database/environment",
    "database_init": "database/init.sql",
    "database_schema": "database/schema.sql",
    "identity_environment": "identity/environment",
    "service_config": "service/config.json",
    "runtime_dsn": "service/runtime.dsn",
    "website_secret": "service/website.secret",
    "administration_secret": "service/administration.secret",
    "search_secret": "service/search.secret",
    "search_environment": "search/environment",
    "adapter_config": "adapter/config.json",
    "gateway": "gateway/Caddyfile",
    "operator": "operator/identity.json",
}


def materialize(payload, root, expected):
    """Only fixed allowlisted filenames; encrypted configuration is still validated."""
    bundle = inspect_bundle(payload)
    if (
        bundle["database_identity"] != str(uuid.UUID(expected))
        or bundle["schema"] != 13
    ):
        raise ValueError(
            "Backup does not match the expected database or supported compatibility"
        )
    if (
        root.exists()
        or not root.is_absolute()
        or root != root.resolve()
        or not root.parent.is_dir()
    ):
        raise ValueError("Recovery requires a new canonical absolute state directory")
    if root == gtd.ROOT or gtd.ROOT in root.parents:
        raise ValueError("Recovery state must remain outside the source checkout")
    data = json.loads((payload / "recovery.json").read_text())["files"]
    if set(data) != set(FILES):
        raise ValueError("Backup is missing the supported installation recovery files")
    decoded = {k: base64.b64decode(v, validate=True) for k, v in data.items()}
    manifest = json.loads(decoded["manifest"])
    stack = json.loads(decoded["compose"])
    if any(
        manifest.get(k) != bundle[k]
        for k in ("database_identity", "environment", "issuer", "realm")
    ):
        raise ValueError("Recovered configuration and database differ")
    release_images.restore(manifest["images"], payload.parent / "release")
    for image in manifest["images"].values():
        if not re.fullmatch("sha256:[a-f0-9]{64}", image):
            raise ValueError("Recovery image must be immutable")
        gtd.run("docker", "image", "inspect", image)
    sources = [
        v["source"]
        for v in stack["services"]["service"]["volumes"]
        if v["target"] == "/config"
    ]
    if len(sources) != 1:
        raise ValueError("Ambiguous recovered state root")
    old = Path(sources[0]).parent
    if not old.is_absolute():
        raise ValueError("Invalid recovered state root")
    # A distinct Compose project gives recovery a new database volume, even on
    # the same host. Port checks still require the other installation stopped.
    manifest.update(
        project="gtd-recovery-" + uuid.uuid4().hex[:12],
        recovery_pending=True,
        application_enabled=False,
        background_enabled=False,
        ingress_published=False,
    )
    stack["name"] = manifest["project"]

    def rebase(value):
        if isinstance(value, dict):
            return {k: rebase(v) for k, v in value.items()}
        if isinstance(value, list):
            return [rebase(v) for v in value]
        if isinstance(value, str) and value.startswith(str(old) + "/"):
            return str(root) + value[len(str(old)) :]
        return value

    stack = rebase(stack)
    uid, gid = os.getuid(), os.getgid()
    if not uid or not gid:
        raise ValueError("Run recovery as a dedicated non-root deployment user")
    for name, service in stack["services"].items():
        if name != "database" and not (
            name == "gateway" and manifest.get("ingress") == "direct"
        ):
            service["user"] = str(uid) + ":" + str(gid)
    manifest.update(uid=uid, gid=gid)
    root.mkdir(mode=0o700)
    for label, relative in FILES.items():
        path = root / relative
        path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.write_bytes(decoded[label])
        path.chmod(0o600)
    for relative in ("logs", "search/data", "gateway/data"):
        (root / relative).mkdir(mode=0o700, parents=True, exist_ok=True)
    for name in ("init.sql", "schema.sql"):
        (root / "database" / name).chmod(0o644)
    gtd.atomic_json(root / "manifest.json", manifest)
    gtd.atomic_json(root / "compose.json", stack)
    app = gtd.private_read(root / "service/config.json")
    app["background"] = False
    gtd.atomic_json(root / "service/config.json", app)
    gtd.write(root / "operator/backup.secret", secrets.token_urlsafe(48) + "\n")
    return manifest, bundle


def invalidate_application(database, expected, environment):
    """Preserve account/provider bindings; invalidate all restored bearer state."""
    database.query("BEGIN; SELECT to_json(pg_advisory_xact_lock(214716023,1));")
    try:
        meta = database.query(
            "SELECT row_to_json(m) FROM gtd.schema_meta m FOR UPDATE;"
        )
        if (
            meta["identity"] != expected
            or meta["environment"] != environment
            or meta["compatibility"] != 13
        ):
            raise ValueError("Restored database identity differs")
        cutoff = int(time.time())
        database.query(
            f"UPDATE gtd.accounts SET authenticated_after=greatest(coalesce(authenticated_after,0),{cutoff}); "
            "DELETE FROM gtd.web_sessions; DELETE FROM gtd.web_logins; DELETE FROM gtd.search_sessions; "
            "DELETE FROM gtd.search_state WHERE key NOT LIKE 'recurrence:%'; "
            "UPDATE gtd.account_state SET identity=gen_random_uuid(); SELECT to_json(true);"
        )
        database.query("COMMIT; SELECT to_json(true);")
    except BaseException:
        database.query("ROLLBACK; SELECT to_json(true);")
        raise
    return cutoff


def restore_databases(payload, root, manifest, bundle, layout):
    gtd.ensure_ports(layout, root)
    gtd.compose(root, "up", "-d", "--wait", "database")
    container = manifest["project"] + "-database-1"
    deadline = time.monotonic() + 600
    for side, db in (
        ("application", layout.database),
        ("identity", layout.identity_database),
    ):
        with (payload / (side + ".dump")).open("rb") as stream:
            bounded(
                [
                    "docker",
                    "exec",
                    "-i",
                    "--user",
                    "postgres",
                    container,
                    "pg_restore",
                    "-U",
                    "postgres",
                    "-p",
                    str(layout.ports["database"]),
                    "--dbname=" + db,
                    "--clean",
                    "--if-exists",
                    "--exit-on-error",
                    "--single-transaction",
                ],
                deadline,
                stdin=stream,
            )
    with (
        gtd.Session(
            container, layout.database, deadline, port=layout.ports["database"]
        ) as app,
        gtd.Session(
            container, layout.identity_database, deadline, port=layout.ports["database"]
        ) as identity,
    ):
        if (
            application_state(app) != bundle["application"]
            or identity_state(identity) != bundle["identity"]
        ):
            raise ValueError("Restored records differ from the verified backup")
        cutoff = invalidate_application(
            app, manifest["database_identity"], manifest["environment"]
        )
    gtd.compose(root, "up", "-d", "identity")
    deadline = time.monotonic() + 120
    while True:
        try:
            admin = gtd.provider(root, manifest, layout)
            break
        except RuntimeError:
            if time.monotonic() > deadline:
                raise
            time.sleep(0.5)
    admin.revoke(bundle["application"]["accounts"])
    manifest.update(recovery_pending=False, enrolled=True)
    gtd.atomic_json(root / "manifest.json", manifest)
    gtd.atomic_json(
        root / "operator/recovery.json",
        {
            "database_identity": manifest["database_identity"],
            "completed_at": int(time.time()),
            "authenticated_after": cutoff,
            "source_capture": bundle["captured_at"],
        },
    )
    gtd.compose(root, "stop", "identity", "database")


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", required=True)
    parser.add_argument("--password-file", required=True, type=Path)
    parser.add_argument(
        "--snapshot",
        required=True,
        help="Exact 64-character Restic snapshot ID; not latest",
    )
    parser.add_argument("--expected-database", required=True)
    parser.add_argument("--state-dir", required=True, type=Path)
    args = parser.parse_args()
    if not re.fullmatch("[a-f0-9]{64}", args.snapshot):
        raise ValueError("Use an exact snapshot ID")
    if args.state_dir.exists():
        raise ValueError("Recovery target already exists; it was not changed")
    if args.password_file.is_symlink() or args.password_file.stat().st_mode & 0o077:
        raise ValueError("Backup key must be a private regular file")
    with tempfile.TemporaryDirectory(prefix="gtd-restore-") as temporary:
        target = Path(temporary)
        gtd.run(
            "restic",
            "-r",
            args.repository,
            "--password-file",
            str(args.password_file),
            "restore",
            args.snapshot,
            "--target",
            str(target),
            timeout=600,
        )
        candidates = [
            p.parent
            for p in target.rglob("recovery.json")
            if (p.parent / "application.dump").is_file()
        ]
        if len(candidates) != 1:
            raise ValueError("Snapshot must contain exactly one database bundle")
        payload = candidates[0]
        # This public base image is digest-pinned. Application images are restored
        # from the paired, encrypted archive rather than rebuilt or pulled by tag.
        from postgres_bundle import POSTGRES_IMAGE

        gtd.run("docker", "pull", POSTGRES_IMAGE, timeout=300)
        verify(payload, time.monotonic() + 600)
        manifest, bundle = materialize(payload, args.state_dir, args.expected_database)
        layout = gtd.STAGING if manifest["environment"] == "staging" else gtd.PRODUCTION
        try:
            restore_databases(payload, args.state_dir, manifest, bundle, layout)
        except BaseException:
            gtd.compose(args.state_dir, "stop", "identity", "database")
            raise
    print(
        "Recovery verified; all services are stopped. Use a configuration pointing to this state directory to start."
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        raise SystemExit(
            str(error)
            if isinstance(error, (ValueError, RuntimeError))
            else "Recovery failed; state retained privately with ingress disabled"
        ) from None
