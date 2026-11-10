"""Coordinated PostgreSQL payloads for the existing encrypted Restic workflow.

Operator-only: no HTTP entry point, credentials in arguments, or source writes.
Verification restores only into a new, networkless, disposable container. SQL
errors can contain record content, so subprocess diagnostics are never surfaced.
"""
import base64
import contextlib
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import uuid

from backup_errors import Corruption, Skipped, VerificationFailure
from gtd_backup import atomic_json, iso, sha256, timestamp

POSTGRES_IMAGE = 'postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c'
PAYLOADS = {'application.dump', 'identity.dump', 'recovery.json'}
FORMAT = 2
MAX_CONTROL = 2 * 1024 * 1024


class QueryFailure(RuntimeError):
    def __init__(self, sqlstate=None):
        self.sqlstate = sqlstate
        super().__init__('PostgreSQL snapshot query failed'+(' (SQLSTATE '+sqlstate+')' if sqlstate else ''))


def verification_limits(value=None):
    """Operator ceilings, never derived from an untrusted backup manifest."""
    value = {} if value is None else value
    if not isinstance(value, dict) or set(value) - {'memory_mib', 'storage_mib'}:
        raise RuntimeError('Invalid PostgreSQL verification limits')
    storage, memory = value.get('storage_mib', 1024), value.get('memory_mib', 1536)
    if (type(storage) is not int or type(memory) is not int or
            not 128 <= storage <= 4096 or not storage + 256 <= memory <= 6144):
        raise RuntimeError('Verification requires 128–4096 MiB storage and at least 256 MiB additional memory, up to 6144 MiB')
    return {'storage_mib': storage, 'memory_mib': memory}


def docker_binary():
    # launchd intentionally starts with a small PATH. Do not launch or install
    # Docker automatically; report an unavailable engine through normal retry.
    for path in (shutil.which('docker'), '/usr/local/bin/docker', '/opt/homebrew/bin/docker'):
        if path and Path(path).is_file() and os.access(path, os.X_OK):
            return path
    raise RuntimeError('PostgreSQL backup verification requires the installed Docker engine')


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch('[a-z][a-z0-9_]{0,62}', value):
        raise RuntimeError('Invalid private database identifier')
    return value


def database_port(value):
    if type(value) is not int or not 1 <= value <= 65535:
        raise RuntimeError('Invalid private PostgreSQL port')
    return value


def bounded(command, deadline, *, stdin=None, stdout=None):
    if command[0] == 'docker':
        command = [docker_binary(), *command[1:]]
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('PostgreSQL backup time budget exceeded')
    with subprocess.Popen(command, stdin=stdin, stdout=stdout or subprocess.PIPE,
                          stderr=subprocess.DEVNULL, start_new_session=True) as process:
        try:
            out, _ = process.communicate(timeout=remaining)
        except BaseException:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()
            raise
        if process.returncode:
            raise RuntimeError('PostgreSQL backup command failed; private operator inspection is required')
        return out


