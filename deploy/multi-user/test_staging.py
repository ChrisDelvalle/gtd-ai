"""Staging preparation tests; Docker checks are manual and use disposable data."""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile
import time
import unittest
import uuid

import staging


class Fixture:
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gtd-staging-config-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()/'stack'
        self.options = {'auth_host': 'auth-staging.example.invalid', 'mcp_host': 'mcp-staging.example.invalid',
            'website_host': 'todo-staging.example.invalid', 'service_image': 'sha256:'+'a'*64,
            'adapter_image': 'sha256:'+'b'*64, 'identity_image': 'sha256:'+'c'*64,
            'gateway_image': 'sha256:'+'d'*64,
            'uid': os.getuid() or 1000, 'gid': os.getgid() or 1000}
        if os.environ.get('GTD_TEST_STAGING_RUNTIME') == '1':
            for name in ('service', 'adapter', 'identity', 'gateway'):
                self.options[name+'_image'] = staging.image_id(os.environ['GTD_TEST_STAGING_'+name.upper()+'_IMAGE'])

    def prepare(self):
        return staging.prepare(self.root, **self.options)


class Preparation(Fixture, unittest.TestCase):
    def test_private_layout_and_exact_database_pin(self):
        manifest = self.prepare()
        service = json.loads((self.root/'service/config.json').read_text())
        adapter = json.loads((self.root/'adapter/config.json').read_text())
        compose = json.loads((self.root/'compose.json').read_text())
        self.assertEqual(service['database_identity'], manifest['database_identity'])
        self.assertIn(manifest['database_identity'], (self.root/'database/schema.sql').read_text())
        self.assertFalse(service['background'])
        self.assertEqual(adapter['issuer'], service['issuer'])
        self.assertEqual(adapter['resource'], service['resource'])
        self.assertEqual(compose['services']['adapter']['volumes'], [staging.mount(self.root/'adapter', '/config')])
        for name, component in compose['services'].items():
            self.assertNotIn('ports', component)
            self.assertNotIn('build', component)
            self.assertEqual(component['network_mode'], 'host')
            self.assertTrue(component['read_only'])
            self.assertNotIn(component['user'].split(':')[0], ('0', 'root'))
            if name in ('service', 'adapter'):
                self.assertEqual(component['profiles'], ['application'])
        for path in self.root.rglob('*'):
            expected = 0o700 if path.is_dir() else 0o600
            if path.name in ('init.sql', 'schema.sql'): expected = 0o644
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), expected, path.name)
        secrets = [line.split('=', 1)[1] for line in (self.root/'database/environment').read_text().splitlines()
                   if 'PASSWORD=' in line]
        public = json.dumps(manifest)+json.dumps(compose)+(self.root/'gateway/Caddyfile').read_text()
        for secret in secrets:
            self.assertNotIn(secret, public)
            self.assertNotIn(secret, json.dumps(adapter))

    def test_existing_configuration_and_secret_material_are_never_replaced(self):
        self.prepare()
        old = {p: p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with self.assertRaises(ValueError): self.prepare()
        for path, contents in old.items(): self.assertEqual(path.read_bytes(), contents)

    def test_guarded_inputs_fail_before_creating_files(self):
        for key, value in [('auth_host', 'auth-checkpoint.example.com'),
                           ('website_host', 'todo.example.com'), ('mcp_host', 'staging.invalid\nadmin off'),
                           ('mcp_host', self.options['auth_host']), ('identity_image', 'keycloak:latest'),
                           ('uid', 0), ('gid', 0)]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(ValueError): staging.prepare(self.root, **{**self.options, key: value})
                self.assertFalse(self.root.exists())
        for root in (Path('relative'), self.root.parent/'$OTHER', self.root.parent/'with space'):
            with self.assertRaises(ValueError): staging.prepare(root, **self.options)
        link = self.root.parent/'link'
        link.symlink_to(self.root.parent, target_is_directory=True)
        with self.assertRaises(ValueError): staging.prepare(link/'new', **self.options)


def fixture_cpuset(value):
    if value is None: return None
    if not re.fullmatch(r'[0-9]+(?:-[0-9]+)?',value):
        raise ValueError('Fixture CPU set must be one CPU or a contiguous range')
    first,_,last = value.partition('-')
    first,last = int(first),int(last or first)
    if not 0 <= first <= last < (os.cpu_count() or 1):
        raise ValueError('Fixture CPU set is outside this machine')
    return value


def docker(*arguments, timeout=30, input=None, env=None, check=True):
    cpuset = fixture_cpuset(os.environ.get('GTD_TEST_STAGING_CPUSET'))
    if arguments and arguments[0]=='run' and cpuset is not None:
        arguments = ('run','--cpuset-cpus',cpuset,*arguments[1:])
    result = subprocess.run(['docker', *arguments], input=input, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, env=env)
    if check and result.returncode:
        raise RuntimeError('Disposable staging command failed; no credentials printed')
    return result


class FixtureBounds(unittest.TestCase):
    def test_cpu_selection_is_explicit_and_in_range(self):
        self.assertIsNone(fixture_cpuset(None))
        self.assertEqual(fixture_cpuset('0'),'0')
        self.assertEqual(fixture_cpuset('0-'+str((os.cpu_count() or 1)-1)),
                         '0-'+str((os.cpu_count() or 1)-1))
        for value in ('','-1','2-1','0,1','0 --privileged',str(os.cpu_count() or 1)):
            with self.assertRaises(ValueError): fixture_cpuset(value)


def start_database(test, root, name, volume):
    from staging_acceptance import fixture_origins
    host_args = [part for host in fixture_origins(root) for part in ('--add-host', host+':127.0.0.1')]
    docker('volume', 'create', '--label', 'gtd.environment=disposable-staging-configuration', volume)
    docker('run', '--detach', '--pull', 'never', '--name', name, '--network', 'none',
        *host_args,
        '--label', 'gtd.environment=disposable-staging-configuration', '--user', '999:999', '--read-only',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '512m', '--cpus', '1', '--pids-limit', '128',
        '--mount', 'type=volume,src='+volume+',dst=/var/lib/postgresql',
        '--tmpfs', '/var/run/postgresql:rw,size=16m,uid=999,gid=999', '--tmpfs', '/tmp:rw,size=16m,uid=999,gid=999',
        '--env-file', str(root/'database/environment'),
        '--mount', 'type=bind,src='+str(root/'database/init.sql')+',dst=/docker-entrypoint-initdb.d/10-gtd.sql,readonly',
        '--mount', 'type=bind,src='+str(root/'database/schema.sql')+',dst=/bootstrap/schema.sql,readonly',
        staging.POSTGRES, 'postgres', '-c', 'listen_addresses=127.0.0.1', '-p', '19545')
    deadline = time.monotonic()+45
    while docker('exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '19545', '-U', 'postgres', check=False).returncode:
        if docker('inspect', '--format', '{{.State.Status}}', name).stdout.strip() != b'running':
            test.fail('Disposable database exited during bootstrap: '+test.private_diagnostic(name))
        if time.monotonic() >= deadline: test.fail('Disposable database did not become ready')
        time.sleep(.1)


def database_query(name):
    def query(sql, *, user='postgres', database='gtd_staging', password=None, check=True):
        command = ['exec', '-i']
        environment = None
        if password is not None:
            environment = {**os.environ, 'PGPASSWORD': password}
            command += ['--env', 'PGPASSWORD']
        command += [name, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-p', '19545', '-U', user, '-d', database]
        if password is not None: command += ['-h', '127.0.0.1']
        return docker(*command, input=sql.encode(), env=environment, check=check)
    return query


@unittest.skipUnless(os.environ.get('GTD_TEST_STAGING_CONFIG') == '1', 'Manual disposable Docker checks')
class DockerConfiguration(Fixture, unittest.TestCase):
    def private_diagnostic(self, name):
        result = docker('logs', '--tail', '30', name, check=False)
        text = (result.stdout+result.stderr).decode(errors='replace')
        # These fixtures have no user records/tokens; redact every generated
        # credential before attaching bounded startup diagnostics to a failure.
        for path in self.root.rglob('*'):
            if path.name == 'environment':
                for line in path.read_text().splitlines():
                    key, value = line.split('=', 1)
                    if 'PASSWORD' in key or 'KEY' in key:
                        text = text.replace(value, '[redacted]')
            elif path.suffix == '.secret':
                text = text.replace(path.read_text().strip(), '[redacted]')
        return text[-3500:]

    def test_compose_and_caddy_accept_generated_configuration(self):
        self.prepare()
        docker('compose', '-f', str(self.root/'compose.json'), '--profile', 'application', 'config', '--quiet')
        result = docker('run', '--rm', '--pull', 'never', '--network', 'none', '--read-only',
            '--user', str(os.getuid())+':'+str(os.getgid()),
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--pids-limit', '64',
            '--mount', 'type=bind,src='+str(self.root/'gateway/Caddyfile')+',dst=/etc/caddy/Caddyfile,readonly',
            staging.image_id(os.environ['GTD_TEST_STAGING_GATEWAY_IMAGE']), 'caddy', 'adapt', '--validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
        config = json.loads(result.stdout)
        servers = config['apps']['http']['servers']
        listeners = [address for server in servers.values() for address in server['listen']]
        self.assertCountEqual(listeners, ['127.0.0.1:19542', '127.0.0.1:19546'])

    def test_generated_bootstrap_installs_isolated_databases_and_rejects_wrong_roles(self):
        manifest = self.prepare()
        required = [staging.POSTGRES]
        if os.environ.get('GTD_TEST_STAGING_RUNTIME') == '1':
            from staging_acceptance import NODE
            required += [NODE, staging.MEILI, *(self.options[name+'_image']
                for name in ('identity','service','adapter','gateway'))]
        for image in required:
            self.assertEqual(docker('image','inspect',image,check=False).returncode,0,
                'Preload the exact pinned fixture image: '+image)
        authenticated = os.environ.get('GTD_TEST_STAGING_AUTH') == '1'
        if authenticated:
            self.assertEqual(os.environ.get('GTD_TEST_STAGING_RUNTIME'), '1')
            from staging_acceptance import prepare_https
            prepare_https(self.root)
        if os.environ.get('GTD_TEST_STAGING_WORKFLOWS') == '1':
            self.assertTrue(authenticated, 'Workflows require the real-provider fixture')
            path = self.root/'service/config.json'
            settings = json.loads(path.read_text())
            settings['background'] = True
            path.write_text(json.dumps(settings)+'\n')
        name = 'gtd-staging-bootstrap-'+uuid.uuid4().hex
        volume = name+'-data'
        # No host network or published ports in this deterministic fixture.
        # Read the same generated bootstrap files and secrets as the Linux stack.
        try:
            start_database(self, self.root, name, volume)
            query = database_query(name)
            state = json.loads(query("SELECT row_to_json(m) FROM gtd.schema_meta m").stdout)
            self.assertEqual(state['identity'], manifest['database_identity'])
            self.assertEqual(state['compatibility'], 13)
            self.assertEqual(state['environment'], 'staging')
            self.assertEqual(query('SELECT count(*) FROM gtd.accounts').stdout.strip(), b'0')
            self.assertEqual(query("SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='gtd' AND c.relname IN ('account_state','tasks','dependencies','changes','revisions','requests','action_groups','search_state','search_sessions','legacy_imports') AND c.relrowsecurity AND c.relforcerowsecurity").stdout.strip(), b'10')
            values = dict(line.split('=', 1) for line in (self.root/'database/environment').read_text().splitlines())
            runtime = values['GTD_RUNTIME_PASSWORD']
            self.assertEqual(query('SELECT count(*) FROM gtd.tasks', user='gtd_runtime', password=runtime).stdout.strip(), b'0')
            for sql in ('SELECT * FROM gtd.accounts', "SET ROLE gtd_owner", "CREATE TABLE gtd.bad(id int)"):
                self.assertNotEqual(query(sql, user='gtd_runtime', password=runtime, check=False).returncode, 0)
            self.assertNotEqual(query('SELECT 1', user='gtd_runtime', database='gtd_staging_identity', password=runtime, check=False).returncode, 0)
            self.assertNotEqual(query('SELECT 1', user='gtd_identity', password=values['GTD_IDENTITY_PASSWORD'], check=False).returncode, 0)
            self.assertNotEqual(query('SELECT 1', user='gtd_runtime', password='wrong-synthetic-password', check=False).returncode, 0)
            docker('restart', name)
            deadline = time.monotonic()+15
            while docker('exec', name, 'pg_isready', '-q', '-h', '127.0.0.1', '-p', '19545', '-U', 'postgres', check=False).returncode:
                if time.monotonic() >= deadline: self.fail('Disposable database did not restart')
                time.sleep(.1)
            self.assertEqual(json.loads(query('SELECT row_to_json(m) FROM gtd.schema_meta m').stdout), state)
            self.assertEqual(query('SELECT count(*) FROM gtd.tasks', user='gtd_runtime', password=runtime).stdout.strip(), b'0')
            if os.environ.get('GTD_TEST_STAGING_RUNTIME') == '1':
                self.check_runtime(name, query, manifest, authenticated=authenticated)
        finally:
            docker('rm', '--force', name, check=False)
            docker('volume', 'rm', volume, check=False)

    def check_runtime(self, database, query, manifest, *, authenticated=False, recovery_check=None):
        """Same generated commands, secrets and mounts, in a networkless namespace.

        Authentication is an explicit additional manual fixture; otherwise this
        proves packaged startup/unauthorized boundaries without realm/user setup.
        Neither mode proves actual hosted tunnel acceptance.
        """
        compose = json.loads((self.root/'compose.json').read_text())
        from staging_acceptance import fixture_origins
        auth_host, mcp_host, website_host = fixture_origins(self.root)
        running = []
        components = {'database': database}
        node = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
        script = '''import http from 'node:http';
            const chunks=[];for await(const part of process.stdin) chunks.push(part);
            const {port,path,host}=JSON.parse(Buffer.concat(chunks));
            const req=http.get({host:'127.0.0.1',port,path,headers:{Host:host??'127.0.0.1:'+port}},res=>{
                let size=0;const parts=[];res.on('data',c=>{size+=c.length;if(size>262144){req.destroy();process.exit(2)}parts.push(c)});
                res.on('end',()=>process.stdout.write(JSON.stringify({status:res.statusCode,headers:res.headers,body:Buffer.concat(parts).toString()})));
            });req.setTimeout(2000,()=>req.destroy());req.on('error',()=>process.exit(1));'''
        def http(port, path, host=None):
            value = docker('run', '--rm', '--pull', 'never', '--interactive', '--network', 'container:'+database,
                '--read-only', '--user', '1000:1000', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
                '--memory', '128m', '--cpus', '1', '--pids-limit', '64', node, 'node', '--input-type=module', '-e', script,
                input=json.dumps({'port': port, 'path': path, 'host': host}).encode(), check=False)
            return json.loads(value.stdout) if value.returncode == 0 else None
        def ready(name, port, path):
            deadline = time.monotonic()+100
            while time.monotonic() < deadline:
                value = http(port, path)
                if value is not None and value['status'] == 200: return value
                if docker('inspect', '--format', '{{.State.Status}}', name).stdout.strip() != b'running':
                    self.fail('Disposable '+name+' exited: '+self.private_diagnostic(name))
                time.sleep(.2)
            self.fail('Disposable '+name+' did not become ready: '+self.private_diagnostic(name))
        try:
            for key in ('identity', 'search', 'service', 'adapter', 'gateway'):
                component = compose['services'][key]
                name = 'gtd-staging-'+key+'-'+uuid.uuid4().hex
                running.append(name)
                components[key] = name
                command = ['run', '--detach', '--pull', 'never', '--name', name,
                    '--label', 'gtd.environment=disposable-staging-runtime', '--network', 'container:'+database,
                    '--read-only', '--user', component['user'], '--cap-drop', 'ALL',
                    '--security-opt', 'no-new-privileges:true', '--memory', component['mem_limit'], '--cpus', component['cpus'],
                    '--pids-limit', str(component['pids_limit'])]
                for temporary in component['tmpfs']: command += ['--tmpfs', temporary]
                if 'working_dir' in component: command += ['--workdir', component['working_dir']]
                for env_file in component.get('env_file', []): command += ['--env-file', env_file]
                for key_, value in component.get('environment', {}).items(): command += ['--env', key_+'='+value]
                if key == 'service' and os.environ.get('GTD_TEST_STAGING_WORKFLOWS') == '1':
                    command += ['--env', 'GTD_STAGING_WORKER_TIMINGS=1']
                for volume in component.get('volumes', []):
                    assert volume['type'] == 'bind'
                    command += ['--mount', 'type=bind,src='+volume['source']+',dst='+volume['target']+(',readonly' if volume['read_only'] else '')]
                command += [component['image'], *component.get('command', [])]
                docker(*command)
                if key == 'identity': ready(name, 19543, '/realms/master/.well-known/openid-configuration')
                elif key == 'search': ready(name, 19547, '/health')
                elif key == 'service': ready(name, 19541, '/internal/ready')
                elif key == 'adapter': ready(name, 19544, '/.well-known/oauth-protected-resource/mcp')
            checks = [
                (19542, '/', website_host, 200),
                (19542, '/internal/contract', website_host, 404),
                (19542, '/', 'unrecognized.invalid', 404),
                (19546, '/admin/realms', auth_host, 404),
                (19546, '/realms/master/.well-known/openid-configuration', auth_host, 404),
                (19546, '/.well-known/oauth-protected-resource/mcp', mcp_host, 200),
                (19546, '/mcp', mcp_host, 403),
                (19544, '/mcp', None, 401),
                (19544, '/internal/contract', None, 404),
            ]
            for port, path, host, status in checks:
                result = http(port, path, host)
                self.assertIsNotNone(result, path)
                self.assertEqual(result['status'], status, path)
            self.assertEqual(json.loads(http(19544, '/.well-known/oauth-protected-resource/mcp')['body'])['resource'], manifest['resource'])
            if recovery_check is not None:
                recovery_check(components)
            elif authenticated:
                from staging_acceptance import run
                checks = run(self, docker, database, self.root, query, manifest, components=components)
                evidence = os.environ.get('GTD_TEST_STAGING_AUTH_EVIDENCE')
                if evidence:
                    Path(evidence).write_text(json.dumps({'checks': checks, 'environment': 'disposable-local',
                        'service_image': self.options['service_image'], 'provider_image': self.options['identity_image'],
                        'model_calls': 0, 'host_checks': False}, indent=2)+'\n')
        finally:
            for name in reversed(running): docker('rm', '--force', name, check=False)


if __name__ == '__main__':
    unittest.main()
