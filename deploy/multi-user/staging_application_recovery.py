"""Opt-in full application recovery of the unpublished, disposable fixture.

Never accepts external endpoints, production records or account selectors. The
source stack is destroyed; only a separately encrypted repository and rebuildable
configuration remain. Credentials travel through private files and pipes only.
"""
import base64
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import time
import uuid

import staging
from staging_acceptance import (CLIENTS, ISSUER, REALM, Transport, WebsiteSession,
                                mcp, oauth_grant, prepare_https, refresh)
from gtd_backup import Backup, TAG, UTC, timestamp
from postgres_bundle import Session, application_state, capture, identity_state, verify
from recovery_ops import ProviderRecovery, prepare_application

MATERIAL = {'website_client_secret':'service/website.secret',
            'administration_client_secret':'service/administration.secret',
            'database_credentials':'database/environment',
            'provider_bootstrap_credentials':'identity/environment',
            'runtime_database_credentials':'service/runtime.dsn'}


def inventory(query):
    # Compare authoritative JSON, IDs, versions, history and receipts without
    # emitting their contents. These hashes are fixture assertions, not security
    # checksums; the backup already has SHA-256 file integrity verification.
    return {table:json.loads(query("SELECT json_build_object('count',count(*),'digest',"
        "md5(coalesce(string_agg(md5(row_to_json(t)::text),'' ORDER BY row_to_json(t)::text),''))) "
        'FROM gtd.'+table+' t').stdout) for table in
        ('tasks','dependencies','changes','revisions','requests','action_groups')}