class Session:
    """One psql session owns the advisory lock and exported read snapshot."""
    def __init__(self, container, database, deadline, *, port=5432):
        port = database_port(port)
        self.deadline = deadline
        self.diagnostic = tempfile.TemporaryFile()
        try:
            self.process = subprocess.Popen(
                [docker_binary(), 'exec', '-i', '--user', 'postgres', container, 'psql',
                 '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate',
                 '-U', 'postgres', '-p', str(port), '-d', identifier(database)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.diagnostic,
                start_new_session=True, bufsize=0)
        except BaseException:
            self.diagnostic.close()
            raise
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        try:
            milliseconds = max(1, int((deadline-time.monotonic())*1000))
            self.query(f"SET statement_timeout='{milliseconds}ms'; "
                       f"SET idle_in_transaction_session_timeout='{milliseconds}ms'; "
                       f"SET idle_session_timeout='{milliseconds}ms'; SELECT to_json(1);")
        except BaseException:
            self.close()
            raise

    def query(self, sql):
        # Every SELECT returns exactly one JSON line. SQL is operator-owned,
        # never supplied by a record, manifest, HTTP argument or model tool.
        try:
            self.process.stdin.write((sql + '\n').encode())
            result = b''
            while b'\n' not in result:
                remaining = self.deadline - time.monotonic()
                if remaining <= 0 or not self.selector.select(remaining):
                    raise TimeoutError('PostgreSQL snapshot session exceeded its time budget')
                chunk = os.read(self.process.stdout.fileno(), 65536)
                if not chunk:
                    self.diagnostic.seek(0)
                    code = re.search(rb'(?:ERROR|FATAL|PANIC):\s+([A-Z0-9]{5})\b',self.diagnostic.read(4096))
                    raise QueryFailure(code[1].decode('ascii') if code else None)
                result += chunk
                if len(result) > MAX_CONTROL:
                    raise RuntimeError('PostgreSQL snapshot metadata exceeded its size limit')
            return json.loads(result)
        except (OSError, ValueError):
            raise RuntimeError('PostgreSQL snapshot session failed') from None

    def snapshot(self):
        result = self.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; "
                            "SELECT json_build_object('snapshot',pg_export_snapshot(),'captured_at',clock_timestamp());")
        if not re.fullmatch('[0-9A-F]+-[0-9A-F]+-[0-9]+', result['snapshot']):
            raise RuntimeError('Invalid PostgreSQL exported snapshot')
        return result

    def close(self):
        self.selector.close()
        if self.process.stdin:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(self.process.pid, signal.SIGKILL)
            self.process.wait()
        self.process.stdout.close()
        self.diagnostic.close()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()


def counts(session, schema):
    identifier(schema)
    tables = session.query("SELECT coalesce(json_agg(tablename ORDER BY tablename),'[]') "
                           f"FROM pg_tables WHERE schemaname='{schema}';")
    if not tables or len(tables) > 300:
        raise Corruption('Unexpected PostgreSQL table inventory')
    # Identifier quoting accepts provider-owned names without interpreting SQL.
    def quote(value):
        return '"' + value.replace('"', '""') + '"'
    result = {}
    for table in tables:
        result[table] = session.query(f'SELECT to_json(count(*)) FROM {quote(schema)}.{quote(table)};')
    return result


def application_state(session):
    meta = session.query('SELECT row_to_json(m) FROM gtd.schema_meta m;')
    accounts = session.query("SELECT coalesce(json_agg(row_to_json(a) ORDER BY id),'[]') FROM "
                             '(SELECT id,issuer,subject,enabled,enrollment,credential_generation FROM gtd.accounts) a;')
    if meta.get('compatibility') not in (12,13) or meta.get('environment') not in ('staging', 'production'):
        raise Corruption('Unsupported application backup schema or environment')
    return {'meta': meta, 'accounts': accounts, 'counts': counts(session, 'gtd')}


def identity_state(session):
    # Snapshot mapping metadata only. Password hashes, tokens and signing keys
    # remain in the private dump and are never emitted in logs or receipts.
    mappings = session.query("SELECT coalesce(json_agg(json_build_object('subject',u.id,'realm',r.name,"
        "'enabled',u.enabled,'accounts',(SELECT coalesce(json_agg(a.value),'[]') FROM user_attribute a "
        "WHERE a.user_id=u.id AND a.name='gtd_account_id'), 'generations',"
        "(SELECT coalesce(json_agg(a.value),'[]') FROM user_attribute a WHERE a.user_id=u.id AND a.name='gtd_generation')) ORDER BY u.id),'[]') "
        'FROM user_entity u JOIN realm r ON r.id=u.realm_id;')
    return {'mappings': mappings, 'counts': counts(session, 'public')}


def validate_mapping(app, identity, issuer, realm):
    by_subject = {row['subject']: row for row in identity['mappings'] if row['realm'] == realm}
    for account in app['accounts']:
        if account['issuer'] != issuer:
            raise Corruption('Application account issuer does not match the identity backup')
        provider = by_subject.get(account['subject'])
        if provider is None or provider['accounts'] != [account['id']]:
            raise Corruption('Application and provider account bindings do not match')
        if account['enabled'] and not provider['enabled']:
            raise Corruption('An enabled account is unavailable in the identity backup')
        if account['enabled'] and account['credential_generation'] and provider['generations'] != [account['credential_generation']]:
            raise Corruption('Enabled account credential generations do not match')


