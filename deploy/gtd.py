#!/usr/bin/env python3
"""Explicit local installation operations. Never discovers a remote deployment."""
import argparse
import contextlib
import hashlib
import socket
import urllib.request
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import tomllib
import uuid
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT/'deploy/multi-user'), str(ROOT/'deploy/backups')]
from stack_config import STAGING, PRODUCTION, prepare, hostname, write_json, write
from realm_bootstrap import configure, configure_production
from owner_enrollment import prepare_owner
from operator_identity import private_read, load_operator, replace_bootstrap, connect
from postgres_bundle import Session
from recovery_ops import ProviderRecovery
from gtd_backup import atomic_json, lock

VERSION = tomllib.loads((ROOT/'Cargo.toml').read_text())['package']['version']
IMAGES = {name: 'gtd-'+name+':'+VERSION for name in ('service','adapter','operator','identity','gateway')}


def config(path):
    value = tomllib.loads(Path(path).read_text())
    required = {'state_dir','environment','website_host','auth_host','mcp_host','admin_username','timezone','integrations','ingress'}
    allowed = required | {'chatgpt_host','claude_ranges','chatgpt_ranges'}
    if set(value)-allowed or required-set(value):
        raise ValueError('Installation has missing or unknown fields; compare installation.example.toml')
    if value['environment'] not in ('staging','production'):
        raise ValueError('Invalid environment')
    layout = STAGING if value['environment']=='staging' else PRODUCTION
    root = Path(value['state_dir'])
    if not root.is_absolute() or root != root.resolve() or re.search(r'[\s$]',str(root)) or root==ROOT or ROOT in root.parents:
        raise ValueError('State must use a canonical absolute directory outside the source checkout, without spaces')
    if not re.fullmatch(r'[a-z][a-z0-9._-]{0,63}',value['admin_username']):
        raise ValueError('Invalid administrator username')
    ZoneInfo(value['timezone'])
    if not isinstance(value['integrations'],list) or len(set(value['integrations']))!=len(value['integrations']) or set(value['integrations'])-{'chatgpt','claude'}:
        raise ValueError('Integrations must be a distinct list of chatgpt and/or claude')
    if value['ingress'] not in ('direct','tunnel'):
        raise ValueError('Ingress must be direct or tunnel')
    names = [hostname(value[k],layout) for k in ('website_host','auth_host','mcp_host')]
    if 'chatgpt' in value['integrations']:
        names.append(hostname(value.get('chatgpt_host'),layout))
    if len(set(names))!=len(names): raise ValueError('Each service requires a distinct hostname')
    for key in ('claude_ranges','chatgpt_ranges'):
        value[key] = value.get(key,[])
        if not isinstance(value[key],list) or len(value[key])>256: raise ValueError('Invalid source ranges')
        value[key] = [str(ipaddress.ip_network(c,strict=True)) for c in value[key]]
    return value,root,layout


def settings(value):
    return {key: item for key, item in value.items() if key != 'state_dir'}


def match_configuration(value, manifest):
    if settings(value) != manifest.get('installation'):
        raise ValueError('Configuration differs from prepared state; restore the original settings before operating this installation')


def run(*args, timeout=180, input=None):
    result = subprocess.run(list(args),capture_output=True,timeout=timeout,input=input)
    if result.returncode:
        # Provider credentials and configuration may appear in a tool's diagnostics.
        raise RuntimeError(Path(str(args[0])).name+' failed; inspect the local operation privately')
    return result.stdout.decode()


def compose(root,*args):
    return run('docker','compose','-f',str(root/'compose.json'),*args)


def read_manifest(root,expected=None):
    manifest = private_read(root/'manifest.json',max_bytes=65536)
    if expected is not None and manifest['database_identity']!=expected:
        raise ValueError('Database identity does not match --expected-database')
    return manifest


