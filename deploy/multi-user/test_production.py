"""Production configuration checks using fresh files and networkless containers.

The manual checks use the production *layout*, never deployed production data,
credentials, host networking, published ports, ingress or model calls.
"""
import io
import json
import os
from pathlib import Path
import time
import unittest
import urllib.error
import uuid

import production
import test_staging
from stack_config import PRODUCTION, STAGING, POSTGRES, ROOT
from test_staging import Fixture, docker
from realm_bootstrap import configure, configure_production


class ProductionFixture(Fixture):
    def setUp(self):
        super().setUp()
        self.options.update(auth_host='auth.example.invalid', mcp_host='mcp.example.invalid',
                            website_host='todo.example.invalid')
        if os.environ.get('GTD_TEST_PRODUCTION_CONFIG') == '1':
            from stack_config import image_id
            for name in ('service', 'adapter', 'identity', 'gateway'):
                self.options[name+'_image'] = image_id(os.environ['GTD_TEST_PRODUCTION_'+name.upper()+'_IMAGE'])

    def prepare(self):
        return production.prepare(self.root, **self.options)


class Preparation(ProductionFixture, unittest.TestCase):
    test_private_layout_and_exact_database_pin = test_staging.Preparation.test_private_layout_and_exact_database_pin
    test_existing_configuration_and_secret_material_are_never_replaced = test_staging.Preparation.test_existing_configuration_and_secret_material_are_never_replaced

    def test_environments_cannot_share_storage_ports_or_identity(self):
        manifest = self.prepare()
        self.assertEqual(manifest['environment'], 'production')
        self.assertEqual(manifest['realm'], 'gtd')
        self.assertFalse(manifest['application_enabled'])
        self.assertFalse(manifest['ingress_published'])
        self.assertTrue(set(PRODUCTION.ports.values()).isdisjoint(STAGING.ports.values()))
        self.assertNotEqual(PRODUCTION.project, STAGING.project)
        schema = (self.root/'database/schema.sql').read_text()
        self.assertIn("VALUES(true,13,'production',", schema)
        bootstrap = (self.root/'database/init.sql').read_text()
        self.assertIn('CREATE DATABASE gtd_production ', bootstrap)
        self.assertIn('CREATE DATABASE gtd_production_identity ', bootstrap)
        service = json.loads((self.root/'service/config.json').read_text())
        self.assertEqual(service['website']['client_id'], 'gtd-website')
        self.assertEqual(service['website']['oauth_clients'], ['gtd-website','gtd-chatgpt','gtd-claude'])
        for path in self.root.rglob('*'):
            if path.is_file(): self.assertNotIn('gtd-staging', path.read_text().replace(str(self.root),'<candidate>'))

    def test_invalid_inputs_fail_before_creating_a_candidate(self):
        for key, value in (
            ('auth_host','auth-staging.example.invalid'), ('mcp_host','mcp-checkpoint.example.com'),
            ('website_host','todo-test.example.invalid'), ('website_host',self.options['auth_host']),
            ('mcp_host','example.invalid\nadmin off'), ('adapter_image','adapter:latest'),
            ('uid',0), ('gid',False), ('uid',True)):
            with self.subTest(field=key, value=value):
                with self.assertRaises(ValueError): production.prepare(self.root, **{**self.options,key:value})
                self.assertFalse(self.root.exists())
        with self.assertRaises(TypeError): production.prepare(self.root, layout=STAGING, **self.options)
        self.assertFalse(self.root.exists())


# Requests are confined by both a fixed loopback origin and network:none. This is
# protocol traffic to our own disposable provider, not browser automation.
HTTP = r'''
import http from 'node:http';
const chunks=[]; for await (const part of process.stdin) chunks.push(part);
try {
  const input=JSON.parse(Buffer.concat(chunks)); const url=new URL(input.url);
  if(url.origin!=='http://127.0.0.1:20543'||url.username||url.password||url.hash) throw Error();
  const result=await new Promise((resolve,reject)=>{
    const req=http.request(url,{method:input.method,headers:input.headers},res=>{
      const parts=[]; let size=0;
      res.on('data',c=>{size+=c.length;if(size>262144)req.destroy(Error());else parts.push(c)});
      res.on('error',reject);
      res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(parts).toString()}));
    });
    req.setTimeout(5000,()=>req.destroy(Error()));req.on('error',reject);req.end(input.body);
  });process.stdout.write(JSON.stringify(result));
}catch{process.exitCode=1;}
'''