def recovery_material(files):
    if not isinstance(files, dict) or not files or len(files) > 32:
        raise RuntimeError('An explicit essential recovery-file allowlist is required')
    result = {}
    for label, name in files.items():
        identifier(label)
        path = Path(name)
        if not path.is_absolute():
            raise RuntimeError('Recovery files must use private absolute paths')
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, 'rb') as stream:
            meta = os.fstat(stream.fileno())
            if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o077 or meta.st_size > 65536:
                raise RuntimeError('Recovery files must be private regular files no larger than 64 KiB')
            value = stream.read(65537)
        if len(value) > 65536:
            raise RuntimeError('Recovery file changed while reading')
        result[label] = base64.b64encode(value).decode('ascii')
    return {'format': 1, 'files': result}


def capture(config, destination, deadline):
    """Return an uncommitted payload. Call verify before adding it to Restic."""
    ports = {side: database_port(config.get(side+'_port', 5432)) for side in ('application', 'identity')}
    target = Path(destination)
    if target.exists():
        raise RuntimeError('PostgreSQL capture destination must not exist')
    target.mkdir(mode=0o700)
    for name in ('application_container', 'identity_container'):
        if not re.fullmatch('[A-Za-z0-9][A-Za-z0-9_.-]{0,127}', config[name]):
            raise RuntimeError('Invalid private PostgreSQL container')
        inspected = json.loads(bounded(['docker', 'inspect', '--format', '{{json .}}', config[name]], deadline))
        if not inspected['State']['Running'] or inspected['Config']['Image'] != POSTGRES_IMAGE:
            raise RuntimeError('PostgreSQL source must run the pinned release')
    if config['environment'] not in ('production', 'staging'):
        raise RuntimeError('Invalid PostgreSQL backup environment')
    if not isinstance(config['realm'], str) or not re.fullmatch('[A-Za-z0-9][A-Za-z0-9._-]{0,254}', config['realm']):
        raise RuntimeError('Invalid private identity realm')
    with Session(config['application_container'], config['application_database'], deadline, port=ports['application']) as app:
        if not app.query('SELECT to_json(pg_try_advisory_lock(214716023,1));'):
            raise Skipped('Account lifecycle operation is running; preserve existing recovery points')
        app_snapshot = app.snapshot()
        app_state = application_state(app)
        if (app_state['meta']['identity'] != config['database_identity'] or
                app_state['meta']['environment'] != config['environment']):
            raise Corruption('Application backup identity or environment mismatch')
        # A disconnected provider worker may still finish its bounded HTTP call.
        # Do not capture during its lease, even when its DB lock has disappeared.
        # Provider HTTP requests are bounded to five seconds, at most eight
        # OAuth clients, and no retries. The extra two minutes cover the entire
        # remaining provider sequence if its DB connection was lost mid-call.
        if app.query("SELECT to_json(EXISTS(SELECT 1 FROM gtd.admin_operations WHERE state='pending' AND lease_until+interval '120 seconds'>now()));"):
            raise Skipped('An account operation remains leased; retry backup on the next run')
        with Session(config['identity_container'], config['identity_database'], deadline, port=ports['identity']) as provider:
            provider_snapshot = provider.snapshot()
            provider_state = identity_state(provider)
            validate_mapping(app_state, provider_state, config['issuer'], config['realm'])
            for side, snapshot in [('application', app_snapshot), ('identity', provider_snapshot)]:
                with (target / (side + '.dump')).open('xb') as stream:
                    os.fchmod(stream.fileno(), 0o600)
                    bounded(['docker', 'exec', '--user', 'postgres', config[side + '_container'],
                             'pg_dump', '-U', 'postgres', '-p', str(ports[side]), '-d', identifier(config[side + '_database']),
                             '--format=custom', '--compress=0', '--snapshot=' + snapshot['snapshot'],
                             '--lock-wait-timeout=5s'], deadline, stdout=stream)
                    stream.flush(); os.fsync(stream.fileno())
            atomic_json(target / 'recovery.json', recovery_material(config['recovery_files']))
            # Confirm both sessions still own their snapshots and the lifecycle
            # lock. A disconnect makes this capture unusable, never "verified".
            app.query('SELECT to_json(1);'); provider.query('SELECT to_json(1);')
    files = {name: {'sha256': sha256(target / name), 'bytes': (target / name).stat().st_size} for name in sorted(PAYLOADS)}
    manifest = {'format': FORMAT, 'captured_at': app_snapshot['captured_at'],
                'identity_captured_at': provider_snapshot['captured_at'], 'completed_at': iso(),
                'environment': config['environment'], 'database_identity': config['database_identity'],
                'schema': app_state['meta']['compatibility'], 'issuer': config['issuer'], 'realm': config['realm'],
                'application_version': config['application_version'], 'application_image': config['application_image'],
                'identity_image': config['identity_image'],
                'postgres_image': POSTGRES_IMAGE, 'kind': config.get('kind', 'hourly'),
                'application': app_state, 'identity': provider_state, 'files': files,
                'sha256': files['application.dump']['sha256'],
                'database_bytes': sum(files[name]['bytes'] for name in ('application.dump', 'identity.dump'))}
    atomic_json(target / 'manifest.json', manifest)
    return manifest