def mcp_route(host,port,ranges):
    guard = '\n            remote_ip '+ ' '.join(ranges) if ranges else ''
    return f'''    @{hashlib.sha256(host.encode()).hexdigest()[:12]} host {host}
    handle @{hashlib.sha256(host.encode()).hexdigest()[:12]} {{
        @metadata {{
            method GET
            path /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp
        }}
        handle @metadata {{
            reverse_proxy 127.0.0.1:{port}
        }}
        @allowed {{
            path /mcp{guard}
        }}
        handle @allowed {{
            reverse_proxy 127.0.0.1:{port}
        }}
        respond 403
    }}
'''


def ingress(value,layout):
    # Direct TLS trusts the actual peer, not client-supplied forwarding headers.
    # Tunnel mode uses only CF-Connecting-IP from the explicitly local connector.
    common = '''    header Cache-Control "no-store"
    header X-Content-Type-Options "nosniff"
    request_body {\n        max_size 4MB\n    }
'''
    auth = f'''    @identity host {value['auth_host']}
    handle @identity {{
        @discovery path /.well-known/oauth-authorization-server/realms/{layout.realm}
        rewrite @discovery /realms/{layout.realm}/.well-known/openid-configuration
        @browser path /realms/{layout.realm}/.well-known/* /realms/{layout.realm}/protocol/openid-connect/* /realms/{layout.realm}/login-actions/* /realms/{layout.realm}/account /realms/{layout.realm}/account/* /resources/*
        handle @browser {{
            reverse_proxy 127.0.0.1:{layout.ports['identity']} {{
                header_up -Forwarded
                header_up -X-Forwarded-Prefix
                header_up X-Forwarded-Proto https
                header_up X-Forwarded-Host {value['auth_host']}
                header_up X-Forwarded-Port 443
            }}
        }}
        respond 404
    }}
'''
    web = f'''    @website host {value['website_host']}
    handle @website {{
        @internal path /internal /internal/*
        respond @internal 404
        reverse_proxy 127.0.0.1:{layout.ports['service']}
    }}
'''
    routes = ''
    if 'claude' in value['integrations']:
        routes += mcp_route(value['mcp_host'],layout.ports['adapter'],value['claude_ranges'])
    if 'chatgpt' in value['integrations']:
        routes += mcp_route(value['chatgpt_host'],layout.ports['adapter'],value['chatgpt_ranges'])
    if value['ingress']=='tunnel':
        routes=routes.replace('remote_ip ','client_ip ')
        return '''{\n    admin off\n    persist_config off\n    auto_https off\n    servers {\n        trusted_proxies static 127.0.0.1/32\n        client_ip_headers CF-Connecting-IP\n        trusted_proxies_strict\n    }\n}\n'''+f'http://127.0.0.1:{layout.ports["public_gateway"]} {{\n'+common+auth+web+routes+'    respond 404\n}\n'
    hosts=[value['website_host'],value['auth_host']]
    if 'claude' in value['integrations']:hosts.append(value['mcp_host'])
    if 'chatgpt' in value['integrations']:hosts.append(value['chatgpt_host'])
    return '{\n    admin off\n    persist_config off\n}\n'+', '.join(hosts)+' {\n'+common+auth+web+routes+'    respond 404\n}\n'


