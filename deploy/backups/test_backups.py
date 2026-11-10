import contextlib
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import random
import signal
import subprocess
import time
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from gtd_backup import Backup, Corruption, Skipped, TAG, UTC, atomic_json, inspect_database, iso, lock, now, retention_plan, timestamp

RESTIC = os.environ.get('GTD_TEST_RESTIC', '/tmp/gtd-backup-tools/restic')


def fixture(path, environment='production'):
    with sqlite3.connect(path) as db:
        db.executescript('''PRAGMA journal_mode=WAL; PRAGMA user_version=5;
            CREATE TABLE store_meta(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE tasks(id TEXT PRIMARY KEY, document TEXT);
            CREATE TABLE changes(id INTEGER PRIMARY KEY, document TEXT);
            CREATE TABLE requests(id TEXT PRIMARY KEY, document TEXT);
            CREATE TABLE revisions(id INTEGER PRIMARY KEY, document TEXT);''')
        db.executemany('INSERT INTO store_meta VALUES(?,?)', [('identity', 'fixture-identity'), ('environment', environment)])
        db.execute('INSERT INTO tasks VALUES(?,?)', ['task-1', json.dumps({'title': 'Fictional task', 'notes': 'notes\n' * 20000, 'agent_notes': 'private working context'})])


def snapshots(count, spacing=dt.timedelta(hours=1)):
    return [{'id': f'{i+1:064x}', 'time': iso(dt.datetime(2000, 1, 1, tzinfo=UTC) + i * spacing), 'tags': [TAG, 'hourly']} for i in range(count)]


