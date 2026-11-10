"""Owner enrollment guards; actual provider/database checks run only manually."""
import json
from pathlib import Path
import stat
import tempfile
import types
import unittest
import uuid

from owner_enrollment import prepare_owner


class NoDatabase:
    def query(self, *_): raise AssertionError('Invalid input must fail before database access')


class Boundary(unittest.TestCase):
    def test_wrong_environment_transport_and_private_directory_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix='gtd-owner-check-') as directory:
            root = Path(directory).resolve()
            manifest = {'environment':'production','realm':'gtd','database_identity':str(uuid.uuid4()),
                        'issuer':'https://auth.example.invalid/realms/gtd'}
            admin = types.SimpleNamespace(realm='gtd',issuer=manifest['issuer'],base='http://127.0.0.1:20543')
            source = str(uuid.uuid4())
            for field,value in (('environment','staging'),('realm','master'),
                ('issuer','https://auth-staging.example.invalid/realms/gtd'),('database_identity',source)):
                with self.subTest(field=field), self.assertRaises((ValueError,RuntimeError)):
                    prepare_owner(admin,NoDatabase(),{**manifest,field:value},root/'owner.json',source)
            admin.base = 'http://127.0.0.1:19543'
            with self.assertRaises(RuntimeError): prepare_owner(admin,NoDatabase(),manifest,root/'owner.json',source)
            admin.base = 'http://127.0.0.1:20543'
            root.chmod(0o755)
            try:
                with self.assertRaises(RuntimeError): prepare_owner(admin,NoDatabase(),manifest,root/'owner.json',source)
            finally: root.chmod(0o700)
            external = root/'other'; external.write_text('untouched')
            (root/'owner.lock').symlink_to(external)
            with self.assertRaises(OSError): prepare_owner(admin,NoDatabase(),manifest,root/'owner.json',source)
            self.assertEqual(external.read_text(),'untouched')
            self.assertFalse((root/'owner.json').exists())


