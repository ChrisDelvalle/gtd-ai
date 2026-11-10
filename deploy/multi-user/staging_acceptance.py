"""Real-provider acceptance in a new, unpublished Docker network namespace.

The fixture never loads personal credentials or connects to hosted services.
Secrets travel only through private pipes/memory; evidence contains assertions.
This is an HTTP/OIDC protocol test, not a browser or live-model test.
"""
import base64
import hashlib
import html
import io
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
from urllib.parse import parse_qs, urlencode, urlsplit
import uuid

import staging
from realm_bootstrap import CLIENTS, REALM, configure

sys.path.insert(0, str(staging.ROOT/'deploy/backups'))
from recovery_ops import ProviderRecovery

NODE = 'node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6'
WEBSITE = 'https://todo-staging.example.invalid'
ISSUER = 'https://auth-staging.example.invalid/realms/gtd-staging'


def fixture_origins(root):
    """Explicit staging names; all requests still resolve inside network:none."""
    manifest = json.loads((root/'manifest.json').read_text())
    if manifest['environment'] != 'staging':
        raise RuntimeError('Recovery protocol fixtures require staging')
    hosts = [staging.hostname(urlsplit(manifest[key]).hostname)
             for key in ('issuer', 'resource', 'website')]
    return hosts


def prepare_https(root):
    """Trust one ephemeral root in this fixture only; preserve TLS verification."""
    tls = root/'fixture'
    tls.mkdir(mode=0o700)
    auth, website_mcp, website = fixture_origins(root)
    def openssl(*args):
        result = subprocess.run(['openssl', *args], cwd=tls, capture_output=True, timeout=15)
        if result.returncode: raise RuntimeError('Temporary fixture certificate creation failed')
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=Disposable GTD staging CA', '-keyout', 'ca.key', '-out', 'ca.pem',
        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign')
    openssl('req', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN='+auth,
        '-keyout', 'server.key', '-out', 'server.csr')
    staging.write(tls/'extensions', 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n'
        'extendedKeyUsage=serverAuth\nsubjectAltName='+','.join('DNS:'+h for h in (auth, website, website_mcp))+'\n')
    openssl('x509', '-req', '-in', 'server.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
        '-days', '1', '-out', 'server.pem', '-extfile', 'extensions')
    for name in ('ca.key', 'ca.srl', 'server.csr', 'extensions'): (tls/name).unlink()
    for path in tls.iterdir(): path.chmod(0o600)
    staging.write(root/'service/fixture-ca.pem', (tls/'ca.pem').read_text())
    config = json.loads((root/'service/config.json').read_text())
    config['identity_ca_file'] = '/config/fixture-ca.pem'
    (root/'service/config.json').write_text(json.dumps(config)+'\n')
    gateway = root/'gateway/Caddyfile'
    https = ''
    for host, port in [(auth, 19546), (website, 19542), (website_mcp, 19546)]:
        https += '\nhttps://'+host+' {\n bind 127.0.0.1\n tls /fixture/server.pem /fixture/server.key\n reverse_proxy 127.0.0.1:'+str(port)+'\n}\n'
    gateway.write_text(gateway.read_text()+https)
    compose = json.loads((root/'compose.json').read_text())
    compose['services']['gateway']['volumes'].append(staging.mount(tls, '/fixture'))
    (root/'compose.json').write_text(json.dumps(compose)+'\n')


class Transport:
    def __init__(self, docker, database, root):
        self.docker, self.database, self.root = docker, database, root
        self.script = Path(__file__).with_name('staging_http_fixture.mjs').read_text()
        self.deadline = time.monotonic()+180
        self.hosts = fixture_origins(root)
        manifest = json.loads((root/'manifest.json').read_text())
        self.website = manifest['website'].rstrip('/')
        self.issuer, self.resource = manifest['issuer'], manifest['resource']

    def send(self, url, method='GET', body=None, headers=None):
        if time.monotonic() >= self.deadline: raise TimeoutError('Staging protocol budget exhausted')
        args = ['run', '--rm', '--pull', 'never', '--interactive', '--network', 'container:'+self.database,
            '--read-only', '--user', str(self.root.stat().st_uid)+':'+str(self.root.stat().st_gid),
            '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--memory', '128m', '--cpus', '1', '--pids-limit', '64',
            '--mount', 'type=bind,src='+str(self.root/'fixture/ca.pem')+',dst=/fixture/ca.pem,readonly',
            NODE, 'node', '--input-type=module', '-e', self.script]
        value = self.docker(*args, input=json.dumps({'url': url, 'method': method, 'body': body,
            'headers': headers or {}, 'hosts': self.hosts}).encode())
        result = json.loads(value.stdout)
        result['body'] = base64.b64decode(result['body']).decode()
        return result

    def open(self, request, timeout):
        response = self.send(request.full_url, request.method, request.data.decode() if request.data else None,
                             dict(request.header_items()))
        if not 200 <= response['status'] < 300:
            raise urllib.error.HTTPError(request.full_url, response['status'], 'fixture HTTP failure', {}, None)
        return io.BytesIO(response['body'].encode())