class RetentionTests(unittest.TestCase):
    def test_legacy_capture_is_pinned_and_source_readonly(self):
        with tempfile.TemporaryDirectory() as root:
            image = 'sha256:' + 'a' * 64
            pin = {'application_image': image, 'database_identity': '63114ca1-a523-45ac-9cde-1433e179ea29'}
            backup = Backup({'home': root, 'legacy_sqlite_snapshot': pin})
            with patch.object(backup, 'run') as run:
                backup.capture_legacy_sqlite(Path(root), image)
                args = run.call_args.args[0]
                self.assertIn('type=volume,source=todo-mcp_todo_data,target=/data,readonly', args)
                self.assertEqual(args[args.index('--network') + 1], 'none')
                self.assertIn('--pull', args)
                self.assertEqual(run.call_args.kwargs['timeout'], 90)
            for bad_pin, candidate in [(pin, 'sha256:' + 'b' * 64),
                                       ({**pin, 'database_identity': 'wrong'}, image),
                                       ({**pin, 'extra': 'unsupported'}, image)]:
                backup.c['legacy_sqlite_snapshot'] = bad_pin
                with patch.object(backup, 'run') as run:
                    with self.assertRaises(RuntimeError):
                        backup.capture_legacy_sqlite(Path(root), candidate)
                    run.assert_not_called()

    def test_counts_not_age(self):
        for n in range(1, 100):
            rows = snapshots(n, dt.timedelta(days=35))
            plan = retention_plan(rows, rows[-1]['id'])
            self.assertLessEqual(plan['ordinary_count'], 21)
            self.assertGreaterEqual(len(plan['keep']), min(n, 4))
            self.assertTrue({r['id'] for r in rows[-4:]} <= set(plan['keep']))
            self.assertEqual(set(plan['keep']) | set(plan['remove']), {r['id'] for r in rows})

    def test_predeployment_protected(self):
        rows = snapshots(1000, dt.timedelta(days=1))
        for index in [0, 2, 4]:
            rows[index]['tags'].append('pre-deployment')
        plan = retention_plan(rows, rows[-1]['id'])
        self.assertTrue({rows[i]['id'] for i in [2, 4]} <= set(plan['keep']))
        self.assertIn(rows[0]['id'], plan['remove'])
        self.assertLessEqual(len(plan['keep']), 23)

    def test_randomized_bucket_boundaries(self):
        rng = random.Random(1820)
        for _ in range(300):
            rows = snapshots(rng.randint(1, 200), dt.timedelta(minutes=rng.randint(1, 90000)))
            rng.shuffle(rows)
            verified = max(rows, key=lambda s: timestamp(s['time']))['id']
            plan = retention_plan(rows, verified)
            self.assertIn(verified, plan['keep'])
            self.assertLessEqual(plan['ordinary_count'], 21)

    def test_fail_closed(self):
        for rows, verified in [([], 'missing'), (snapshots(1), 'missing'), ([dict(snapshots(1)[0], tags=[])], snapshots(1)[0]['id'])]:
            with self.assertRaises(RuntimeError):
                retention_plan(rows, verified)

    def test_overlap_lock_skips(self):
        with tempfile.TemporaryDirectory() as root:
            with lock(Path(root) / 'lock'):
                with self.assertRaises(Skipped), lock(Path(root) / 'lock'):
                    self.fail('lock allowed overlap')

    def test_database_validation(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'db'; fixture(path, 'demo')
            with self.assertRaises(Corruption): inspect_database(path)
            path.write_bytes(b'not a database')
            with self.assertRaises(Corruption): inspect_database(path)

    def test_no_cleanup_of_stale_capture(self):
        with tempfile.TemporaryDirectory() as root:
            backup = Backup({'home': root, 'role': 'laptop', 'repository': str(Path(root) / 'repo')})
            with patch.object(backup, 'restic') as restic:
                backup.maintain(snapshots(10), snapshots(10)[-1], {'captured_at': iso(now() - dt.timedelta(days=2))})
                restic.assert_not_called()

    def test_failures_never_reach_cleanup(self):
        for error in [RuntimeError('network unavailable'), RuntimeError('Keychain locked'), OSError('No space left on device'), TimeoutError('interrupted copy')]:
            with tempfile.TemporaryDirectory() as root:
                backup = Backup({'home': root, 'role': 'laptop', 'repository': str(Path(root) / 'repo')})
                with patch.object(backup, 'restic', side_effect=error), patch.object(backup, 'maintain') as maintain, patch.object(backup, 'notify'):
                    with self.assertRaises(type(error)): backup.backup_now()
                    maintain.assert_not_called()

    def test_deployment_and_disposable_environment_skip(self):
        with tempfile.TemporaryDirectory() as root:
            guard = Path(root) / 'guard'; guard.mkdir()
            backup = Backup({'home': root, 'role': 'server', 'maintenance_state': str(guard)})
            for mode in ['test', 'demo', 'maintenance', 'restoring']:
                atomic_json(guard / 'runtime-state.json', {'mode': mode})
                with self.assertRaises(Skipped), patch.object(backup, 'run') as run:
                    backup.production_image()
                run.assert_not_called()
            atomic_json(guard / 'runtime-state.json', {'mode': 'production'})
            atomic_json(guard / 'promotion.json', {'phase': 'prepared'})
            with self.assertRaises(Skipped): backup.production_image()

    def test_predeployment_identity_must_match_guard(self):
        with tempfile.TemporaryDirectory() as root:
            guard = Path(root) / 'guard'; guard.mkdir()
            backup = Backup({'home': root, 'role': 'server', 'maintenance_state': str(guard)})
            atomic_json(guard / 'runtime-state.json', {'mode': 'maintenance'})
            atomic_json(guard / 'promotion.json', {'backup': root, 'old_image': 'sha256:old'})
            backup.validate_predeployment(str(Path(root)/'before.sqlite3'), 'sha256:old')
            with self.assertRaises(RuntimeError): backup.validate_predeployment(str(Path(root)/'candidate.sqlite3'), 'sha256:old')
            with self.assertRaises(RuntimeError): backup.validate_predeployment(str(Path(root)/'before.sqlite3'), 'sha256:new')

    def test_existing_verification_survives_an_outage(self):
        with tempfile.TemporaryDirectory() as root:
            status = {'verified_id': 'previous', 'verified_capture_at': iso(now()-dt.timedelta(days=400)), 'verification':'ok'}
            atomic_json(Path(root)/'status.json', status)
            backup = Backup({'home':root, 'repository':str(Path(root)/'repo'), 'role':'laptop'})
            with patch.object(backup, 'restic', side_effect=RuntimeError('offline')), patch.object(backup, 'notify'):
                with self.assertRaises(RuntimeError): backup.backup_now()
            current = json.loads((Path(root)/'status.json').read_text())
            self.assertEqual(current['verified_id'], 'previous')
            self.assertEqual(current['verified_capture_at'], status['verified_capture_at'])

    def test_stale_notifications_once_daily(self):
        with tempfile.TemporaryDirectory() as root:
            backup = Backup({'home': root, 'role': 'laptop'})
            with patch.object(backup, 'run') as run:
                backup.notify(); backup.notify()
                self.assertEqual(run.call_count, 1)
                backup.notify(corruption=True)
                self.assertEqual(run.call_count, 2)


@unittest.skipUnless(Path(RESTIC).exists(), 'Set GTD_TEST_RESTIC to the pinned binary')
class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gtd-backup-test-')
        self.root = Path(self.temp.name)
        self.source = self.make_repo('source')
        self.dest = self.make_repo('dest', self.source)
        fixture(self.root / 'live.sqlite3')

    def tearDown(self):
        self.temp.cleanup()

    def make_repo(self, name, source=None):
        home = self.root / name; home.mkdir()
        password = home / 'password'; password.write_text('only-a-disposable-test-password-' + name)
        config = {'home': str(home), 'repository': str(home / 'repository'), 'role': 'laptop', 'restic': RESTIC, 'password': {'file': str(password)}}
        if source:
            config.update(source_repository=source.c['repository'], source_password=source.c['password'])
        repo = Backup(config)
        repo.restic('init', *(['--copy-chunker-params'] if source else []), source=bool(source))
        return repo

    def capture(self, when=None, tag='hourly'):
        stage = self.source.home / 'payload'; stage.mkdir(exist_ok=True)
        database = stage / 'todo.sqlite3'; database.unlink(missing_ok=True)
        with sqlite3.connect(self.root / 'live.sqlite3') as source, sqlite3.connect(database) as target:
            source.backup(target)
        manifest = dict(inspect_database(database), format=1, captured_at=iso(when), application_version='fixture', application_image='fixture', kind=tag)
        atomic_json(stage / 'manifest.json', manifest)
        self.source.restic('backup', '.', '--host', 'gtd-production', '--tag', TAG, '--tag', tag, '--time', timestamp(manifest['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'), cwd=stage)
        return max(self.source.snapshots(), key=lambda s: timestamp(s['time']))

    def test_copy_restore_delete_independence_and_dedup(self):
        first = self.capture()
        with patch.object(self.dest, 'notify'):
            self.dest.backup_now()
        copied = self.dest.snapshots()
        self.assertEqual(len(copied), 1)
        self.assertEqual(copied[0].get('original'), first['id'])
        self.dest.verify_snapshot(copied[0])
        self.source.restic('forget', first['id'])
        self.source.restic('prune', '--max-unused', '0')
        self.assertEqual(len(self.dest.snapshots()), 1)
        self.dest.verify_snapshot(copied[0])

    def test_concurrent_writes_online_backup(self):
        done = threading.Event()
        def writer():
            with sqlite3.connect(self.root / 'live.sqlite3', timeout=30) as db:
                for index in range(50):
                    db.execute('INSERT INTO changes(document) VALUES(?)', [str(index)]); db.commit()
            done.set()
        thread = threading.Thread(target=writer); thread.start()
        snapshot = self.capture(); thread.join()
        self.assertTrue(done.is_set())
        self.source.verify_snapshot(snapshot)

    def test_actual_retention_and_predeployment(self):
        for i in range(8):
            self.capture(now() - dt.timedelta(hours=8-i), 'pre-deployment' if i in [0, 1] else 'hourly')
        newest = self.source.snapshots()[-1]
        newest = max(self.source.snapshots(), key=lambda s: timestamp(s['time']))
        manifest = self.source.verify_snapshot(newest)
        self.source.maintain(self.source.snapshots(), newest, manifest)
        remaining = self.source.snapshots()
        self.assertGreaterEqual(len(remaining), 4)
        self.assertEqual(sum('pre-deployment' in s['tags'] for s in remaining), 2)

    def test_corruption_blocks_cleanup(self):
        self.capture()
        self.dest.restic('copy', '--tag', TAG, source=True)
        before = {s['id'] for s in self.dest.snapshots()}
        pack = next(p for p in (Path(self.dest.c['repository']) / 'data').rglob('*') if p.is_file())
        pack.chmod(0o600); pack.write_bytes(b'corrupt')
        with self.assertRaises(Corruption): self.dest.check(full=True)
        self.assertEqual(before, {s['id'] for s in self.dest.snapshots()})

    def test_killed_copy_retries_without_committing_partial_snapshot(self):
        # Make data that cannot compress away; throttle the transfer so the
        # process can be killed while a real pack is being written.
        with sqlite3.connect(self.root / 'live.sqlite3') as db:
            db.execute('INSERT INTO tasks VALUES(?,?)', ['large-fixture', os.urandom(2 * 1024 * 1024).hex()])
        self.capture()
        args = [RESTIC, '-r', self.dest.c['repository'], '-p', self.dest.c['password']['file'],
                '--compression', 'auto', '--cache-dir', str(self.dest.home / 'cache'), '--limit-upload', '64', 'copy', '--from-repo', self.source.c['repository'],
                '--from-password-file', self.source.c['password']['file']]
        process = subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
        try:
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline and not list((Path(self.dest.c['repository']) / 'locks').iterdir()):
                time.sleep(.05)
            self.assertIsNone(process.poll(), process.stderr.read().decode() if process.poll() is not None else '')
            process.kill(); process.wait(timeout=10)
            self.dest.restic('unlock'); self.source.restic('unlock')
            self.assertFalse(self.dest.snapshots())
            self.dest.restic('copy', '--tag', TAG, source=True)
            self.dest.verify_snapshot(self.dest.snapshots()[0])
            self.dest.check(full=True)
        finally:
            if process.poll() is None: process.kill(); process.wait()
            process.stderr.close()

    def test_interrupted_transfer_retry(self):
        self.capture()
        # A partial unreferenced pack may be left by an interrupted process.
        partial = Path(self.dest.c['repository']) / 'data' / '00' / ('0' * 64)
        partial.parent.mkdir(exist_ok=True); partial.write_bytes(b'partial transfer')
        self.dest.restic('copy', '--tag', TAG, source=True)
        newest = self.dest.snapshots()[0]
        self.dest.verify_snapshot(newest)
        # Unreferenced partial packs are safe to reclaim only after a verified
        # transfer. They must never be mistaken for a committed recovery point.
        self.dest.check(full=True)
        self.dest.restic('prune', '--max-unused', '0')
        self.dest.verify_snapshot(newest)


if __name__ == '__main__':
    unittest.main(verbosity=2)