def initialize(value,root,layout):
    if root.exists(): raise ValueError('State already exists; refusing to overwrite it')
    if not root.parent.is_dir(): raise ValueError('Create the parent state directory first')
    uid,gid=os.getuid(),os.getgid()
    if not uid or not gid: raise ValueError('Run setup as a dedicated non-root deployment user')
    images={name:run('docker','image','inspect','--format','{{.Id}}',tag).strip() for name,tag in IMAGES.items()}
    manifest=prepare(root,layout=layout,auth_host=value['auth_host'],mcp_host=value['mcp_host'],website_host=value['website_host'],
        **{name+'_image':images[name] for name in ('service','adapter','identity','gateway')},uid=uid,gid=gid)
    manifest.update(initial_admin=value['admin_username'],timezone=value['timezone'],integrations=value['integrations'],
        installation=settings(value),enrollment_id=str(uuid.uuid4()),ingress=value['ingress'],project=layout.project+'-'+manifest['database_identity'][:8])
    app=private_read(root/'service/config.json');adapter=private_read(root/'adapter/config.json')
    adapter['ingresses']=[]
    if 'claude' in value['integrations']:
        adapter['ingresses'].append({'host':value['mcp_host'],'metadataOrigin':'https://'+value['mcp_host'],'uiHost':'claude'})
    if 'chatgpt' in value['integrations']:
        resource='https://'+value['chatgpt_host']+'/mcp'
        manifest['chatgpt_resource']=app['chatgpt_resource']=resource
        adapter['ingresses'].append({'host':value['chatgpt_host'],'metadataOrigin':'https://'+value['chatgpt_host'],'resource':resource,'uiHost':'openai','launchMode':'deferred'})
    if not adapter['ingresses']:
        adapter['ingresses']=[{'host':value['mcp_host'],'metadataOrigin':'https://'+value['mcp_host'],'uiHost':'claude'}]
    atomic_json(root/'service/config.json',app);atomic_json(root/'adapter/config.json',adapter)
    (root/'gateway/Caddyfile').write_text(ingress(value,layout))
    stack=private_read(root/'compose.json',max_bytes=65536)
    stack['name']=manifest['project']
    if value['ingress']=='direct':
        stack['services']['gateway']['cap_add']=['NET_BIND_SERVICE']
        stack['services']['gateway']['user']='0:0' # Only the TLS edge needs privileged host ports.
    stack['services']['gateway']['environment']={'XDG_DATA_HOME':'/data','XDG_CONFIG_HOME':'/tmp'}
    (root/'gateway/data').mkdir(mode=0o700)
    stack['services']['gateway']['volumes'].append({'type':'bind','source':str(root/'gateway/data'),'target':'/data'})
    atomic_json(root/'compose.json',stack);atomic_json(root/'manifest.json',manifest)
    write(root/'operator/backup.secret',secrets.token_urlsafe(48)+'\n')
    print('Prepared new installation. Database identity: '+manifest['database_identity'])


def provider(root,manifest,layout):
    admin=ProviderRecovery('http://127.0.0.1:'+str(layout.ports['identity']),layout.realm,manifest['issuer'],'admin-cli','unused',
        tuple(layout.client_id(role) for role in ('website','chatgpt','claude')),time.monotonic()+180)
    journal=root/'operator/identity.json'
    if journal.exists():
        state=private_read(journal)
        if state.get('completed'): return load_operator(admin,manifest,journal)
        if state.get('client_uuid'):
            candidate=connect(admin,state)
            try:
                candidate.request('/admin/realms/master')
                return candidate
            except RuntimeError: pass
    values=dict(line.split('=',1) for line in (root/'identity/environment').read_text().splitlines())
    token=admin.request('/realms/master/protocol/openid-connect/token','POST',{'grant_type':'password','client_id':'admin-cli',
        'username':values['KC_BOOTSTRAP_ADMIN_USERNAME'],'password':values['KC_BOOTSTRAP_ADMIN_PASSWORD']},form=True,authenticated=False)
    admin.token,admin.expires=token['access_token'],time.monotonic()+token['expires_in']-5
    return admin