def run(test, docker, database, root, query, manifest, owner, owner_password,
        components, tasks, request_id):
    from test_staging import database_query, start_database
    test.assertEqual(os.environ.get('GTD_TEST_STAGING_APPLICATION_RECOVERY'),'1')
    test.assertNotEqual(os.environ.get('GTD_TEST_STAGING_WORKFLOWS'),'1')
    test.assertTrue(database.startswith('gtd-staging-bootstrap-'))
    test.assertEqual(manifest['environment'],'staging')
    test.assertEqual(manifest['issuer'],ISSUER)
    test.assertEqual(root,test.root)
    test.assertTrue(root.parent.name.startswith('gtd-staging-config-'))
    restic = os.environ['GTD_TEST_RESTIC']
    started = time.monotonic(); deadline = started+480
    owner.transport.deadline = deadline
    owner.login('fixture-owner',owner_password,remember=True)
    account = owner.profile['account']['id']
    grants = []
    for client, callback, host in (
        (CLIENTS[1],'https://chatgpt.com/connector_platform_oauth_redirect','127.0.0.1:19544'),
        (CLIENTS[2],'https://claude.ai/api/mcp/auth_callback','mcp-staging.example.invalid')):
        grants.append((client,host,oauth_grant(owner,client,callback,
            credentials=('fixture-owner',owner_password))))
    original = inventory(query)
    with tempfile.TemporaryDirectory(prefix='gtd-full-recovery-') as temporary:
        work = Path(temporary).resolve()
        print('Application recovery: capture and independent copy',flush=True)
        bundle = capture({'application_container':database,'identity_container':database,
            'application_database':'gtd_staging','identity_database':'gtd_staging_identity',
            'application_port':19545,'identity_port':19545,
            'database_identity':manifest['database_identity'],'environment':'staging',
            'issuer':ISSUER,'realm':REALM,'application_version':'disposable-application-recovery',
            'application_image':manifest['images']['service'],'identity_image':manifest['images']['identity'],
            'recovery_files':{label:str(root/path) for label,path in MATERIAL.items()}},work/'capture',deadline)
        test.assertEqual(verify(work/'capture',deadline),bundle)
        repositories = []
        for side in ('server','laptop'):
            password = work/(side+'.password')
            password.write_text(secrets.token_urlsafe(40)); password.chmod(0o600)
            repository = Backup({'home':str(work/side),'role':side,'restic':restic,
                'repository':str(work/side/'repository'),'password':{'file':str(password)},'timeout_seconds':480})
            repository.deadline = deadline
            repositories.append(repository)
        server,laptop = repositories
        server.restic('init')
        laptop.c.update(source_repository=server.c['repository'],source_password=server.c['password'])
        laptop.restic('init','--copy-chunker-params',source=True)
        server.restic('backup','.', '--tag',TAG,'--time',
            timestamp(bundle['captured_at']).astimezone(UTC).strftime('%Y-%m-%d %H:%M:%S'),cwd=work/'capture')
        laptop.restic('copy',source=True)
        laptop.restic('check','--read-data')
        # Remove only this exact fixture's containers, volume and private files.
        # No published route ever exists, even while old grants are inspected.
        for key in ('gateway','adapter','service','search','identity'):
            test.assertTrue(components[key].startswith('gtd-staging-'+key+'-'))
            docker('rm','--force',components[key])
        docker('rm','--force',database)
        docker('volume','rm',database+'-data')
        shutil.rmtree(root)
        shutil.rmtree(work/'capture')
        server.restic('forget',*[s['id'] for s in server.snapshots()])
        server.restic('prune','--max-unused','0')
        test.assertEqual(server.snapshots(),[])
        print('Application recovery: source removed; restore independent copy',flush=True)
        snapshots = laptop.snapshots()
        test.assertEqual(len(snapshots),1)
        test.assertEqual(laptop.verify_snapshot(snapshots[0],work/'restored'),bundle)
        payload = next((work/'restored').rglob('manifest.json')).parent
        restored_root = work/'stack'
        restored_manifest = staging.prepare(restored_root,**test.options)
        prepare_https(restored_root)
        material = json.loads((payload/'recovery.json').read_text())['files']
        test.assertEqual(set(material),set(MATERIAL))
        for label,path in MATERIAL.items():
            target = restored_root/path
            target.write_bytes(base64.b64decode(material[label],validate=True)); target.chmod(0o600)
        settings = json.loads((restored_root/'service/config.json').read_text())
        settings['background'] = True
        (restored_root/'service/config.json').write_text(json.dumps(settings)+'\n')
        # Search contents and its key are freshly generated, not backed up.
        test.assertEqual(list((restored_root/'search/data').iterdir()),[])
        restored = 'gtd-staging-bootstrap-'+uuid.uuid4().hex
        test.root = restored_root
        try:
            start_database(test,restored_root,restored,restored+'-data')
            restored_query = database_query(restored)
            restored_query('DROP SCHEMA gtd CASCADE;')
            for side,destination in (('application','gtd_staging'),('identity','gtd_staging_identity')):
                docker('exec','-i','--user','postgres',restored,'pg_restore','-U','postgres','-p','19545',
                    '--dbname='+destination,'--exit-on-error','--single-transaction',
                    input=(payload/(side+'.dump')).read_bytes())
            with Session(restored,'gtd_staging',deadline,port=19545) as app, \
                    Session(restored,'gtd_staging_identity',deadline,port=19545) as identity:
                test.assertEqual(application_state(app),bundle['application'])
                test.assertEqual(identity_state(identity),bundle['identity'])
                cutoff = int(time.time())
                prepare_application(app,source_identity=manifest['database_identity'],
                    recovery_identity=restored_manifest['database_identity'],environment='staging',cutoff=cutoff)
            test.assertEqual(inventory(restored_query),original)
            print('Application recovery: restart and verify restored services',flush=True)

            def check_restored(_components):
                transport = Transport(docker,restored,restored_root)
                transport.deadline = deadline
                old_session = WebsiteSession(transport,test)
                old_session.cookies = owner.cookies
                test.assertFalse(old_session.api('/api/auth/session')['authenticated'])
                renewed = []
                for client,host,tokens in grants:
                    tokens = refresh(old_session,client,tokens['refresh_token'])
                    renewed.append((client,host,tokens))
                    mcp(transport,test,tokens['access_token'],host,'get_profile',status=403)
                operator = ProviderRecovery('http://127.0.0.1:19543',REALM,ISSUER,
                    'admin-cli','unused',CLIENTS,deadline)
                operator.opener = transport
                values = dict(line.split('=',1) for line in (restored_root/'identity/environment').read_text().splitlines())
                token = operator.request('/realms/master/protocol/openid-connect/token','POST',{
                    'grant_type':'password','client_id':'admin-cli','username':values['KC_BOOTSTRAP_ADMIN_USERNAME'],
                    'password':values['KC_BOOTSTRAP_ADMIN_PASSWORD']},form=True,authenticated=False)
                operator.token,operator.expires = token['access_token'],time.monotonic()+token['expires_in']-5
                test.assertEqual(operator.revoke(bundle['application']['accounts'])['accounts_processed'],2)
                test.assertEqual(restored_query('SELECT count(*) FROM gtd.accounts WHERE NOT enabled').stdout.strip(),b'1')
                disabled = next(a for a in bundle['application']['accounts'] if not a['enabled'])
                test.assertFalse(operator.request('/admin/realms/'+REALM+'/users/'+disabled['subject'])['enabled'])
                for client,_,tokens in renewed:
                    refresh(old_session,client,tokens['refresh_token'],status=400)
                # Rebind the fixture's bootstrap marker to the restored DB ID;
                # account issuer/subject mappings remain unchanged.
                realm = operator.request('/admin/realms/'+REALM)
                test.assertEqual(realm['attributes']['gtd_staging_database'],manifest['database_identity'])
                realm['attributes']['gtd_staging_database'] = restored_manifest['database_identity']
                operator.request('/admin/realms/'+REALM,'PUT',realm)
                while int(time.time())<=cutoff: time.sleep(.05)
                fresh = WebsiteSession(transport,test)
                profile = fresh.login('fixture-owner',owner_password,remember=True)
                test.assertEqual(profile['account']['id'],account)
                test.assertTrue(profile['account']['administrator'])
                test.assertEqual([v['id'] for v in fresh.api('/api/tools/list_items',{'limit':10})['items']],[tasks[0]])
                test.assertEqual(fresh.api('/api/tools/list_items',{'task_id':tasks[1]})['items'],[])
                retry = fresh.api('/api/tools/capture_item',{'request_id':request_id,'title':'Synthetic owner task',
                    'brief':'Complete the isolated acceptance check.','importance':'normal','status':'next',
                    'estimated_minutes':15,'effort':'low','reason':'Disposable deterministic fixture'})
                test.assertTrue(retry['replayed']); test.assertEqual(retry['task']['id'],tasks[0])
                test.assertEqual(inventory(restored_query),original)
                search_deadline = min(deadline,time.monotonic()+20)
                while True:
                    found = fresh.api('/api/tools/list_items',{'query':'Synthetic owner task','limit':10})['items']
                    if any(item['id']==tasks[0] for item in found): break
                    if time.monotonic()>=search_deadline: test.fail('Restored search did not rebuild')
                    time.sleep(.2)
                invitation = fresh.api('/api/users/operations',{'request_id':str(uuid.uuid4()),
                    'command':{'action':'invite','username':'recovered-user','display_name':'Recovery test'}})
                time.sleep(1.05)
                ordinary = WebsiteSession(transport,test)
                ordinary.login('recovered-user',invitation['temporary_password'],
                    replace_password='Gtd-9!'+secrets.token_urlsafe(24))
                ordinary.api('/api/users',status=403)
                test.assertEqual(ordinary.api('/api/tools/list_items',{'task_id':tasks[0]})['items'],[])
                task = ordinary.api('/api/tools/capture_item',{'request_id':str(uuid.uuid4()),
                    'title':'Private recovered task','importance':'normal','status':'inbox',
                    'reason':'Disposable recovery fixture','estimated_minutes':15,'effort':'low'})['task']
                test.assertEqual(fresh.api('/api/tools/list_items',{'task_id':task['id']})['items'],[])
                for client,callback,host in (
                    (CLIENTS[1],'https://chatgpt.com/connector_platform_oauth_redirect','127.0.0.1:19544'),
                    (CLIENTS[2],'https://claude.ai/api/mcp/auth_callback','mcp-staging.example.invalid')):
                    tokens = oauth_grant(fresh,client,callback,credentials=('fixture-owner',owner_password))
                    result = mcp(transport,test,tokens['access_token'],host,'get_profile')
                    test.assertEqual(result['structuredContent']['id'],account)
            test.check_runtime(restored,restored_query,restored_manifest,recovery_check=check_restored)
        finally:
            test.root = root
            docker('rm','--force',restored,check=False)
            docker('volume','rm',restored+'-data',check=False)
    return {'completed':True,'source_stack_destroyed':True,'source_secrets_removed':True,
        'independent_repository':True,'different_repository_passwords':True,
        'complete_application_restarted':True,'authoritative_content_and_receipts_preserved':True,
        'old_website_and_mcp_sessions_rejected':True,'provider_offline_grants_revoked':True,
        'new_website_and_both_mcp_clients_authenticated':True,'search_rebuilt':True,
        'administration_and_account_isolation':True,'model_calls':0,'actual_laptop_repository':False,
        'actual_host_checks':False,'seconds':round(time.monotonic()-started,3)}