class WebsiteSession:
    def __init__(self, transport, test):
        self.transport, self.test, self.cookies, self.profile = transport, test, {}, None
        self.website = transport.website
        self.auth_host = urlsplit(transport.issuer).netloc

    def send(self, url, method='GET', body=None, headers=None):
        origin = urlsplit(url).netloc
        jar = self.cookies.setdefault(origin, {})
        headers = {**(headers or {}), 'Cookie': '; '.join(k+'='+v for k,v in jar.items())}
        response = self.transport.send(url, method, body, headers)
        for cookie in response['headers'].get('set-cookie', []):
            key, value = cookie.split(';', 1)[0].split('=', 1)
            if 'max-age=0' in cookie.lower(): jar.pop(key, None)
            else: jar[key] = value
        return response

    def api(self, path, body=None, *, status=200, method=None):
        headers = {'Origin': self.website, 'X-GTD-Request': '1', 'Content-Type': 'application/json'}
        if self.profile:
            headers.update({'X-GTD-Account': self.profile['account']['id'], 'X-GTD-Environment': 'staging',
                            'X-GTD-CSRF': self.profile['csrf']})
        response = self.send(self.website+path, method or ('POST' if body is not None else 'GET'),
                             json.dumps(body) if body is not None else None, headers)
        self.test.assertEqual(response['status'], status, path+' returned HTTP '+str(response['status']))
        return json.loads(response['body'])

    def login(self, username, password, *, remember=False, replace_password=None):
        self.profile = None
        begin = self.api('/api/auth/login', {'remember': remember, 'return_to': '/', 'reauthenticate': False})
        page = self.send(begin['authorization_url'])
        replaced = False
        for _ in range(10):
            if page['status'] in (302, 303):
                url = page['headers']['location']
                if url in (self.website+'/', '/'): break
                parsed = urlsplit(url)
                self.test.assertIn(parsed.netloc, (self.auth_host, urlsplit(self.website).netloc))
                page = self.send(url)
                continue
            self.test.assertEqual(page['status'], 200, 'OIDC form response')
            form = re.search(r'<form[^>]*action="([^"]+)"', page['body'])
            self.test.assertIsNotNone(form, 'Expected provider form')
            action = html.unescape(form.group(1))
            self.test.assertEqual(urlsplit(action).netloc, self.auth_host)
            if 'name="password-new"' in page['body']:
                self.test.assertIsNotNone(replace_password, 'Temporary credential must be replaced')
                fields = {'password-new': replace_password, 'password-confirm': replace_password}
                replaced = True
            else:
                self.test.assertIn('name="username"', page['body'], 'Unexpected provider step')
                fields = {'username': username, 'password': password, 'credentialId': ''}
            page = self.send(action, 'POST', urlencode(fields), {'Content-Type': 'application/x-www-form-urlencoded'})
        else: self.test.fail('OIDC did not complete within its redirect budget')
        self.test.assertEqual(replaced, replace_password is not None)
        # The final callback set the secure host cookie. Browser persistence is
        # checked from the actual response, not inferred from the request choice.
        cookie = next(c for c in page['headers'].get('set-cookie', []) if c.startswith('__Host-gtd_session='))
        self.test.assertIn('Secure', cookie)
        self.test.assertIn('HttpOnly', cookie)
        self.test.assertEqual('Max-Age=' in cookie, remember)
        self.profile = self.api('/api/auth/session')
        self.test.assertTrue(self.profile['authenticated'])
        return self.profile