def check_provider_and_database(test, admin, open_database, manifest, journal):
    """Called only within test_production's unpublished networkless fixture."""
    from functools import partial
    enroll = partial(prepare_owner, username="first-admin", timezone="Europe/Berlin")
    source = str(uuid.uuid4())
    prefix = '/admin/realms/gtd/users'
    with open_database() as database:
        # Merely owning the name owner cannot claim the migrated account.
        admin.request(prefix,'POST',{'username':'first-admin','enabled':False})
        stranger = admin.request(prefix+'?username=first-admin&exact=true')[0]['id']
        with test.assertRaisesRegex(RuntimeError,'Refusing to adopt'):
            enroll(admin,database,manifest,journal,source)
        test.assertEqual(database.query('SELECT to_json(count(*)) FROM gtd.accounts;'),0)
        test.assertEqual(admin.request(prefix+'/'+stranger).get('attributes',{}),{})
        admin.request(prefix+'/'+stranger,'DELETE')

        class LostProviderReply:
            def __getattr__(self,name): return getattr(admin,name)
            def request(self,path,method='GET',*args,**kwargs):
                result = admin.request(path,method,*args,**kwargs)
                if path == prefix and method == 'POST': raise RuntimeError('Simulated lost provider response')
                return result
        with test.assertRaisesRegex(RuntimeError,'lost provider response'):
            enroll(LostProviderReply(),database,manifest,journal,source)
        test.assertEqual(database.query('SELECT to_json(count(*)) FROM gtd.accounts;'),0)

        class LostCommitReply:
            def query(self,sql):
                result = database.query(sql)
                if sql.startswith('COMMIT;'): raise RuntimeError('Simulated lost commit response')
                return result
        with test.assertRaisesRegex(RuntimeError,'lost commit response'):
            enroll(admin,LostCommitReply(),manifest,journal,source)
        test.assertEqual(database.query('SELECT to_json(count(*)) FROM gtd.accounts;'),1)
        test.assertFalse(json.loads(journal.read_text())['prepared'])
        result = enroll(admin,database,manifest,journal,source)
        test.assertEqual(result,enroll(admin,database,manifest,journal,source))
        test.assertFalse(result['provider_sign_in_enabled'])
        test.assertNotIn('password',result)
        test.assertEqual(stat.S_IMODE(journal.stat().st_mode),0o600)
        test.assertEqual(database.query("SELECT to_json(count(*)) FROM gtd.admin_events WHERE event='bound';"),1)
        users = admin.request(prefix+'?username=first-admin&exact=true')
        test.assertEqual(len(users),1)
        test.assertEqual(users[0]['id'],result['subject'])
        user = admin.request(prefix+'/'+result['subject'])
        test.assertFalse(user['enabled'])
        test.assertIn('UPDATE_PASSWORD',user['requiredActions'])
        # The bootstrap never replays state over subsequent account revisions.
        database.query('UPDATE gtd.account_state SET high=high+1; SELECT to_json(true);')
        test.assertEqual(result,enroll(admin,database,manifest,journal,source))
        test.assertEqual(database.query('SELECT to_json(high) FROM gtd.account_state;'),1)
        before = journal.read_bytes()
        with test.assertRaisesRegex(RuntimeError,'different migration'):
            enroll(admin,database,manifest,journal,str(uuid.uuid4()))
        test.assertEqual(journal.read_bytes(),before)
        with open_database() as other:
            test.assertTrue(other.query('SELECT to_json(pg_try_advisory_lock(214716023,1));'))
            with test.assertRaisesRegex(RuntimeError,'lifecycle is busy'):
                enroll(admin,database,manifest,journal,source)
        # Enable privately without resetting credentials. A lost provider reply
        # must reconcile the same identity instead of provisioning another one.
        class LostEnableReply:
            def __getattr__(self,name): return getattr(admin,name)
            def request(self,path,method='GET',*args,**kwargs):
                value = admin.request(path,method,*args,**kwargs)
                if path == prefix+'/'+result['subject'] and method == 'PUT':
                    raise RuntimeError('Simulated lost enable response')
                return value
        with test.assertRaisesRegex(RuntimeError,'lost enable response'):
            enroll(LostEnableReply(),database,manifest,journal,source,enable_private=True)
        enabled = enroll(admin,database,manifest,journal,source,enable_private=True)
        test.assertTrue(enabled['provider_sign_in_enabled'])
        test.assertEqual(enabled,enroll(admin,database,manifest,journal,source,enable_private=True))
        test.assertEqual(enabled['subject'],result['subject'])
        test.assertEqual(database.query('SELECT to_json(count(*)) FROM gtd.accounts;'),1)
        test.assertEqual(database.query("SELECT to_json(count(*)) FROM gtd.admin_events WHERE event='bound';"),1)
        test.assertEqual(admin.request(prefix+'/'+result['subject'])['attributes'],user['attributes'])
        test.assertIn('UPDATE_PASSWORD',admin.request(prefix+'/'+result['subject'])['requiredActions'])
        # Ordinary enrollment still must not disable/reset an enabled identity.
        with test.assertRaisesRegex(RuntimeError,'activated owner'):
            enroll(admin,database,manifest,journal,source)
        test.assertTrue(admin.request(prefix+'/'+result['subject'])['enabled'])
        user['enabled'] = False
        admin.request(prefix+'/'+result['subject'],'PUT',user)
        before = journal.read_bytes()
        generation = str(uuid.uuid4())
        database.query("UPDATE gtd.accounts SET credential_generation='"+generation+"'; SELECT to_json(true);")
        with test.assertRaisesRegex(RuntimeError,'mapping differs'):
            enroll(admin,database,manifest,journal,source)
        test.assertEqual(database.query('SELECT to_json(credential_generation) FROM gtd.accounts;'),generation)
        test.assertEqual(journal.read_bytes(),before)


if __name__ == '__main__': unittest.main()
