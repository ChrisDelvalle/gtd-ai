"""Manual deterministic checks. Only disposable, networkless containers."""
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

from gtd_backup import Backup, Corruption, Skipped, TAG, UTC, atomic_json, sha256, timestamp
from postgres_bundle import (Session, bounded, capture, inspect_bundle, isolated_postgres,
                             recovery_material, verify, verification_limits, restore_failure)
from backup_errors import VerificationFailure

ROOT = Path(__file__).resolve().parents[2]


class RecoveryFiles(unittest.TestCase):
    def test_restic_restore_failure_preserves_uncertain_cause(self):
        with tempfile.TemporaryDirectory() as directory:
            backup = Backup({'home':directory})
            for cause in (Corruption('verified corruption'), RuntimeError('private diagnostics')):
                with patch.object(backup,'restic',side_effect=cause):
                    with self.assertRaises(VerificationFailure) as error:
                        backup.verify_snapshot({'id':'fixture'})
                    self.assertEqual(isinstance(error.exception,Corruption),isinstance(cause,Corruption))
                    self.assertNotIn('private diagnostics',str(error.exception))

    def test_verification_limits_are_operator_bounded(self):
        self.assertEqual(verification_limits(), {'storage_mib':1024,'memory_mib':1536})
        self.assertEqual(verification_limits({'storage_mib':128,'memory_mib':384})['storage_mib'],128)
        for limits in ([], {'other':1}, {'storage_mib':True}, {'memory_mib':1536.0},
                       {'storage_mib':127}, {'storage_mib':4097}, {'memory_mib':1024}, {'memory_mib':6145}):
            with self.subTest(limits=limits), patch('postgres_bundle.bounded') as command:
                with self.assertRaises(RuntimeError), isolated_postgres(time.monotonic()+5,limits=limits):
                    self.fail('Invalid limits entered verification')
                command.assert_not_called()

    def test_resource_errors_are_not_reported_as_corruption(self):
        for usage, word in (({'oom_killed':True}, 'memory'), ({'oom_kills':1}, 'memory'),
                            ({'storage_available_bytes':0}, 'storage')):
            with patch('postgres_bundle.verification_usage',return_value=usage):
                error = restore_failure('fixture',time.monotonic()+10)
                self.assertNotIsInstance(error,VerificationFailure)
                self.assertIn(word,str(error))
        with patch('postgres_bundle.verification_usage',side_effect=RuntimeError('private detail')):
            error = restore_failure('fixture',time.monotonic()+10)
            self.assertIsInstance(error,VerificationFailure)
            self.assertNotIsInstance(error,Corruption)
            self.assertNotIn('private detail',str(error))

    def test_invalid_source_ports_fail_before_process_or_capture(self):
        for value in (0, 65536, True, '5432', None, 5432.0):
            with self.subTest(port=value), patch('postgres_bundle.subprocess.Popen') as process:
                with self.assertRaises(RuntimeError):
                    Session('fixture', 'application', time.monotonic()+5, port=value)
                with tempfile.TemporaryDirectory() as temporary:
                    destination = Path(temporary)/'capture'
                    with self.assertRaises(RuntimeError):
                        capture({'application_port':value},destination,time.monotonic()+5)
                    self.assertFalse(destination.exists())
                process.assert_not_called()

    def test_only_private_explicit_files_and_no_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'secret'
            path.write_text('synthetic recovery secret'); path.chmod(0o600)
            self.assertEqual(set(recovery_material({'fixture_secret': str(path)})['files']), {'fixture_secret'})
            path.chmod(0o644)
            with self.assertRaises(RuntimeError): recovery_material({'fixture_secret': str(path)})
            path.chmod(0o600)
            link = Path(directory) / 'link'; link.symlink_to(path)
            with self.assertRaises(OSError): recovery_material({'fixture_secret': str(link)})
            with self.assertRaises(RuntimeError): recovery_material({})

    def test_database_errors_do_not_print_private_values(self):
        with self.assertRaises(RuntimeError) as error:
            bounded(['python3','-c', "import sys; print('fixture-password',file=sys.stderr);sys.exit(1)"],time.monotonic()+5)
        self.assertNotIn('fixture-password',str(error.exception))

    def test_postgres_failure_never_authorizes_retention(self):
        for error in [Skipped('lifecycle busy'), Corruption('mapping mismatch'),
                      VerificationFailure('unverified archive'), RuntimeError('engine unavailable')]:
            with tempfile.TemporaryDirectory() as directory:
                backup = Backup({'home':directory,'role':'server','postgres':{'configured':True},
                                 'maintenance_state':str(Path(directory)/'guard'),'repository':str(Path(directory)/'repository')})
                with patch.object(backup,'restic') as restic, patch.object(backup,'capture_postgres',side_effect=error), patch.object(backup,'maintain') as maintain:
                    if isinstance(error,Skipped): backup.backup_now()
                    else:
                        with self.assertRaises(type(error)): backup.backup_now()
                    maintain.assert_not_called()
                    self.assertEqual(restic.call_args_list[0].args,('unlock',))
                    self.assertEqual(restic.call_count,1)