def bootstrap(root,layout,expected):
    manifest=read_manifest(root,expected)
    if manifest.get('enrolled'):
        print('Administrator enrollment is already complete; no credentials changed');return
    if manifest.get('application_enabled'): raise ValueError('Installation is already active; use Users for account changes')
    compose(root,'up','-d','database','identity')
    deadline=time.monotonic()+120
    while True:
        try: admin=provider(root,manifest,layout);break
        except (RuntimeError,OSError):
            if time.monotonic()>deadline: raise RuntimeError('Identity provider did not become ready') from None
            time.sleep(1)
    configure_realm=configure if layout==STAGING else configure_production
    configure_realm(admin,manifest,*[(root/'service'/name).read_text().strip() for name in ('website.secret','administration.secret')])
    with Session(manifest.get('project',layout.project)+'-database-1',layout.database,time.monotonic()+120,port=layout.ports['database']) as database:
        prepare_owner(admin,database,manifest,root/'operator/owner.json',manifest['enrollment_id'],enable_private=True,
            username=manifest['initial_admin'],timezone=manifest['timezone'])
    journal=root/'operator/identity.json'
    if journal.exists() and not private_read(journal).get('completed'):
        replace_bootstrap(admin,manifest,journal,private_read(journal)['bootstrap_subject'])
    elif not journal.exists():
        values=dict(line.split('=',1) for line in (root/'identity/environment').read_text().splitlines())
        users=admin.request('/admin/realms/master/users?username='+values['KC_BOOTSTRAP_ADMIN_USERNAME']+'&exact=true')
        if len(users)!=1: raise RuntimeError('Bootstrap identity is ambiguous')
        replace_bootstrap(admin,manifest,root/'operator/identity.json',users[0]['id'])
    environment=root/'identity/environment'
    environment.write_text('\n'.join(l for l in environment.read_text().splitlines() if not l.startswith('KC_BOOTSTRAP_'))+'\n')
    compose(root,'up','-d','--force-recreate','identity')
    manifest['enrolled']=True;atomic_json(root/'manifest.json',manifest)
    print('Administrator enrolled. Run login once in a private terminal to see the temporary password.')


def backup_config(root,manifest,layout):
    files={}
    for name,rel in {'manifest':'manifest.json','compose':'compose.json','database_environment':'database/environment',
        'database_init':'database/init.sql','database_schema':'database/schema.sql','identity_environment':'identity/environment',
        'service_config':'service/config.json','runtime_dsn':'service/runtime.dsn','website_secret':'service/website.secret',
        'administration_secret':'service/administration.secret','search_secret':'service/search.secret','search_environment':'search/environment',
        'adapter_config':'adapter/config.json','gateway':'gateway/Caddyfile','operator':'operator/identity.json'}.items():
        path=root/rel
        # Bootstrap SQL is public by design; capture a private copy for bounded recovery.
        if path.stat().st_mode & 0o077:
            dest=root/'operator'/('backup-'+name);dest.write_bytes(path.read_bytes());dest.chmod(0o600);path=dest
        files[name]=str(path)
    return {'application_container':manifest.get('project',layout.project)+'-database-1','identity_container':manifest.get('project',layout.project)+'-database-1',
        'application_database':layout.database,'identity_database':layout.identity_database,'application_port':layout.ports['database'],
        'identity_port':layout.ports['database'],'database_identity':manifest['database_identity'],'environment':manifest['environment'],
        'issuer':manifest['issuer'],'realm':manifest['realm'],'application_version':VERSION,'application_image':manifest['images']['service'],
        'identity_image':manifest['images']['identity'],'recovery_files':files}


def backup(root,manifest,layout,repository):
    import tempfile
    from postgres_bundle import capture,verify
    if not repository: raise ValueError('--repository is required')
    password=root/'operator/backup.secret'
    if not password.is_file(): raise ValueError('Backup encryption key is missing')
    with tempfile.TemporaryDirectory(prefix='gtd-backup-') as temporary:
        payload=Path(temporary)/'payload'
        deadline=time.monotonic()+600
        capture(backup_config(root,manifest,layout),payload,deadline)
        verify(payload,deadline)
        result=run('restic','-r',repository,'--password-file',str(password),'backup',str(payload),'--tag','gtd-verified','--json',timeout=600)
        summaries=[json.loads(line) for line in result.splitlines() if line.strip()]
        snapshot=next((v.get('snapshot_id') for v in reversed(summaries) if v.get('message_type')=='summary'),None)
        if not isinstance(snapshot,str) or not re.fullmatch('[a-f0-9]{64}',snapshot):raise RuntimeError('Backup did not return an exact recovery snapshot ID')
        run('restic','-r',repository,'--password-file',str(password),'check',timeout=600)
    atomic_json(root/'operator/verified-backup.json',{'database_identity':manifest['database_identity'],'verified_at':int(time.time()),'repository':repository,'snapshot':snapshot})
    print('Encrypted backup verified. Snapshot: '+snapshot+'. No snapshots were pruned.')


