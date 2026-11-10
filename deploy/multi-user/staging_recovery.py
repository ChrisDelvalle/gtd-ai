"""Opt-in backup capacity check of the already-isolated packaged workload.

Captures only this fixture's application/provider databases and explicit fixture
credentials. Output contains aggregate sizes and counters, never their contents.
"""
import json
import os
from pathlib import Path
import secrets
import sys
import tempfile
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backups'))
from gtd_backup import Backup, TAG, UTC, repository_size, timestamp
from postgres_bundle import capture, verify


def run(test, database, root, query, manifest, actor, task_id, population, result):
    test.assertEqual(os.environ.get('GTD_TEST_STAGING_RECOVERY'), '1')
    test.assertTrue(database.startswith('gtd-staging-bootstrap-'))
    test.assertEqual(manifest['environment'], 'staging')
    test.assertEqual(json.loads(query('SELECT row_to_json(m) FROM gtd.schema_meta m').stdout)['identity'],
                     manifest['database_identity'])
    restic = os.environ['GTD_TEST_RESTIC']
    deadline = time.monotonic()+240
    began = time.monotonic()
    config = {'application_container':database, 'identity_container':database,
        'application_database':'gtd_staging', 'identity_database':'gtd_staging_identity',
        'application_port':19545, 'identity_port':19545,
        'database_identity':manifest['database_identity'], 'environment':'staging',
        'issuer':manifest['issuer'], 'realm':manifest['realm'], 'application_version':'disposable-capacity-fixture',
        'application_image':manifest['images']['service'], 'identity_image':manifest['images']['identity'],
        'recovery_files': {name:str(root/path) for name,path in {
            'website_client_secret':'service/website.secret',
            'administration_client_secret':'service/administration.secret',
            'database_credentials':'database/environment',
            'provider_bootstrap_credentials':'identity/environment',
            'runtime_database_credentials':'service/runtime.dsn'}.items()}}
    result.update({'accounts':population, 'total_directory_accounts':population+2, 'captures':[],
        'source_database_bytes':{side:int(query('SELECT pg_database_size(current_database())', database=name).stdout)
            for side,name in [('application','gtd_staging'),('identity','gtd_staging_identity')]},
        'model_calls':0, 'actual_laptop_repository':False, 'network_transfer_measured':False, 'completed':False})
    with tempfile.TemporaryDirectory(prefix='gtd-packaged-recovery-') as directory:
        temporary = Path(directory)
        repositories = []
        for side in ('server','laptop'):
            password = temporary/(side+'.password')
            password.write_text(secrets.token_urlsafe(40)); password.chmod(0o600)
            backup = Backup({'home':str(temporary/side), 'role':side, 'restic':restic,
                'repository':str(temporary/side/'repository'), 'password':{'file':str(password)},
                'timeout_seconds':240})
            backup.deadline = deadline
            repositories.append(backup)
        server,laptop = repositories
        server.restic('init')
        laptop.c.update(source_repository=server.c['repository'], source_password=server.c['password'])
        laptop.restic('init','--copy-chunker-params',source=True)
        for kind in ('initial','unchanged','light_edit'):
            if kind == 'light_edit':
                current = actor.api('/api/tools/list_items',{'task_id':task_id,'limit':1})['items'][0]
                actor.api('/api/tools/update_item', {'task_id':task_id, 'expected_version':current['version'],
                    'request_id':str(uuid.uuid4()), 'notes':'One small synthetic change for population '+str(population)+'.',
                    'reason':'Disposable backup capacity check'})
            payload = temporary/'payload'
            if payload.exists():
                # Keep the path stable across captures for Restic deduplication.
                for path in payload.iterdir(): path.unlink()
                payload.rmdir()
            started = time.monotonic()
            bundle = capture(config,payload,deadline)
            entry = {'kind':kind,'capture_seconds':round(time.monotonic()-started,3),
                'dump_bytes':bundle['database_bytes'], 'file_bytes':{k:v['bytes'] for k,v in bundle['files'].items()}}
            usage = {}
            entry['verification'] = usage
            result['captures'].append(entry)
            test.assertEqual(verify(payload,deadline,measurement=usage),bundle)
            before = repository_size(server.c['repository'])
            started = time.monotonic()
            output = server.restic('backup','.', '--json','--tag',TAG,
                '--time',timestamp(bundle['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'),cwd=payload)
            summary = [json.loads(line) for line in output.splitlines() if line.strip()][-1]
            test.assertEqual(summary['message_type'],'summary')
            entry.update(commit_seconds=round(time.monotonic()-started,3),
                repository_growth_bytes=repository_size(server.c['repository'])-before,
                restic={k:summary[k] for k in ('data_added','data_added_packed','total_bytes_processed')})
            latest = summary['snapshot_id']
        started = time.monotonic()
        laptop.restic('copy',source=True)
        result['copy_seconds'] = round(time.monotonic()-started,3)
        # Verify all ciphertext and actual independent-copy contents. A copied
        # snapshot can have a different ID; use its original-source metadata.
        server.restic('check','--read-data')
        laptop.restic('check','--read-data')
        copies = laptop.snapshots()
        test.assertEqual(len(copies),3)
        selected = next(s for s in copies if s['id'] == latest or s.get('original') == latest)
        server.restic('forget',*[s['id'] for s in server.snapshots()])
        server.restic('prune','--max-unused','0')
        test.assertEqual(server.snapshots(),[])
        restored = temporary/'restored'
        laptop.restic('restore',selected['id'],'--target',str(restored),'--verify')
        manifests = list(restored.rglob('manifest.json'))
        test.assertEqual(len(manifests),1)
        usage = {}
        test.assertEqual(verify(manifests[0].parent,deadline,measurement=usage),bundle)
        result.update(independent_restore=usage, source_deletion_independence=True,
            snapshots=3, laptop_repository_bytes=repository_size(laptop.c['repository']),
            application_counts=bundle['application']['counts'],
            identity_tables=len(bundle['identity']['counts']),
            seconds=round(time.monotonic()-began,3), completed=True)
    return result