@unittest.skipUnless(os.environ.get('GTD_TEST_POSTGRES_BACKUP') == '1', 'Explicit disposable Docker test')
class BundleRoundTrip(unittest.TestCase):
    def test_capture_restore_mapping_corruption_lifecycle_and_concurrent_writes(self):
        deadline = time.monotonic() + 180
        # Generated staging uses 19545. Capture must hold/export and dump from
        # the same configured source port; restoration uses its own default.
        source_port = 19545
        with tempfile.TemporaryDirectory(prefix='gtd-pg-backup-fixture-') as temporary, isolated_postgres(deadline,port=source_port) as container:
            root = Path(temporary)
            account, identity = str(uuid.uuid4()), str(uuid.uuid4())
            with Session(container,'postgres',deadline,port=source_port) as setup:
                setup.query('CREATE ROLE gtd_owner NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                            'CREATE ROLE gtd_runtime NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS; '
                            'CREATE ROLE keycloak NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                            'CREATE ROLE gtd_identity NOLOGIN NOSUPERUSER NOBYPASSRLS; '
                            'CREATE DATABASE application TEMPLATE template0; CREATE DATABASE identity TEMPLATE template0; SELECT to_json(1);')
            with Session(container,'application',deadline,port=source_port) as app:
                app.query('GRANT CREATE ON DATABASE application TO gtd_owner; SELECT to_json(1);')
                schema = '\n'.join((ROOT / 'src/postgres' / name).read_text() for name in ['schema.sql','administration.sql','settings.sql','activity.sql','timed_holds_index.sql','sessions.sql'])
                # psql suppresses command tags, but existing schema SELECTs can
                # emit output. Load it through a separate bounded pipe instead.
                source = root / 'schema.sql'; source.write_text(schema)
                with source.open('rb') as stream:
                    bounded(['docker','exec','-i','--user','postgres',container,'psql','-X','-q','-v','ON_ERROR_STOP=1','-U','postgres','-p',str(source_port),'-d','application'],deadline,stdin=stream)
                app.query(f"INSERT INTO gtd.schema_meta VALUES(true,13,'staging','{identity}'); "
                          f"INSERT INTO gtd.accounts(id,issuer,subject,username,enabled,enrollment) VALUES('{account}','https://identity.invalid/realms/gtd','fixture-subject','fixture',true,'active'); "
                          f"INSERT INTO gtd.account_state(account_id,identity) VALUES('{account}','{uuid.uuid4()}'); "
                          f"INSERT INTO gtd.tasks(account_id,id,document) VALUES('{account}','one','{{\"id\":\"one\",\"notes\":\"Fictional retained notes\"}}'); SELECT to_json(1);")
            with Session(container,'identity',deadline,port=source_port) as provider:
                # Representative Keycloak mapping tables; actual provider
                # migrations and live recovery are a separate acceptance gate.
                provider.query("CREATE TABLE realm(id text PRIMARY KEY,name text); "
                    "CREATE TABLE user_entity(id text PRIMARY KEY,realm_id text REFERENCES realm(id),enabled boolean); "
                    "CREATE TABLE user_attribute(id text PRIMARY KEY,user_id text REFERENCES user_entity(id),name text,value text); "
                    "ALTER TABLE realm OWNER TO gtd_identity; ALTER TABLE user_entity OWNER TO gtd_identity; "
                    "ALTER TABLE user_attribute OWNER TO gtd_identity; "
                    "INSERT INTO realm VALUES('realm-id','gtd'); "
                    "INSERT INTO user_entity VALUES('fixture-subject','realm-id',true); "
                    f"INSERT INTO user_attribute VALUES('attr','fixture-subject','gtd_account_id','{account}'); SELECT to_json(1);")
            secret = root / 'secret'; secret.write_text('fixture-only-secret'); secret.chmod(0o600)
            config = {'application_container':container, 'identity_container':container,
                      'application_database':'application','identity_database':'identity',
                      'application_port':source_port,'identity_port':source_port,
                      'database_identity':identity,'environment':'staging','issuer':'https://identity.invalid/realms/gtd',
                      'realm':'gtd','application_version':'synthetic','application_image':'sha256:'+'0'*64,
                      'identity_image':'sha256:'+'1'*64,
                      'recovery_files':{'fixture_secret':str(secret)}}
            destination = root / 'capture'
            started = time.monotonic()
            wrote = False
            def edit_during_dump(command, *args, **kwargs):
                nonlocal wrote
                if 'pg_dump' in command and not wrote:
                    wrote = True
                    with Session(container,'application',deadline,port=source_port) as writer:
                        writer.query(f"INSERT INTO gtd.tasks(account_id,id,document) VALUES('{account}','two','{{\"id\":\"two\"}}'); SELECT to_json(1);")
                return bounded(command,*args,**kwargs)
            with patch('postgres_bundle.bounded',side_effect=edit_during_dump):
                manifest = capture(config, destination, deadline)
            self.assertTrue(wrote)
            captured_bytes = manifest['database_bytes']
            self.assertEqual(verify(destination,deadline),manifest)
            self.assertEqual(manifest['application']['counts']['tasks'],1)
            self.assertNotIn('fixture-only-secret',(destination / 'manifest.json').read_text())
            # Task edits after the captured snapshot do not alter the backup.
            with Session(container,'application',deadline,port=source_port) as app:
                app.query(f"UPDATE gtd.tasks SET document='{{\"id\":\"one\",\"notes\":\"Newer fixture notes\"}}' WHERE account_id='{account}' AND id='one'; SELECT to_json(1);")
                self.assertTrue(app.query('SELECT to_json(pg_try_advisory_lock(214716023,1));'))
                with self.assertRaises(Skipped): capture(config,root/'blocked',deadline)
                self.assertEqual(app.query('SELECT to_json(count(*)) FROM gtd.tasks;'),2)
            # A lost coordination connection with a live lease cannot be
            # mistaken for a quiescent provider.
            with Session(container,'application',deadline,port=source_port) as app:
                app.query(f"INSERT INTO gtd.admin_operations(actor_id,request_id,command,target_id,kind,lease_until) VALUES('{account}','{uuid.uuid4()}','{{}}','{uuid.uuid4()}','invite',now()); SELECT to_json(1);")
                with self.assertRaises(Skipped): capture(config,root/'leased',deadline)
                app.query("DELETE FROM gtd.admin_operations; SELECT to_json(1);")
            with Session(container,'identity',deadline,port=source_port) as provider:
                provider.query("UPDATE user_attribute SET value='wrong-account'; SELECT to_json(1);")
                with self.assertRaises(Corruption): capture(config,root/'mismatch',deadline)
            restic = os.environ.get('GTD_TEST_RESTIC')
            if restic:
                password = root/'restic-password'; password.write_text('disposable-repository-only'); password.chmod(0o600)
                source = Backup({'home':str(root/'server'),'role':'server','restic':restic,
                                 'repository':str(root/'server/repository'),'password':{'file':str(password)}})
                source.restic('init')
                laptop = Backup({'home':str(root/'laptop'),'role':'laptop','restic':restic,
                                 'repository':str(root/'laptop/repository'),'password':{'file':str(password)},
                                 'source_repository':source.c['repository'],'source_password':{'file':str(password)}})
                laptop.restic('init','--copy-chunker-params',source=True)
                source.restic('backup','.', '--tag',TAG, '--time',timestamp(manifest['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'),cwd=destination)
                with patch.object(laptop,'notify'):
                    laptop.backup_now()
                self.assertEqual(laptop.state['verification'],'ok')
                original = source.snapshots()[0]
                source.restic('forget',original['id'])
                source.restic('prune','--max-unused','0')
                self.assertEqual(laptop.verify_snapshot(laptop.snapshots()[0]),manifest)
            with (destination/'identity.dump').open('ab') as stream: stream.write(b'corrupt')
            with self.assertRaises(Corruption): inspect_bundle(destination)
            # A matching checksum alone is not integrity: a malformed archive
            # must fail an actual restore as well.
            (destination/'identity.dump').write_bytes(b'invalid PostgreSQL archive')
            manifest['files']['identity.dump'] = {'sha256':sha256(destination/'identity.dump'),
                                                  'bytes':(destination/'identity.dump').stat().st_size}
            manifest['database_bytes'] = manifest['files']['application.dump']['bytes'] + manifest['files']['identity.dump']['bytes']
            atomic_json(destination/'manifest.json',manifest)
            with self.assertRaises(Corruption): verify(destination,deadline)
            # Exhaust a deliberately small verifier without exhausting the
            # host disk or changing the source payload. EXTERNAL keeps the
            # synthetic JSON uncompressed in PostgreSQL's temporary storage.
            with Session(container,'identity',deadline,port=source_port) as provider:
                provider.query(f"UPDATE user_attribute SET value='{account}'; SELECT to_json(1);")
            with Session(container,'application',deadline,port=source_port) as app:
                app.query("ALTER TABLE gtd.tasks ALTER COLUMN document SET STORAGE EXTERNAL; "
                    f"INSERT INTO gtd.tasks(account_id,id,document) SELECT '{account}','capacity-'||n,"
                    "jsonb_build_object('id','capacity-'||n,'notes',repeat(md5(n::text),1024)) "
                    "FROM generate_series(1,4000) n; SELECT to_json(1);")
            capacity = root/'capacity'
            capacity_manifest = capture(config,capacity,deadline)
            self.assertEqual(verify(capacity,deadline),capacity_manifest)
            with self.assertRaises(RuntimeError) as error:
                verify(capacity,deadline,limits={'storage_mib':128,'memory_mib':384})
            self.assertNotIsInstance(error.exception,Corruption)
            # PostgreSQL may exit before its temporary filesystem can be
            # measured. Preserve uncertainty rather than calling valid data
            # corrupt when post-failure resource counters are unavailable.
            self.assertTrue(any(word in str(error.exception) for word in
                ('memory limit','temporary storage','verifier failure')))
            self.assertEqual(inspect_bundle(capacity),capacity_manifest)
            with Session(container,'application',deadline,port=source_port) as diagnostic:
                with self.assertRaises(RuntimeError) as error:
                    diagnostic.query("SELECT 'private-fixture-value'::integer;")
                self.assertIn('22P02',str(error.exception))
                self.assertNotIn('private-fixture-value',str(error.exception))
            print(json.dumps({'check':'postgres_bundle_roundtrip','seconds':round(time.monotonic()-started,3),
                              'database_bytes':captured_bytes,'schema':manifest['schema'],
                              'live_provider':False,'production':False}))


if __name__ == '__main__': unittest.main()
