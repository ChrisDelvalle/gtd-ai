import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('gtd_install',ROOT/'deploy/gtd.py')
gtd=importlib.util.module_from_spec(spec);spec.loader.exec_module(gtd)

class Installation(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='gtd-install-config-');self.addCleanup(self.temp.cleanup)
        self.directory=Path(self.temp.name).resolve();self.path=self.directory/'installation.toml'
        self.source=(ROOT/'installation.example.toml').read_text().replace('/srv/gtd',str(self.directory/'state'))
        self.path.write_text(self.source)

    def test_valid_configuration_and_new_admin(self):
        value,root,layout=gtd.config(self.path)
        self.assertEqual(value['admin_username'],'owner');self.assertEqual(layout.environment,'production')
        self.assertFalse(root.exists())

    def test_malformed_input_creates_no_state(self):
        changes=[('production','invalid'),('/state', '/state with spaces'),('owner','../admin'),
                 ('America/New_York','Not/AZone'),('integrations = ["chatgpt", "claude"]','integrations = ["chatgpt", "chatgpt"]'),
                 ('tasks.example.com','auth.example.com'),('direct','none')]
        for old,new in changes:
            with self.subTest(new=new):
                self.path.write_text(self.source.replace(old,new))
                with self.assertRaises((ValueError,KeyError)):gtd.config(self.path)
                self.assertFalse((self.directory/'state').exists())

    def test_private_state_cannot_live_in_source(self):
        self.path.write_text(self.source.replace(str(self.directory/'state'),str(ROOT/'state')))
        with self.assertRaises(ValueError):gtd.config(self.path)

    def test_prepare_is_private_pinned_and_refuses_replacement(self):
        value,root,layout=gtd.config(self.path)
        with patch.object(gtd,'run',return_value='sha256:'+'a'*64),patch.object(gtd.os,'getuid',return_value=1000),patch.object(gtd.os,'getgid',return_value=1000):
            gtd.initialize(value,root,layout)
            before={str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()}
            with self.assertRaises(ValueError):gtd.initialize(value,root,layout)
        self.assertEqual(before,{str(p.relative_to(root)):p.read_bytes() for p in root.rglob('*') if p.is_file()})
        manifest=json.loads((root/'manifest.json').read_text());app=json.loads((root/'service/config.json').read_text())
        self.assertEqual(app['database_identity'],manifest['database_identity'])
        self.assertEqual(app['chatgpt_resource'],'https://chatgpt-mcp.example.com/mcp')
        self.assertFalse(manifest['application_enabled'])
        gtd.match_configuration(value,manifest)
        with self.assertRaises(ValueError):gtd.match_configuration({**value,'auth_host':'changed.example.com'},manifest)
        self.assertEqual((root/'operator/backup.secret').stat().st_mode&0o777,0o600)
        with self.assertRaises(ValueError):gtd.read_manifest(root,'incorrect')

    def test_direct_edge_uses_peer_and_tunnel_requires_local_proxy(self):
        value,_,layout=gtd.config(self.path);value['chatgpt_ranges']=['192.0.2.0/24']
        direct=gtd.ingress(value,layout)
        self.assertIn('remote_ip 192.0.2.0/24',direct);self.assertNotIn('trusted_proxies',direct)
        self.assertIn('respond @internal 404',direct);self.assertNotIn('/admin/',direct)
        tunnel=gtd.ingress({**value,'ingress':'tunnel'},layout)
        self.assertIn('http://127.0.0.1:20546',tunnel)
        self.assertIn('trusted_proxies static 127.0.0.1/32',tunnel)
        self.assertIn('client_ip 192.0.2.0/24',tunnel)

    def test_cidr_rejects_expansion_and_unsafe_directives(self):
        for ranges in ('["0.0.0.1/0"]','["192.0.2.0/24\\nadmin off"]'):
            self.path.write_text(self.source.replace('chatgpt_ranges = []','chatgpt_ranges = '+ranges))
            with self.assertRaises(ValueError):gtd.config(self.path)

if __name__=='__main__':unittest.main()

@unittest.skipUnless(__import__('os').environ.get('GTD_TEST_STAGING_CONFIG')=='1','Disposable built gateway check')
class GatewayConfiguration(Installation):
    def test_generated_gateway_routes_validate(self):
        import os,subprocess
        value,root,layout=gtd.config(self.path)
        image=os.environ['GTD_TEST_STAGING_GATEWAY_IMAGE']
        for mode in ('direct','tunnel'):
            candidate=self.directory/('Caddyfile-'+mode)
            candidate.write_text(gtd.ingress({**value,'ingress':mode},layout))
            result=subprocess.run(['docker','run','--rm','--network','none','--read-only',
                '--user',str(os.getuid() or 1000)+':'+str(os.getgid() or 1000),'--cap-drop','ALL',
                '--tmpfs','/data:mode=1777','--tmpfs','/tmp:mode=1777','--env','XDG_DATA_HOME=/data',
                '--mount','type=bind,src='+str(candidate)+',dst=/etc/caddy/Caddyfile,readonly',
                image,'caddy','adapt','--validate','--config','/etc/caddy/Caddyfile'],capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr.decode()[-1500:])
            config=json.loads(result.stdout)
            self.assertNotIn('admin/realms',json.dumps(config))