def oauth_grant(session, client, callback, *, credentials=None):
    """Code/PKCE with SSO or one requested fixture sign-in; no external call."""
    verifier, state = secrets.token_urlsafe(32), secrets.token_urlsafe(24)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    resource = 'https://mcp-staging.example.invalid/mcp'
    response = session.send(ISSUER+'/protocol/openid-connect/auth?'+urlencode({
        'client_id': client, 'redirect_uri': callback, 'response_type': 'code', 'state': state,
        'nonce': secrets.token_urlsafe(24), 'scope': 'openid gtd:access offline_access',
        'resource': resource, 'code_challenge': challenge, 'code_challenge_method': 'S256'}))
    for _ in range(5):
        if response['status'] == 200 and credentials is not None:
            form = re.search(r'<form[^>]*action="([^"]+)"',response['body'])
            session.test.assertIsNotNone(form,'Expected provider sign-in form')
            session.test.assertIn('name="username"',response['body'])
            action = html.unescape(form.group(1))
            session.test.assertEqual(urlsplit(action).netloc,'auth-staging.example.invalid')
            response = session.send(action,'POST',urlencode({'username':credentials[0],
                'password':credentials[1],'credentialId':''}),{'Content-Type':'application/x-www-form-urlencoded'})
            credentials = None  # A rejected password is a failure, never retried.
            continue
        title = re.search(r'<title>([^<]{0,120})</title>',response['body'])
        forms = re.findall(r'<form[^>]*\bid="([a-zA-Z0-9_-]{1,80})"',response['body'])
        session.test.assertIn(response['status'], (302, 303), 'Provider SSO must issue an authorization redirect; '+
            'page='+html.unescape(title.group(1) if title else 'none')+'; forms='+','.join(forms))
        redirect = response['headers']['location']
        parsed = urlsplit(redirect)
        if parsed.scheme+'://'+parsed.netloc+parsed.path == callback:
            fields = parse_qs(parsed.query)
            session.test.assertEqual(fields.get('state'), [state])
            session.test.assertEqual(fields.get('iss'), [ISSUER])
            session.test.assertTrue(fields.get('code'))
            break
        session.test.assertEqual(parsed.netloc, 'auth-staging.example.invalid')
        response = session.send(redirect)
    else: session.test.fail('Authorization exceeded its redirect budget')
    response = session.send(ISSUER+'/protocol/openid-connect/token', 'POST', urlencode({
        'grant_type': 'authorization_code', 'client_id': client, 'redirect_uri': callback,
        'resource': resource, 'code_verifier': verifier, 'code': fields['code'][0]}),
        {'Content-Type': 'application/x-www-form-urlencoded'})
    session.test.assertEqual(response['status'], 200, 'Code exchange')
    tokens = json.loads(response['body'])
    session.test.assertTrue(tokens.get('refresh_token'))
    return tokens


def refresh(session, client, token, *, status=200):
    response = session.send(ISSUER+'/protocol/openid-connect/token', 'POST', urlencode({
        'grant_type': 'refresh_token', 'client_id': client, 'refresh_token': token,
        'resource': 'https://mcp-staging.example.invalid/mcp'}), {'Content-Type': 'application/x-www-form-urlencoded'})
    session.test.assertEqual(response['status'], status, 'Offline token renewal')
    return json.loads(response['body'])


def mcp(transport, test, token, host, name, arguments=None, *, status=200, metadata=None, error_code=None):
    response = transport.send('http://127.0.0.1:19544/mcp', 'POST', json.dumps({
        'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': arguments or {},
            **({'_meta': metadata} if metadata is not None else {})}}),
        {'Authorization': 'Bearer '+token, 'Host': host, 'Content-Type': 'application/json',
         'Accept': 'application/json, text/event-stream'})
    test.assertEqual(response['status'], status, 'Authenticated MCP transport')
    value = json.loads(response['body'])
    if status == 200:
        test.assertNotIn('error', value, 'MCP protocol error')
        if error_code:
            test.assertTrue(value['result'].get('isError', False), 'Expected application denial')
            test.assertEqual(value['result']['structuredContent']['code'], error_code)
        else:
            test.assertFalse(value['result'].get('isError', False), 'MCP application error')
        return value['result']
    return value


