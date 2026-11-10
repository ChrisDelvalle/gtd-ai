import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import tarfile
import time
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gtd
import recover
import upgrade
import release_images


class Operations(unittest.TestCase):
    def test_abbreviated_restic_id_resolves_exactly_and_never_uses_latest(self):
        full = "a" * 64
        with patch.object(gtd, "run", return_value=json.dumps([{"id": full}])) as run:
            self.assertEqual(
                gtd.resolve_snapshot("fixture-repo", Path("fixture-key"), full[:8]),
                full,
            )
            self.assertEqual(run.call_args.args[-1], full[:8])
        for result in ([], [{"id": full}, {"id": full}], [{"id": "b" * 64}]):
            with (
                patch.object(gtd, "run", return_value=json.dumps(result)),
                self.assertRaises(RuntimeError),
            ):
                gtd.resolve_snapshot("fixture-repo", Path("fixture-key"), full[:8])

    @unittest.skipUnless(
        os.environ.get("GTD_TEST_STAGING_CONFIG") == "1",
        "requires explicitly enabled disposable Docker tests",
    )
    def test_exact_release_image_recovers_after_local_image_is_removed(self):
        content = b"disposable release archive fixture"
        source = io.BytesIO()
        with tarfile.open(fileobj=source, mode="w") as archive:
            entry = tarfile.TarInfo("fixture.txt")
            entry.size = len(content)
            archive.addfile(entry, io.BytesIO(content))
        image = gtd.run(
            "docker", "image", "import", "-", input=source.getvalue()
        ).strip()
        self.assertRegex(image, r"^sha256:[a-f0-9]{64}$")
        try:
            with tempfile.TemporaryDirectory() as temp:
                root = Path(temp) / "release"
                images = {"service": image}
                release_images.capture(images, root)
                gtd.run("docker", "image", "rm", image)
                release_images.restore(images, root)
                self.assertEqual(
                    gtd.run(
                        "docker", "image", "inspect", "--format", "{{.Id}}", image
                    ).strip(),
                    image,
                )
        finally:
            gtd.run("docker", "image", "rm", image)

    def test_release_archive_must_match_images_and_bytes_before_loading(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "images.tar"
            archive.write_bytes(b"fixture image archive")
            images = {"service": "sha256:" + "a" * 64}
            value = {
                "format": 1,
                "images": list(images.values()),
                "bytes": archive.stat().st_size,
                "sha256": release_images.digest(archive),
            }
            gtd.atomic_json(root / "manifest.json", value)
            with (
                patch.object(release_images.subprocess, "run") as inspect,
                patch.object(gtd, "run") as run,
            ):
                inspect.return_value.returncode = 1
                release_images.restore(images, root)
                self.assertEqual(
                    run.call_args_list[0].args[:3], ("docker", "image", "load")
                )
                self.assertEqual(
                    run.call_args_list[1].args,
                    ("docker", "image", "inspect", images["service"]),
                )
            archive.write_bytes(b"tampered")
            with (
                patch.object(release_images.subprocess, "run") as inspect,
                patch.object(gtd, "run") as run,
                self.assertRaises(ValueError),
            ):
                release_images.restore(images, root)
            inspect.assert_not_called()
            run.assert_not_called()

    def test_release_archive_does_not_reload_existing_images(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / "images.tar"
            archive.write_bytes(b"fixture")
            images = {"service": "sha256:" + "a" * 64}
            gtd.atomic_json(
                root / "manifest.json",
                {
                    "format": 1,
                    "images": list(images.values()),
                    "bytes": 7,
                    "sha256": release_images.digest(archive),
                },
            )
            with (
                patch.object(release_images.subprocess, "run") as inspect,
                patch.object(gtd, "run") as run,
            ):
                inspect.return_value.returncode = 0
                release_images.restore(images, root)
                run.assert_called_once_with(
                    "docker", "image", "inspect", images["service"]
                )

    def test_recovery_invalidates_sessions_but_not_authoritative_content(self):
        class Database:
            def __init__(self):
                self.statements = []

            def query(self, sql):
                self.statements.append(sql)
                if "row_to_json" in sql:
                    return {
                        "identity": "fixture-id",
                        "environment": "staging",
                        "compatibility": 13,
                    }

        db = Database()
        recover.invalidate_application(db, "fixture-id", "staging")
        sql = " ".join(db.statements)
        self.assertIn("DELETE FROM gtd.web_sessions", sql)
        self.assertIn("account_state SET identity=gen_random_uuid()", sql)
        for table in ("tasks", "changes", "requests", "revisions", "action_groups"):
            self.assertNotIn("DELETE FROM gtd." + table, sql)
        with self.assertRaises(ValueError):
            recover.invalidate_application(db, "foreign", "staging")
        self.assertTrue(db.statements[-1].startswith("ROLLBACK"))

    def test_upgrade_requires_fresh_bound_backup_before_stopping_anything(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / "operator").mkdir()
            for receipt in (
                {"database_identity": "foreign", "verified_at": time.time()},
                {"database_identity": "expected", "verified_at": time.time() - 3601},
            ):
                gtd.atomic_json(root / "operator/verified-backup.json", receipt)
                with (
                    patch.object(gtd, "compose") as compose,
                    self.assertRaises(ValueError),
                ):
                    upgrade.switch(
                        root, {"database_identity": "expected"}, gtd.STAGING, {}
                    )
                compose.assert_not_called()

    def test_upgrade_rejects_mutable_image_tags(self):
        with patch.object(gtd, "run") as run:
            for image in ("latest", "gtd-service:latest", "sha256:bad"):
                with self.assertRaises(ValueError):
                    upgrade.image(image)
            run.assert_not_called()

    def test_start_readiness_and_port_probe_use_loopback_only(self):
        with tempfile.TemporaryDirectory() as temp:
            with (
                patch.object(gtd, "compose", return_value=""),
                patch.object(gtd.socket, "socket") as socket,
            ):
                socket.return_value.__enter__.return_value.connect_ex.return_value = 0
                with self.assertRaises(ValueError):
                    gtd.ensure_ports(gtd.STAGING, Path(temp))
                self.assertEqual(
                    socket.return_value.__enter__.return_value.connect_ex.call_args.args[
                        0
                    ][0],
                    "127.0.0.1",
                )

    def test_caddy_matchers_do_not_collide_on_shared_subdomain(self):
        first = gtd.mcp_route("mcp.one.example.com", 1000, []).splitlines()[0]
        second = gtd.mcp_route("mcp.two.example.com", 1000, []).splitlines()[0]
        self.assertNotEqual(first.split()[0], second.split()[0])


if __name__ == "__main__":
    unittest.main()