def inspect_bundle(directory):
    root = Path(directory)
    entries = list(root.iterdir())
    if {p.name for p in entries} != PAYLOADS | {'manifest.json'} or any(not p.is_file() or p.is_symlink() for p in entries):
        raise Corruption('Unexpected PostgreSQL backup contents')
    if (root / 'manifest.json').stat().st_size > MAX_CONTROL or (root / 'recovery.json').stat().st_size > 4 * MAX_CONTROL:
        raise Corruption('PostgreSQL backup metadata exceeds its size limit')
    try:
        manifest = json.loads((root / 'manifest.json').read_text())
        if manifest['format'] != FORMAT or manifest['postgres_image'] != POSTGRES_IMAGE or set(manifest['files']) != PAYLOADS:
            raise ValueError()
        meta = manifest['application']['meta']
        if (manifest['schema'] not in (12,13) or meta['compatibility'] != manifest['schema']
                or manifest['database_identity'] != meta['identity']
                or manifest['environment'] != meta['environment']
                or manifest['environment'] not in ('production','staging')):
            raise ValueError()
        for key in ('application_image', 'identity_image'):
            if not re.fullmatch('sha256:[0-9a-f]{64}',manifest[key]):
                raise ValueError()
        for name in PAYLOADS:
            if manifest['files'][name] != {'sha256': sha256(root / name), 'bytes': (root / name).stat().st_size}:
                raise ValueError()
        for key in ('captured_at', 'identity_captured_at', 'completed_at'):
            if timestamp(manifest[key]).utcoffset() is None:
                raise ValueError()
        if not timestamp(manifest['captured_at']) <= timestamp(manifest['identity_captured_at']) <= timestamp(manifest['completed_at']):
            raise ValueError()
        recovery = json.loads((root / 'recovery.json').read_text())
        if recovery['format'] != 1 or not recovery['files'] or len(recovery['files']) > 32:
            raise ValueError()
        for label, value in recovery['files'].items():
            identifier(label)
            if len(base64.b64decode(value, validate=True)) > 65536:
                raise ValueError()
        if (manifest['sha256'] != manifest['files']['application.dump']['sha256'] or
                manifest['database_bytes'] != sum(manifest['files'][name]['bytes'] for name in ('application.dump','identity.dump'))):
            raise ValueError()
        validate_mapping(manifest['application'], manifest['identity'], manifest['issuer'], manifest['realm'])
    except (ValueError, KeyError, TypeError):
        raise Corruption('PostgreSQL backup does not match its manifest') from None
    return manifest