def run(test, docker, database, root, query, manifest, *, components=None):
    transport = Transport(docker, database, root)
    admin = ProviderRecovery('http://127.0.0.1:19543', REALM, ISSUER, 'admin-cli', 'unused', CLIENTS, transport.deadline)
    admin.opener = transport
    values = dict(line.split('=', 1) for line in (root/'identity/environment').read_text().splitlines())
    token = admin.request('/realms/master/protocol/openid-connect/token', 'POST', {
        'grant_type': 'password', 'client_id': 'admin-cli', 'username': values['KC_BOOTSTRAP_ADMIN_USERNAME'],
        'password': values['KC_BOOTSTRAP_ADMIN_PASSWORD']}, form=True, authenticated=False)
    admin.token, admin.expires = token['access_token'], time.monotonic()+token['expires_in']-5
    website_secret, service_secret = ((root/'service'/name).read_text().strip() for name in ('website.secret','administration.secret'))
    test.assertEqual(configure(admin, manifest, website_secret, service_secret),
                     configure(admin, manifest, website_secret, service_secret))
    account, generation = str(uuid.uuid4()), str(uuid.uuid4())
    password = 'Gtd-9!'+secrets.token_urlsafe(24)
    prefix = '/admin/realms/'+REALM
    admin.request(prefix+'/users', 'POST', {'username': 'fixture-owner', 'enabled': True,
        'attributes': {'gtd_account_id': [account], 'gtd_generation': [generation]},
        'credentials': [{'type': 'password', 'value': password, 'temporary': False}]})
    users = admin.request(prefix+'/users?username=fixture-owner&exact=true')
    test.assertEqual(len(users), 1)
    subject = str(uuid.UUID(users[0]['id']))
    test.assertEqual(json.loads(query('SELECT row_to_json(m) FROM gtd.schema_meta m').stdout)['identity'], manifest['database_identity'])
    test.assertEqual(query('SELECT count(*) FROM gtd.accounts').stdout.strip(), b'0')
    query("INSERT INTO gtd.accounts(id,issuer,subject,username,administrator,credential_generation,enabled,enrollment) VALUES "
        f"('{account}','{ISSUER}','{subject}','fixture-owner',true,'{generation}',true,'active'); "
        f"INSERT INTO gtd.account_state(account_id,identity) VALUES('{account}',gen_random_uuid());")
    owner = WebsiteSession(transport, test)
    profile = owner.login('fixture-owner', password, remember=True)
    test.assertEqual(profile['account']['id'], account)
    test.assertTrue(profile['account']['administrator'])
    invitation_request = {'request_id': str(uuid.uuid4()), 'command': {'action': 'invite', 'username': 'fixture-user', 'display_name': 'Test'}}
    invited = owner.api('/api/users/operations', invitation_request)
    test.assertEqual(invited['operation']['state'], 'complete')
    test.assertTrue(invited['temporary_password'])
    replay = owner.api('/api/users/operations', invitation_request)
    test.assertEqual(replay['operation']['id'], invited['operation']['id'])
    test.assertIsNone(replay['temporary_password'])
    # The strict auth-time cutoff has second precision. Begin user authentication
    # in a later second, as a real person entering a generated credential would.
    time.sleep(1.05)
    user = WebsiteSession(transport, test)
    profile = user.login('fixture-user', invited['temporary_password'], replace_password='Gtd-9!'+secrets.token_urlsafe(24))
    test.assertEqual(profile['account']['id'], invited['operation']['target_id'])
    test.assertFalse(profile['account']['administrator'])
    user.api('/api/users', status=403)
    user.api('/api/users/operations', {'request_id': str(uuid.uuid4()), 'command': {'action': 'invite', 'username': 'not-allowed'}}, status=403)
    # Same request ID belongs to different account receipts; admin status does
    # not confer permission to read another account's task content.
    shared_request = str(uuid.uuid4())
    tasks = []
    for session, title in ((owner, 'Synthetic owner task'), (user, 'Synthetic invited task')):
        result = session.api('/api/tools/capture_item', {'request_id': shared_request, 'title': title,
            'brief': 'Complete the isolated acceptance check.', 'importance': 'normal', 'status': 'next',
            'estimated_minutes': 15, 'effort': 'low', 'reason': 'Disposable deterministic fixture'})
        tasks.append(result['task']['id'])
        test.assertFalse(result['replayed'])
    test.assertNotEqual(*tasks)
    for index, session in enumerate((owner, user)):
        own = session.api('/api/tools/list_items', {'limit': 10})
        test.assertEqual([item['id'] for item in own['items']], [tasks[index]])
        foreign = session.api('/api/tools/list_items', {'task_id': tasks[1-index], 'limit': 1})
        test.assertEqual(foreign['items'], [])
    grants = []
    for client, callback, host in (
        (CLIENTS[1], 'https://chatgpt.com/connector_platform_oauth_redirect', '127.0.0.1:19544'),
        (CLIENTS[2], 'https://claude.ai/api/mcp/auth_callback', 'mcp-staging.example.invalid')):
        tokens = oauth_grant(user, client, callback)
        result = mcp(transport, test, tokens['access_token'], host, 'get_profile')
        test.assertEqual(result['structuredContent']['id'], profile['account']['id'])
        test.assertEqual(result['_meta']['gtd/accountId'], profile['account']['id'])
        result = mcp(transport, test, tokens['access_token'], host, 'list_items', {'limit': 10})
        test.assertEqual([item['id'] for item in result['structuredContent']['items']], [tasks[1]])
        result = mcp(transport, test, tokens['access_token'], host, 'show_gtd', {'view': 'home'})
        test.assertEqual(result['structuredContent']['view'], 'home')
        test.assertEqual(json.loads(result['content'][0]['text'])['view'], 'home')
        test.assertEqual(result['_meta']['gtd/accountId'], profile['account']['id'])
        pins = {'gtd/expectedAccount': profile['account']['id'], 'gtd/expectedEnvironment': 'staging'}
        app_args = {'operation': 'list_items', 'arguments': {'task_id': tasks[1], 'limit': 1}}
        result = mcp(transport, test, tokens['access_token'], host, 'gtd_ui_read', app_args, metadata=pins)
        test.assertEqual([item['id'] for item in result['structuredContent']['items']], [tasks[1]])
        mcp(transport, test, tokens['access_token'], host, 'gtd_ui_read', app_args, error_code='account_changed')
        mcp(transport, test, tokens['access_token'], host, 'gtd_ui_read', app_args,
            metadata={**pins, 'gtd/expectedAccount': account}, error_code='account_changed')
        renewed = refresh(user, client, tokens['refresh_token'])
        result = mcp(transport, test, renewed['access_token'], host, 'get_profile')
        test.assertEqual(result['structuredContent']['id'], profile['account']['id'])
        grants.append((client, host, renewed))
    if os.environ.get('GTD_TEST_STAGING_WORKFLOWS') == '1':
        from staging_workflows import run as workflows
        evidence = workflows(test,docker,database,root,query,manifest,transport,admin,owner,components)
        evidence['images'] = manifest['images']
        destination = os.environ.get('GTD_TEST_STAGING_WORKFLOW_EVIDENCE')
        if destination:
            Path(destination).write_text(json.dumps(evidence,indent=2)+'\n')
        # The measurement can outlast the recent-authentication window.
        owner.login('fixture-owner', password, remember=True)
        # Disablement must be checked with otherwise-valid access tokens, not
        # tokens that happened to expire while the optional workload ran.
        grants = [(client,host,refresh(user,client,tokens['refresh_token'])) for client,host,tokens in grants]
    owner.api('/api/users/operations', {'request_id': str(uuid.uuid4()), 'command': {'action': 'disable', 'target_id': account}}, status=409)
    owner.api('/api/users/operations', {'request_id': str(uuid.uuid4()), 'command': {'action': 'disable', 'target_id': profile['account']['id']}})
    test.assertFalse(user.api('/api/auth/session')['authenticated'])
    for client, host, tokens in grants:
        mcp(transport, test, tokens['access_token'], host, 'get_profile', status=403)
        refresh(user, client, tokens['refresh_token'], status=400)
    recovery = None
    if os.environ.get('GTD_TEST_STAGING_APPLICATION_RECOVERY') == '1':
        from staging_application_recovery import run as recover
        recovery = recover(test, docker, database, root, query, manifest, owner, password,
                           components, tasks, shared_request)
    return {'realm_bootstrap_replayed': True, 'real_https_oidc': True, 'remember_and_session_cookies': True,
        'temporary_password_changed': True, 'invitation_activated': True, 'administration_denied_to_user': True,
        'invitation_replay_hides_password': True, 'last_admin_protected': True, 'disable_invalidates_session': True,
        'account_scoped_tasks_and_receipts': True, 'administrator_cannot_read_user_tasks': True,
        'both_mcp_clients_code_pkce': True, 'mcp_profile_and_isolation': True, 'offline_resource_renewal': True,
        'mcp_app_account_binding': True, 'launch_receipt_text': True,
        'disable_rejects_access_and_revokes_offline_grants': True, 'application_recovery': recovery}
