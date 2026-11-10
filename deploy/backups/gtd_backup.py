#!/usr/bin/env python3
"""Essential-data backups. No production restore or automatic repository initialization.

All managed operations take the same local lock. Restic also retains its own
cross-machine locks: notably, copy holds a source read lock against prune.
"""
import argparse
import contextlib
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

from restic_release import VERSION
from backup_errors import Corruption, Skipped, VerificationFailure

UTC = dt.timezone.utc
TAG = 'gtd-user-data-v1'
DAY = 86400


def now():
    return dt.datetime.now(UTC)


def iso(value=None):
    return (value or now()).isoformat()


def timestamp(value):
    return dt.datetime.fromisoformat(value.replace('Z', '+00:00'))


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary = path.with_suffix('.new')
    with temporary.open('w') as stream:
        os.chmod(temporary, 0o600)
        json.dump(value, stream, indent=2); stream.write('\n')
        stream.flush(); os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def lock(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with path.open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Skipped('Another backup or deployment is running') from None
        yield


def command(args, *, cwd=None, timeout=300, env=None):
    """Bound process trees, not just their parent (Restic starts SSH children)."""
    with subprocess.Popen([str(x) for x in args], cwd=cwd, env=env, text=True,
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as proc:
        try:
            out, err = proc.communicate(timeout=timeout)
        except BaseException:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL); proc.communicate()
            raise
        if proc.returncode:
            # Arguments contain paths/Keychain item names, never passwords.
            raise RuntimeError(f'{Path(str(args[0])).name} exited {proc.returncode}: {(err or out)[-3000:].strip()}')
        return out


def sha256(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def inspect_database(path, *, legacy=False):
    path = Path(path)
    if not path.is_file() or path.is_symlink():
        raise Corruption('Snapshot database is missing or not a regular file')
    wal = Path(str(path) + '-wal')
    if wal.exists() and wal.stat().st_size:
        raise Corruption('Snapshot has an unmerged WAL; preserve it for manual review')
    try:
        with sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True) as db:
            if db.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                raise Corruption('SQLite integrity check failed')
            if db.execute('PRAGMA foreign_key_check').fetchone():
                raise Corruption('SQLite foreign-key check failed')
            schema = db.execute('PRAGMA user_version').fetchone()[0]
            meta = dict(db.execute('SELECT key,value FROM store_meta'))
            if meta.get('environment') != 'production' and not (legacy and 'environment' not in meta):
                raise Corruption('Refusing a non-production database')
            tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            required = {'tasks', 'changes', 'requests', 'revisions', 'store_meta'}
            if not required.issubset(tables) or not meta.get('identity') or schema < 1:
                raise Corruption('Incomplete GTD snapshot')
            counts = {table: db.execute(f'SELECT count(*) FROM {table}').fetchone()[0] for table in sorted(required)}
            return {'schema': schema, 'database_identity': meta['identity'], 'environment': meta.get('environment', 'legacy-unconfirmed'),
                    'sha256': sha256(path), 'database_bytes': path.stat().st_size, 'record_counts': counts}
    except sqlite3.DatabaseError as exc:
        raise Corruption('SQLite snapshot is unreadable') from exc


def retention_plan(snapshots, verified_id, *, timezone='America/New_York'):
    """Count occupied calendar buckets; no wall-clock expiration, even after years offline."""
    if not snapshots or verified_id not in {x['id'] for x in snapshots}:
        raise RuntimeError('Cleanup requires a verified snapshot in this repository')
    ids = {s['id'] for s in snapshots}
    if len(ids) != len(snapshots) or any(not re.fullmatch('[0-9a-f]{64}', x) for x in ids):
        raise RuntimeError('Invalid snapshot inventory')
    if any(TAG not in s.get('tags', []) for s in snapshots):
        raise RuntimeError('Unmanaged snapshots present; cleanup requires review')
    ordered = sorted(snapshots, key=lambda s: (timestamp(s['time']), s['id']), reverse=True)
    keep = {s['id'] for s in ordered[:4]}
    ordinary = set(keep)
    local = ZoneInfo(timezone)
    for maximum, bucket in [(7, lambda t: t.date()), (4, lambda t: t.isocalendar()[:2]), (6, lambda t: (t.year, t.month))]:
        seen = set()
        for snapshot in ordered:
            key = bucket(timestamp(snapshot['time']).astimezone(local))
            if key not in seen:
                if len(seen) == maximum:
                    break
                seen.add(key); ordinary.add(snapshot['id'])
    predeploy = {s['id'] for s in [s for s in ordered if 'pre-deployment' in s.get('tags', [])][:2]}
    keep = ordinary | predeploy | {verified_id}
    remove = ids - keep
    if not keep or len(keep) < min(4, len(ids)) or keep & remove or not predeploy.issubset(keep):
        raise RuntimeError('Retention safety invariant failed')
    return {'keep': sorted(keep), 'remove': sorted(remove), 'protected_predeployment': sorted(predeploy),
            'verified': verified_id, 'ordinary_count': len(ordinary)}


class Backup:
    def __init__(self, config):
        self.c = config
        self.home = Path(config['home'])
        self.home.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.state_file = self.home / 'status.json'
        self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
        self.deadline = time.monotonic() + config.get('timeout_seconds', 1200)

    def save(self):
        atomic_json(self.state_file, self.state)

    def run(self, args, **kwargs):
        remaining = self.deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError('Backup job exceeded its time budget')
        kwargs['timeout'] = min(kwargs.get('timeout', 300), remaining)
        return command(args, **kwargs)

    def password_args(self, source=False):
        value = self.c['source_password' if source else 'password']
        prefix = '--from-password-' if source else '--password-'
        if 'file' in value:
            return [prefix + 'file', value['file']]
        return [prefix + 'command', value['command']]

    def restic(self, *args, source=False, cwd=None, json_result=False):
        env = {k: v for k, v in os.environ.items() if not k.startswith('RESTIC_')}
        env.update(GOMAXPROCS='2', GOMEMLIMIT='256MiB', TZ='UTC')
        base = [self.c['restic'], '--repo', self.c['repository'], '--compression', 'auto',
                '--cache-dir', str(self.home / 'cache'), '--retry-lock', '30s'] + self.password_args()
        if self.c.get('sftp_command'):
            base += ['-o', 'sftp.command=' + self.c['sftp_command']]
        if json_result:
            base += ['--json']
        extra = ['--from-repo', self.c['source_repository']] + self.password_args(True) if source else []
        try:
            out = self.run(base + list(args) + extra, cwd=cwd, env=env, timeout=1200)
        except RuntimeError as exc:
            if any(marker in str(exc).lower() for marker in ('ciphertext verification failed', 'invalid data returned', 'hash does not match', 'data corruption')):
                raise Corruption(str(exc)) from exc
            raise
        return json.loads(out) if json_result else out

    def snapshots(self):
        return self.restic('snapshots', json_result=True) or []

    def verify_snapshot(self, snapshot, destination=None):
        with tempfile.TemporaryDirectory(prefix='restore-', dir=self.home) as temporary:
            target = Path(destination) if destination else Path(temporary) / 'restored'
            if target.exists():
                raise RuntimeError('Restore destination must not exist')
            try:
                self.restic('restore', snapshot['id'], '--target', str(target), '--verify')
            except Corruption:
                raise
            except RuntimeError:
                raise VerificationFailure('Restic restore could not complete; archive or environment failure needs private inspection. Recovery points were preserved') from None
            manifests = list(target.rglob('manifest.json'))
            files = [p for p in target.rglob('*') if not p.is_dir()]
            if len(manifests) != 1 or any(p.is_symlink() for p in target.rglob('*')):
                raise Corruption('Unexpected backup contents: ' + ', '.join(p.name for p in files[:10]))
            manifest = json.loads(manifests[0].read_text())
            if manifest.get('format') == 2:
                from postgres_bundle import verify
                if len(files) != 4:
                    raise Corruption('Unexpected PostgreSQL recovery files')
                manifest = verify(manifests[0].parent, self.deadline, limits=self.c.get('postgres_verification'))
            else:
                databases = list(target.rglob('todo.sqlite3'))
                if len(databases) != 1 or len(files) != 2:
                    raise Corruption('Unexpected SQLite recovery files')
                actual = inspect_database(databases[0])
                if manifest.get('format') != 1 or any(manifest.get(key) != value for key, value in actual.items()):
                    raise Corruption('Restored snapshot does not match its manifest')
            if abs((timestamp(snapshot['time']) - timestamp(manifest['captured_at'])).total_seconds()) > 1:
                raise Corruption('Capture time does not match recovery point')
            return manifest

    def capture_postgres(self, predeployment=False):
        from postgres_bundle import capture, verify
        config = dict(self.c['postgres'])
        guard = Path(self.c['maintenance_state'])
        state = json.loads((guard / 'runtime-state.json').read_text())
        promotion = guard / 'promotion.json'
        if config['environment'] != 'production':
            raise Skipped('Managed production backup refuses a staging source')
        if predeployment:
            marker = json.loads(promotion.read_text())
            if (state.get('mode') != 'maintenance' or marker.get('operation') != 'multi-user-deploy'
                    or marker.get('phase') != 'writers-stopped'
                    or marker.get('database_identity') != config['database_identity']
                    or marker.get('old_image') != config['application_image']):
                raise RuntimeError('PostgreSQL pre-deployment capture does not match maintenance')
        elif state.get('mode') != 'production' or promotion.exists():
            raise Skipped('Production backup skipped during maintenance')
        else:
            # A configuration file alone is not proof of the running release.
            # Pre-deployment writers are stopped and pinned by its marker.
            for service, image in [('service_container','application_image'), ('provider_container','identity_image')]:
                container = json.loads(self.run(['docker','inspect',config[service]]))[0]
                if not container['State']['Running'] or container['Image'] != config[image]:
                    raise Skipped('The running multi-user release differs from the backup configuration')
        config['kind'] = 'pre-deployment' if predeployment else 'hourly'
        with tempfile.TemporaryDirectory(prefix='pg-capture-', dir=self.home) as temporary:
            stage = Path(temporary) / 'payload'
            manifest = capture(config, stage, self.deadline)
            verify(stage, self.deadline, limits=self.c.get('postgres_verification'))
            result = self.restic('backup', '.', '--host', 'gtd-production', '--tag', TAG, '--tag', manifest['kind'],
                                 '--time', timestamp(manifest['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'), cwd=stage)
            self.state['backup_output'] = result[-1800:]

    def production_image(self):
        guard = Path(self.c['maintenance_state'])
        mode = json.loads((guard / 'runtime-state.json').read_text()).get('mode')
        if mode != 'production' or (guard / 'promotion.json').exists():
            raise Skipped('Production backup skipped during maintenance or test/demo mode')
        images = []
        for name in ('todo', 'web', 'worker'):
            container = json.loads(self.run(['docker', 'inspect', f'todo-mcp-{name}-1']))[0]
            if not container['State']['Running']:
                raise Skipped('A production writer is not running')
            if not any(m.get('Name') == 'todo-mcp_todo_data' and m['Destination'] == '/data' for m in container['Mounts']):
                raise RuntimeError('Unexpected production data mount')
            env = container['Config'].get('Env', [])
            if any(e.startswith('TODO_ENVIRONMENT=') and e != 'TODO_ENVIRONMENT=production' for e in env):
                raise RuntimeError('Refusing test/demo environment')
            images.append(container['Image'])
        if len(set(images)) != 1 or not re.fullmatch('sha256:[0-9a-f]{64}', images[0]):
            raise RuntimeError('Production image mismatch')
        return images[0]

    def validate_predeployment(self, database, image):
        guard = Path(self.c['maintenance_state'])
        state = json.loads((guard / 'runtime-state.json').read_text())
        promotion = json.loads((guard / 'promotion.json').read_text())
        expected = Path(promotion['backup']) / 'before.sqlite3'
        if (state.get('mode') != 'maintenance' or Path(database).resolve() != expected.resolve()
                or image != promotion.get('old_image')):
            raise RuntimeError('Pre-deployment snapshot does not match the active maintenance operation')

    def capture(self, existing=None, image=None):
        stage = self.home / 'staging'
        if stage.exists():
            shutil.rmtree(stage)
        stage.mkdir(mode=0o700)
        try:
            if existing:
                # Used by promotion while it already owns the deployment lock.
                shutil.copyfile(existing, stage / 'todo.sqlite3')
            else:
                try:
                    self.run(['docker', 'rm', '-f', 'gtd-user-data-backup'], timeout=15)
                except RuntimeError:
                    pass
                if self.c.get('legacy_sqlite_snapshot'):
                    self.capture_legacy_sqlite(stage, image)
                else:
                    self.run(['docker', 'run', '--rm', '--name', 'gtd-user-data-backup', '--network', 'none', '--read-only',
                              '--mount', 'type=volume,source=todo-mcp_todo_data,target=/data',
                              '--mount', f'type=bind,source={stage},target=/backup', image,
                              'todo-mcp', '--backup', '/backup/todo.sqlite3'], timeout=300)
            details = inspect_database(stage / 'todo.sqlite3')
            if not existing and (pin := self.c.get('legacy_sqlite_snapshot')):
                if details['database_identity'] != pin['database_identity'] or details['schema'] != 11:
                    raise RuntimeError('Legacy SQLite snapshot identity or schema changed')
            version = self.run(['docker', 'run', '--rm', '--network', 'none', '--read-only', image, 'todo-mcp', '--version']).strip()
            manifest = dict(details, format=1, captured_at=iso(), application_version=version, application_image=image,
                            kind='pre-deployment' if existing else 'hourly')
            atomic_json(stage / 'manifest.json', manifest)
            if {p.name for p in stage.iterdir()} != {'todo.sqlite3', 'manifest.json'}:
                raise RuntimeError('Unexpected staging files; refusing backup commitment')
            result = self.restic('backup', '.', '--host', 'gtd-production', '--tag', TAG, '--tag', manifest['kind'],
                                 '--time', timestamp(manifest['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'), cwd=stage)
            self.state['backup_output'] = result[-1800:]
        finally:
            if not existing:
                try:
                    command(['docker', 'rm', '-f', 'gtd-user-data-backup'], timeout=15)
                except RuntimeError:
                    pass
            shutil.rmtree(stage, ignore_errors=True)

    def capture_legacy_sqlite(self, stage, image):
        # Temporary compatibility for the retained v0.18.0 binary, whose online
        # backup can starve under concurrent writes. Pin the exact reviewed image
        # and database; an upgrade requires explicit removal/review of this pin.
        pin = self.c['legacy_sqlite_snapshot']
        if (not isinstance(pin, dict) or set(pin) != {'application_image', 'database_identity'}
                or pin['application_image'] != image
                or not re.fullmatch(r'sha256:[0-9a-f]{64}', image or '')
                or not re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', pin.get('database_identity', ''))):
            raise RuntimeError('Legacy SQLite capture requires the reviewed image and database identity')
        script = Path(__file__).with_name('sqlite_snapshot.mjs').read_text()
        self.run(['docker', 'run', '--rm', '--pull', 'never', '--name', 'gtd-user-data-backup',
                  '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                  '--memory', '256m', '--cpus', '1', '--pids-limit', '64',
                  '--user', str(os.getuid()) + ':' + str(os.getgid()),
                  '--mount', 'type=volume,source=todo-mcp_todo_data,target=/data,readonly',
                  '--mount', f'type=bind,source={stage},target=/backup',
                  '--entrypoint', 'node', image, '--input-type=module', '-e', script,
                  pin['database_identity']], timeout=90)

    def check(self, full=False):
        try:
            self.restic('check', *(['--read-data'] if full else []))
        except RuntimeError as exc:
            # Treat a check failure conservatively; never clean up afterward.
            raise Corruption(str(exc)) from exc

    def maintain(self, snapshots, newest, manifest):
        # A stale source, old import, or failed transfer may not authorize cleanup.
        age = (now() - timestamp(manifest['captured_at'])).total_seconds()
        if age > DAY or age < -300:
            return
        full_due = any((now() - timestamp(self.state.get(key, '1970-01-01T00:00:00+00:00'))).total_seconds() >= 7 * DAY
                       for key in ('full_check_at', 'pruned_at'))
        self.check(full=full_due)
        if full_due:
            self.state['full_check_at'] = iso(); self.save()
        month = now().strftime('%Y-%m')
        if self.state.get('older_restore_month') != month and len(snapshots) > 1:
            older = min(snapshots, key=lambda x: timestamp(x['time']))
            self.verify_snapshot(older)
            self.state.update(older_restore_month=month, older_restored_id=older['id']); self.save()
        plan = retention_plan(snapshots, newest['id'])
        atomic_json(self.home / 'retention-plan.json', dict(plan, planned_at=iso()))
        # Re-read inventory before mutation. Restic supplies the actual repository lock.
        if {s['id'] for s in self.snapshots()} != {s['id'] for s in snapshots}:
            raise Skipped('Repository changed during cleanup planning')
        if plan['remove']:
            self.restic('forget', *plan['remove'])
        retained = {s['id'] for s in self.snapshots()}
        if not set(plan['keep']).issubset(retained):
            raise Corruption('A protected recovery point is missing')
        if full_due:
            self.restic('prune', '--max-unused', '0')
            self.check()
            self.state['pruned_at'] = iso()

    def notify(self, corruption=False):
        if self.c['role'] != 'laptop':
            return
        last = self.state.get('verified_capture_at')
        stale = not last or (now() - timestamp(last)).total_seconds() >= DAY
        last_notice = self.state.get('stale_notified_at')
        if not corruption and (not stale or (last_notice and (now() - timestamp(last_notice)).total_seconds() < DAY)):
            return
        message = ('Backup verification failed. Existing recovery points have been preserved.' if corruption else
                   'No fresh verified laptop backup in 24 hours. Check GTD backup status.')
        try:
            self.run(['/usr/bin/osascript', '-e', f'display notification {json.dumps(message)} with title "GTD Backups"'], timeout=10)
            if not corruption:
                self.state['stale_notified_at'] = iso()
        except Exception:
            self.state['notification_error'] = 'Notification could not be delivered; check macOS notification settings.'

    def backup_now(self, existing=None, image=None, postgres_predeployment=False):
        with lock(self.home / 'job.lock'):
            self.state = json.loads(self.state_file.read_text()) if self.state_file.exists() else {}
            started = time.monotonic()
            self.state['attempted_at'] = iso(); self.save()
            try:
                self.restic('unlock')  # Only stale locks; never --remove-all.
                if self.c['role'] == 'server':
                    if self.c.get('postgres'):
                        if existing:
                            raise RuntimeError('SQLite pre-deployment arguments do not apply to PostgreSQL')
                        if postgres_predeployment:
                            # Deployment owns operation.lock, like the existing
                            # SQLite pre-deployment path. Validate its marker.
                            self.capture_postgres(predeployment=True)
                        else:
                            with lock(Path(self.c['maintenance_state']) / 'operation.lock'):
                                self.capture_postgres()
                    elif postgres_predeployment:
                        raise RuntimeError('PostgreSQL backup is not configured')
                    elif existing:
                        self.validate_predeployment(existing, image)
                        self.capture(existing, image)
                    else:
                        with lock(Path(self.c['maintenance_state']) / 'operation.lock'):
                            self.capture(image=self.production_image())
                else:
                    source = Backup(dict(self.c, repository=self.c['source_repository'], password=self.c['source_password']))
                    source.restic('unlock')
                    self.restic('copy', '--tag', TAG, source=True)
                    self.state['copied_at'] = iso()
                snapshots = self.snapshots()
                if not snapshots:
                    raise RuntimeError('No recovery points available')
                newest = max(snapshots, key=lambda x: timestamp(x['time']))
                verified = self.state.setdefault('verified_snapshots', {})
                manifest = None
                for snapshot in sorted(snapshots, key=lambda x: timestamp(x['time'])):
                    if snapshot['id'] not in verified or snapshot['id'] == newest['id']:
                        result = self.verify_snapshot(snapshot)
                        verified[snapshot['id']] = {'sha256': result['sha256'], 'captured_at': result['captured_at']}
                        if snapshot['id'] == newest['id']:
                            manifest = result
                assert manifest is not None
                self.state.update(verified_id=newest['id'], verified_at=iso(), verified_capture_at=manifest['captured_at'],
                                  database_bytes=manifest['database_bytes'], error=None, verification='ok')
                self.save()
                self.maintain(snapshots, newest, manifest)
                retained = {s['id'] for s in self.snapshots()}
                self.state['verified_snapshots'] = {k:v for k,v in verified.items() if k in retained}
                self.state['successful_at'] = iso()
                self.state.pop('last_skip', None)
            except Skipped as exc:
                self.state['last_skip'] = str(exc)
                if existing or postgres_predeployment:
                    raise RuntimeError('Pre-deployment backup was not verified: ' + str(exc)) from exc
            except Exception as exc:
                self.state['error'] = str(exc)
                if isinstance(exc, VerificationFailure):
                    self.state['verification'] = 'failed'; self.notify(corruption=True)
                raise
            finally:
                self.state['duration_seconds'] = round(time.monotonic() - started, 3)
                self.state['repository_bytes'] = repository_size(self.c['repository'])
                self.notify(); self.save()


def repository_size(path):
    if ':' in str(path):
        return None
    total = 0
    for item in Path(path).rglob('*'):
        try:
            if item.is_file():
                total += item.stat().st_size
        except FileNotFoundError:
            pass  # A concurrent prune may remove an unreferenced pack.
    return total


def main():
    os.umask(0o077)
    def interrupted(_signum, _frame):
        raise TimeoutError('Backup interrupted; previous recovery points are preserved')
    signal.signal(signal.SIGTERM, interrupted)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', required=True)
    subs = parser.add_subparsers(dest='action', required=True)
    for name in ['now', 'status', 'list', 'check']:
        subs.add_parser(name)
    restore = subs.add_parser('restore'); restore.add_argument('snapshot'); restore.add_argument('destination')
    pre = subs.add_parser('pre-deployment'); pre.add_argument('database'); pre.add_argument('image')
    subs.add_parser('pre-deployment-postgres')
    inventory = subs.add_parser('inventory'); inventory.add_argument('directory')
    args = parser.parse_args()
    backup = Backup(json.loads(Path(args.config).read_text()))
    if args.action == 'status':
        state = dict(backup.state)
        state['repository_bytes'] = repository_size(backup.c['repository'])
        state['fresh'] = bool(state.get('verified_capture_at') and (now() - timestamp(state['verified_capture_at'])).total_seconds() < DAY)
        print(json.dumps(state, indent=2)); return
    if args.action == 'inventory':
        result = []
        paths = []
        for directory, _, names in os.walk(args.directory, onerror=lambda exc: result.append({'path': exc.filename, 'error': str(exc)})):
            paths += [Path(directory) / name for name in names if name.endswith('.sqlite3')]
        for path in sorted(paths):
            try:
                result.append(dict(path=str(path), **inspect_database(path, legacy=True)))
            except Exception as exc:
                result.append({'path': str(path), 'error': str(exc)})
        print(json.dumps(result, indent=2)); return
    if not backup.run([backup.c['restic'], 'version']).startswith(f'restic {VERSION} '):
        raise RuntimeError('Restic version does not match pinned release')
    try:
        os.nice(10)
        if args.action in ('now', 'pre-deployment', 'pre-deployment-postgres'):
            if args.action == 'pre-deployment-postgres':
                if backup.c['role'] != 'server':
                    raise RuntimeError('Pre-deployment capture is server-only')
                backup.backup_now(postgres_predeployment=True)
            elif args.action == 'pre-deployment':
                if backup.c['role'] != 'server':
                    raise RuntimeError('Pre-deployment capture is server-only')
                backup.backup_now(args.database, args.image)
            else:
                backup.backup_now()
        else:
            with lock(backup.home / 'job.lock'):
                if args.action == 'list':
                    print(json.dumps(backup.snapshots(), indent=2))
                elif args.action == 'check':
                    backup.check(full=True)
                else:
                    matches = [s for s in backup.snapshots() if s['id'].startswith(args.snapshot)]
                    if len(matches) != 1:
                        raise RuntimeError('Choose one unambiguous snapshot ID from list')
                    print(json.dumps(backup.verify_snapshot(matches[0], args.destination), indent=2))
    except Skipped as exc:
        if args.action in ('pre-deployment', 'pre-deployment-postgres'):
            raise RuntimeError('Pre-deployment backup is busy; retry promotion after it finishes') from exc
        print(str(exc))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