def wait_ready(layout):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
    deadline=time.monotonic()+120
    while time.monotonic()<deadline:
        try:
            with opener.open('http://127.0.0.1:'+str(layout.ports['service'])+'/internal/ready',timeout=2) as response:
                if response.status==200:return
        except OSError:pass
        time.sleep(.5)
    raise RuntimeError('Application readiness failed; public ingress was not started')


def ensure_ports(layout,root):
    # Existing containers from this exact private Compose project can be resumed.
    running=compose(root,'ps','--status','running','--format','json')
    if running.strip():return
    for port in layout.ports.values():
        with socket.socket() as probe:
            probe.settimeout(.2)
            if probe.connect_ex(('127.0.0.1',port))==0:
                raise ValueError('An installation port is already in use; existing services were not changed')


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',default='installation.toml')
    parser.add_argument('--expected-database')
    parser.add_argument('--repository')
    parser.add_argument('command',choices=('validate','prepare','bootstrap','start','stop','status','login','backup','backup-init'))
    args=parser.parse_args();value,root,layout=config(args.config)
    if args.command=='validate': print('Installation configuration is valid');return
    if args.command=='prepare':
        if any(h.endswith(('.example.com','.example.invalid','.invalid')) for k,h in value.items() if k.endswith('_host')):
            raise ValueError('Replace example hostnames with names you control before preparation')
        initialize(value,root,layout);return
    if not args.expected_database: raise ValueError('--expected-database is required for an existing installation')
    manifest=read_manifest(root,args.expected_database)
    match_configuration(value,manifest)
    if manifest['environment']!=value['environment'] or manifest['realm']!=layout.realm: raise ValueError('Installation environment differs')
    with lock(root/'operator/activation.lock'):
        if args.command=='bootstrap':
            ensure_ports(layout,root)
            bootstrap(root,layout,args.expected_database)
        elif args.command=='start':
            if not manifest.get('enrolled'):raise ValueError('Run bootstrap before starting the application')
            if manifest.get('recovery_pending'):raise ValueError('Recovery is incomplete; public startup is prohibited')
            app=private_read(root/'service/config.json');app['background']=True;atomic_json(root/'service/config.json',app)
            ensure_ports(layout,root)
            compose(root,'--profile','application','up','-d','database','identity','search','service','adapter')
            wait_ready(layout)
            compose(root,'--profile','application','up','-d','gateway')
            manifest.update(application_enabled=True,background_enabled=True,ingress_published=True);atomic_json(root/'manifest.json',manifest)
            print('Application started. Check status before connecting a client.')
        elif args.command=='stop':compose(root,'--profile','application','stop');print('Installation stopped; data retained')
        elif args.command=='status':print(compose(root,'--profile','application','ps'))
        elif args.command=='login':
            if not sys.stdout.isatty():raise ValueError('Temporary credentials can only be shown in a private terminal')
            owner=private_read(root/'operator/owner.json')
            print('Sign in: '+manifest['website']+'\nUsername: '+owner['username']+'\nTemporary password: '+owner['password'])
        elif args.command=='backup-init':
            if not args.repository:raise ValueError('--repository is required')
            run('restic','-r',args.repository,'--password-file',str(root/'operator/backup.secret'),'init');print('Encrypted backup repository initialized')
        elif args.command=='backup':backup(root,manifest,layout,args.repository)

if __name__=='__main__':
    try:main()
    except (ValueError,RuntimeError,OSError,subprocess.SubprocessError) as error:
        # No provider replies, secrets, config, or shell commands in errors.
        if isinstance(error,(ValueError,RuntimeError)):raise SystemExit(str(error)) from None
        raise SystemExit('Installation operation failed; inspect local files and service state privately') from None