@contextlib.contextmanager
def isolated_postgres(deadline, *, port=5432, limits=None):
    port = database_port(port)
    limits = verification_limits(limits)
    name = 'gtd-backup-verify-' + uuid.uuid4().hex
    try:
        bounded(['docker', 'run', '--detach', '--pull', 'never', '--name', name,
                 '--label', 'gtd.environment=disposable-backup-verification', '--network', 'none',
                 '--user', '999:999', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                 '--memory', str(limits['memory_mib'])+'m', '--memory-swap', str(limits['memory_mib'])+'m',
                 '--cpus', '1', '--pids-limit', '128',
                 '--tmpfs', '/var/lib/postgresql:rw,size='+str(limits['storage_mib'])+'m,uid=999,gid=999',
                 '--tmpfs', '/var/run/postgresql:rw,size=16m,uid=999,gid=999',
                 '--tmpfs', '/tmp:rw,size=16m,uid=999,gid=999',
                 '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', POSTGRES_IMAGE, 'postgres', '-p', str(port),
                 # Fresh, disposable, non-replicated restores need no replica
                 # WAL. Single-transaction CREATE/COPY retains crash safety,
                 # constraints and indexes without logging the bulk load twice.
                 '-c', 'wal_level=minimal', '-c', 'archive_mode=off', '-c', 'max_wal_senders=0',
                 # The default 1 GiB WAL budget alone can fill this verifier's
                 # entire tmpfs. These checkpoint targets are soft; tmpfs and
                 # cgroup ceilings remain the hard limits.
                 '-c', 'max_wal_size=64MB', '-c', 'min_wal_size=32MB'], deadline)
        # No published ports or external network; trust is confined to this
        # throwaway container. Each restoration always starts empty.
        while True:
            try:
                # The official image's temporary initialization server listens
                # on a Unix socket only; wait for the final TCP listener.
                bounded(['docker','exec','--user','postgres',name,'pg_isready','-q','-h','127.0.0.1','-p',str(port),'-U','postgres'], min(deadline,time.monotonic()+2))
                break
            except RuntimeError:
                if time.monotonic() >= deadline:
                    raise TimeoutError('Isolated PostgreSQL did not start') from None
                time.sleep(0.1)
        yield name
    finally:
        bounded(['docker','rm','-f',name],time.monotonic()+15)


def verification_usage(container, deadline):
    """Private container resource counters only; no database content or logs."""
    state = json.loads(bounded(['docker','inspect','--format','{{json .State}}',container],deadline))
    result = {'oom_killed': bool(state['OOMKilled']), 'running': bool(state['Running'])}
    if result['running']:
        events = bounded(['docker','exec',container,'cat','/sys/fs/cgroup/memory.events'],deadline).decode()
        result['oom_kills'] = int(dict(line.split() for line in events.splitlines()).get('oom_kill',0))
        result['peak_memory_bytes'] = int(bounded(['docker','exec',container,'cat','/sys/fs/cgroup/memory.peak'],deadline))
        disk = bounded(['docker','exec',container,'df','-k','--output=used,avail','/var/lib/postgresql'],deadline).splitlines()[-1].split()
        result['storage_used_bytes'], result['storage_available_bytes'] = [int(v)*1024 for v in disk]
        shared = bounded(['docker','exec',container,'df','-k','--output=used,avail','/dev/shm'],deadline).splitlines()[-1].split()
        result['shared_memory_used_bytes'], result['shared_memory_available_bytes'] = [int(v)*1024 for v in shared]
        # The exact pinned PostgreSQL 18 image uses this PGDATA directory.
        for directory in ('base','pg_wal'):
            used = bounded(['docker','exec',container,'du','-sk','/var/lib/postgresql/18/docker/'+directory],deadline).split()[0]
            result[directory+'_bytes'] = int(used)*1024
    return result