class PrivateProviderTransport:
    def __init__(self, container): self.container = container

    def open(self, request, timeout):
        result = docker('exec','-i',self.container,'node','--input-type=module','-e',HTTP,
            input=json.dumps({'url':request.full_url,'method':request.method,
                'headers':dict(request.header_items()),'body':request.data.decode() if request.data else None}).encode())
        response = json.loads(result.stdout)
        if not 200 <= response['status'] < 300:
            raise urllib.error.HTTPError(request.full_url,response['status'],'Disposable provider error',{},None)
        return io.BytesIO(response['body'].encode())


@unittest.skipUnless(os.environ.get('GTD_TEST_PRODUCTION_CONFIG') == '1', 'Manual disposable Docker checks')
class DockerConfiguration(ProductionFixture, unittest.TestCase):
    def test_compose_and_caddy_accept_fixed_production_ports(self):
        self.prepare()
        docker('compose','-f',str(self.root/'compose.json'),'--profile','application','config','--quiet')
        result = docker('run','--rm','--pull','never','--network','none','--read-only',
            '--user',str(os.getuid())+':'+str(os.getgid()),
            '--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','128m','--pids-limit','64',
            '--mount','type=bind,src='+str(self.root/'gateway/Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly',
            self.options['gateway_image'],'caddy','adapt','--validate','--config','/etc/caddy/Caddyfile','--adapter','caddyfile')
        servers = json.loads(result.stdout)['apps']['http']['servers']
        self.assertCountEqual([a for s in servers.values() for a in s['listen']],
                              ['127.0.0.1:20542','127.0.0.1:20546'])

    def test_generated_databases_and_provider_policy_are_isolated(self):
        import sys
        sys.path.insert(0,str(ROOT/'deploy/backups'))
        from recovery_ops import ProviderRecovery
        from staging_acceptance import NODE
        manifest = self.prepare()
        name = 'gtd-production-config-fixture-'+uuid.uuid4().hex
        volume, identity, transport = name+'-data', name+'-identity', name+'-http'
        for image in (POSTGRES, NODE, self.options['identity_image']):
            self.assertEqual(docker('image','inspect',image,check=False).returncode,0,'Preload the pinned fixture image')
        def query(sql, *, user='postgres', database='gtd_production', password=None, check=True):
            command = ['exec','-i']
            env = None
            if password is not None:
                env = {**os.environ,'PGPASSWORD':password}; command += ['--env','PGPASSWORD']
            command += [name,'psql','-X','-qAt','-v','ON_ERROR_STOP=1','-p','20545','-U',user,'-d',database]
            if password is not None: command += ['-h','127.0.0.1']
            return docker(*command,input=sql.encode(),env=env,check=check)
        try:
            docker('volume','create','--label','gtd.environment=disposable-configuration',volume)
            docker('run','--detach','--pull','never','--name',name,'--network','none','--user','999:999',
                '--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--memory','512m',
                '--cpus','1','--pids-limit','128','--mount','type=volume,src='+volume+',dst=/var/lib/postgresql',
                '--tmpfs','/var/run/postgresql:rw,size=16m,uid=999,gid=999','--tmpfs','/tmp:rw,size=16m,uid=999,gid=999',
                '--env-file',str(self.root/'database/environment'),
                '--mount','type=bind,src='+str(self.root/'database/init.sql')+',dst=/docker-entrypoint-initdb.d/10-gtd.sql,readonly',
                '--mount','type=bind,src='+str(self.root/'database/schema.sql')+',dst=/bootstrap/schema.sql,readonly',
                POSTGRES,'postgres','-c','listen_addresses=127.0.0.1','-p','20545')
            deadline = time.monotonic()+45
            while docker('exec',name,'pg_isready','-q','-h','127.0.0.1','-p','20545','-U','postgres',check=False).returncode:
                if time.monotonic() >= deadline: self.fail('Disposable database startup timed out')
                time.sleep(.2)
            self.assertEqual(docker('inspect','--format','{{.HostConfig.NetworkMode}}',name).stdout.strip(),b'none')
            meta = json.loads(query('SELECT row_to_json(m) FROM gtd.schema_meta m').stdout)
            self.assertEqual(meta['environment'],'production')
            self.assertEqual(meta['identity'],manifest['database_identity'])
            self.assertEqual(meta['compatibility'],13)
            self.assertEqual(query('SELECT count(*) FROM gtd.accounts').stdout.strip(),b'0')
            self.assertEqual(query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gtd' AND c.relname IN ('account_state','tasks','dependencies','changes','revisions','requests','action_groups','search_state','search_sessions','legacy_imports') AND c.relrowsecurity AND c.relforcerowsecurity").stdout.strip(),b'10')
            passwords = dict(line.split('=',1) for line in (self.root/'database/environment').read_text().splitlines())
            runtime = passwords['GTD_RUNTIME_PASSWORD']
            self.assertEqual(query('SELECT count(*) FROM gtd.tasks',user='gtd_runtime',password=runtime).stdout.strip(),b'0')
            for sql in ('SET ROLE gtd_owner','SELECT * FROM gtd.accounts','CREATE TABLE gtd.bad(id int)'):
                self.assertNotEqual(query(sql,user='gtd_runtime',password=runtime,check=False).returncode,0)
            self.assertNotEqual(query('SELECT 1',user='gtd_runtime',database='gtd_production_identity',password=runtime,check=False).returncode,0)
            self.assertNotEqual(query('SELECT 1',user='gtd_identity',password=passwords['GTD_IDENTITY_PASSWORD'],check=False).returncode,0)

            component = json.loads((self.root/'compose.json').read_text())['services']['identity']
            command = ['run','--detach','--pull','never','--name',identity,'--network','container:'+name,
                '--read-only','--user',component['user'],'--cap-drop','ALL','--security-opt','no-new-privileges:true',
                '--memory',component['mem_limit'],'--cpus','2','--pids-limit','256',
                '--env-file',str(self.root/'identity/environment')]
            for temporary in component['tmpfs']: command += ['--tmpfs',temporary]
            docker(*command,component['image'],*component['command'])
            docker('run','--detach','--pull','never','--name',transport,'--network','container:'+name,
                '--read-only','--user','1000:1000','--cap-drop','ALL','--security-opt','no-new-privileges:true',
                '--memory','128m','--pids-limit','64',NODE,'node','-e','setInterval(()=>{},1000)')
            clients = tuple(PRODUCTION.client_id(r) for r in ('website','chatgpt','claude'))
            admin = ProviderRecovery('http://127.0.0.1:20543','gtd',manifest['issuer'],
                'admin-cli','unused',clients,time.monotonic()+180)
            admin.opener = PrivateProviderTransport(transport)
            deadline = time.monotonic()+90
            while True:
                try:
                    admin.request('/realms/master/.well-known/openid-configuration',authenticated=False)
                    break
                except RuntimeError:
                    if time.monotonic() >= deadline: self.fail('Disposable provider startup timed out')
                    time.sleep(.5)
            values = dict(line.split('=',1) for line in (self.root/'identity/environment').read_text().splitlines())
            token = admin.request('/realms/master/protocol/openid-connect/token','POST',{
                'grant_type':'password','client_id':'admin-cli','username':values['KC_BOOTSTRAP_ADMIN_USERNAME'],
                'password':values['KC_BOOTSTRAP_ADMIN_PASSWORD']},form=True,authenticated=False)
            admin.token, admin.expires = token['access_token'], time.monotonic()+token['expires_in']-5
            credentials = [(self.root/'service'/n).read_text().strip() for n in ('website.secret','administration.secret')]
            with self.assertRaises(RuntimeError): configure(admin,manifest,*credentials)
            result = configure_production(admin,manifest,*credentials)
            self.assertEqual(result,configure_production(admin,manifest,*credentials))
            self.assertEqual(result['accounts_created'],0)
            observed = admin.request('/admin/realms/gtd')
            self.assertEqual(observed['attributes']['gtd_production_database'],manifest['database_identity'])
            self.assertFalse(observed['registrationAllowed'])
            self.assertEqual(observed['displayName'],'GTD')
            self.assertIsNone(admin.request('/admin/realms/gtd-staging',missing=True))
            users = admin.request('/admin/realms/gtd/users')
            self.assertTrue(all(u.get('serviceAccountClientId') for u in users),'No human identity is enrolled')
            with self.assertRaises(RuntimeError):
                configure_production(admin,{**manifest,'database_identity':str(uuid.uuid4())},*credentials)
            self.assertEqual(query('SELECT count(*) FROM gtd.accounts').stdout.strip(),b'0')
            if os.environ.get('GTD_TEST_PRODUCTION_OWNER') == '1':
                from postgres_bundle import Session
                from test_owner_enrollment import check_provider_and_database
                check_provider_and_database(self,admin,
                    lambda: Session(name,'gtd_production',time.monotonic()+120,port=20545),
                    manifest,self.root/'operator/owner.json')
            observed['registrationAllowed'] = True
            admin.request('/admin/realms/gtd','PUT',observed)
            with self.assertRaises(RuntimeError): configure_production(admin,manifest,*credentials)
        finally:
            for container in (transport,identity,name): docker('rm','--force',container,check=False)
            docker('volume','rm',volume,check=False)


if __name__ == '__main__': unittest.main()