def restore_failure(container, deadline, measurement=None, cause=None):
    try:
        usage = verification_usage(container, min(deadline, time.monotonic()+5))
    except (RuntimeError, TimeoutError, ValueError, KeyError, subprocess.TimeoutExpired):
        usage = {}
    if measurement is not None:
        measurement.update(usage)
        if isinstance(cause,QueryFailure): measurement['sqlstate'] = cause.sqlstate
    if usage.get('oom_killed') or usage.get('oom_kills'):
        return RuntimeError('PostgreSQL verification exceeded its memory limit; recovery points were preserved')
    if usage.get('storage_available_bytes', 2**63) < 16*1024**2:
        return RuntimeError('PostgreSQL verification exhausted temporary storage; recovery points were preserved')
    code = cause.sqlstate if isinstance(cause,QueryFailure) else None
    return VerificationFailure('PostgreSQL restore or validation failed'+(' (SQLSTATE '+code+')' if code else '')+
        '; archive or verifier failure needs private inspection. Recovery points were preserved')


def verify(directory, deadline, *, limits=None, measurement=None):
    root = Path(directory)
    limits = verification_limits(limits)
    manifest = inspect_bundle(root)
    # A matching checksum is insufficient when the submitted archive is invalid.
    for side in ('application', 'identity'):
        with (root / (side+'.dump')).open('rb') as stream:
            if stream.read(5) != b'PGDMP':
                raise Corruption('PostgreSQL snapshot is not a custom-format archive')
    started = time.monotonic()
    with isolated_postgres(deadline, limits=limits) as container:
        try:
            _verify_databases(container,root,manifest,deadline)
        except RuntimeError as cause:
            if measurement is not None:
                measurement.update(limits=limits,seconds=round(time.monotonic()-started,3),completed=False)
            error = restore_failure(container,deadline,measurement,cause)
            if isinstance(cause,Corruption):
                raise
            raise error from None
        if measurement is not None:
            measurement.update(verification_usage(container, deadline), limits=limits,
                               seconds=round(time.monotonic()-started,3),completed=True)
    return manifest


def _verify_databases(container, root, manifest, deadline):
    with Session(container, 'postgres', deadline) as setup:
        setup.query('CREATE ROLE gtd_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                    'CREATE ROLE gtd_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS; '
                    'CREATE ROLE keycloak NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                    'CREATE ROLE gtd_identity NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                    'CREATE DATABASE application TEMPLATE template0; CREATE DATABASE identity TEMPLATE template0; SELECT to_json(1);')
    for side in ('application', 'identity'):
        with (root / (side + '.dump')).open('rb') as stream:
            bounded(['docker','exec','-i','--user','postgres',container,'pg_restore','-U','postgres',
                     '--dbname='+side,'--exit-on-error','--single-transaction'], deadline, stdin=stream)
    with Session(container, 'application', deadline) as app, Session(container, 'identity', deadline) as provider:
        app_state = application_state(app)
        provider_state = identity_state(provider)
        if app_state != manifest['application'] or provider_state != manifest['identity']:
            raise Corruption('Restored PostgreSQL records do not match their snapshot inventory')
        validate_mapping(app_state, provider_state, manifest['issuer'], manifest['realm'])
        if app.query("SELECT to_json(EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname='gtd' AND NOT c.convalidated));"):
            raise Corruption('Restored application contains unvalidated database constraints')
        if not app.query("SELECT to_json(count(*)=10 AND bool_and(c.relrowsecurity AND c.relforcerowsecurity AND pg_get_userbyid(c.relowner)='gtd_owner')) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gtd' AND c.relkind='r' AND c.relname IN ('account_state','tasks','dependencies','changes','revisions','requests','action_groups','search_state','search_sessions','legacy_imports');"):
            raise Corruption('Restored application row security is incomplete')

        if manifest['schema'] >= 13:
            if not app.query("SELECT to_json(relrowsecurity AND relforcerowsecurity AND pg_get_userbyid(relowner)='gtd_owner') FROM pg_class WHERE oid='gtd.activity_events'::regclass;"):
                raise Corruption('Restored activity row security is incomplete')
            if app.query("SELECT to_json(count(*)) FROM gtd.changes c LEFT JOIN gtd.activity_events e ON e.account_id=c.account_id AND e.change_id=c.id WHERE e.change_id IS NULL;"):
                raise Corruption('Restored activity projection is incomplete')
