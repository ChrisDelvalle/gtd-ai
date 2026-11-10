"""Private recovery primitives; no production restore entry point.

The caller must stop writers and verify its restored bundle/environment first.
These routines neither restore a database nor open ingress. Provider requests
use a private realm credential with user-management and client-read permissions,
never user passwords. This is not an application-facing administration endpoint.
"""
import json
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from backup_errors import Corruption


def prepare_application(session, *, source_identity, recovery_identity, environment, cutoff):
    source_identity = str(uuid.UUID(source_identity))
    recovery_identity = str(uuid.UUID(recovery_identity))
    if source_identity == recovery_identity or environment not in ('production', 'staging'):
        raise RuntimeError('Recovery requires distinct, explicit database identities')
    if type(cutoff) is not int or abs(cutoff-int(time.time()))>5:
        raise RuntimeError('Recovery requires a current, explicit authentication cutoff')
    locked = session.query('BEGIN; SELECT to_json(pg_try_advisory_xact_lock(214716023,1));')
    try:
        if not locked:
            raise RuntimeError('Account administration is active; recovery was not applied')
        meta = session.query('SELECT row_to_json(m) FROM gtd.schema_meta m FOR UPDATE;')
        if meta['environment'] != environment or meta['compatibility'] not in (12,13) or meta['identity'] not in (source_identity,recovery_identity):
            raise Corruption('Recovery database does not match the approved source or attempt')
        if meta['identity'] == recovery_identity:
            # A matching identity alone cannot prove that writers stayed
            # stopped. The eventual operator orchestrator must reconcile an
            # uncertain commit; this primitive must not silently reset it again.
            raise Corruption('Recovery was already applied; reconcile the prior attempt before continuing')
        session.query(f"UPDATE gtd.accounts SET authenticated_after=greatest(coalesce(authenticated_after,0),{cutoff}); "
            "DELETE FROM gtd.web_sessions; DELETE FROM gtd.web_logins; DELETE FROM gtd.search_sessions; "
            "DELETE FROM gtd.search_state WHERE key NOT LIKE 'recurrence:%'; "
            "UPDATE gtd.account_state SET identity=gen_random_uuid(); "
            f"UPDATE gtd.schema_meta SET identity='{recovery_identity}'; SELECT to_json(true);")
        session.query('COMMIT; SELECT to_json(true);')
        return {'replayed': False, 'database_identity': recovery_identity, 'authenticated_after': cutoff}
    except BaseException:
        try:
            session.query('ROLLBACK; SELECT to_json(true);')
        except Exception:
            pass  # A lost connection already rolls back; preserve the original failure.
        raise


class NoRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_):
        return None


class ProviderRecovery:
    """Bounded fixed-path administration using privately supplied credentials."""
    def __init__(self, base, realm, issuer, client_id, client_secret, clients, deadline,
                 *, authentication_realm=None):
        parsed = urllib.parse.urlsplit(base)
        if (parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or not parsed.port
                or parsed.path != '' or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise RuntimeError('Recovery provider access must use an explicit private loopback origin')
        if not realm or len(realm)>100 or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_' for c in realm):
            raise RuntimeError('Invalid recovery realm')
        if authentication_realm not in (None, realm, 'master'):
            raise RuntimeError('Recovery authentication must use the target or private master realm')
        issuer_url = urllib.parse.urlsplit(issuer)
        if (issuer_url.scheme != 'https' or not issuer_url.netloc or issuer_url.username or issuer_url.password
                or issuer_url.query or issuer_url.fragment or not clients or len(clients)>8
                or any(not isinstance(c,str) or not c or len(c)>255 for c in clients)
                or len(set(clients))!=len(clients)):
            raise RuntimeError('Recovery requires the exact issuer and complete OAuth-client list')
        self.base, self.realm, self.issuer = base, realm, issuer
        self.client_id, self.client_secret, self.clients = client_id, client_secret, clients
        self.authentication_realm = authentication_realm or realm
        self.deadline, self.token, self.expires = deadline, None, 0
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirects())

    def request(self, path, method='GET', body=None, form=False, authenticated=True, missing=False):
        remaining = self.deadline-time.monotonic()
        if remaining<=0:
            raise TimeoutError('Identity recovery exceeded its time budget')
        if authenticated and (not self.token or time.monotonic()>=self.expires):
            token = self.request('/realms/'+self.authentication_realm+'/protocol/openid-connect/token','POST',
                {'grant_type':'client_credentials','client_id':self.client_id,'client_secret':self.client_secret},
                form=True,authenticated=False)
            self.token=token['access_token']; self.expires=time.monotonic()+max(1,min(token['expires_in'],60)-10)
            remaining = self.deadline-time.monotonic()
            if remaining<=0:
                raise TimeoutError('Identity recovery exceeded its time budget')
        headers={'User-Agent':'GTD-Identity-Recovery/1','Accept':'application/json'}
        if authenticated: headers['Authorization']='Bearer '+self.token
        data=None
        if body is not None:
            headers['Content-Type']='application/x-www-form-urlencoded' if form else 'application/json'
            data=(urllib.parse.urlencode(body) if form else json.dumps(body)).encode()
        request=urllib.request.Request(self.base+path,method=method,data=data,headers=headers)
        try:
            with self.opener.open(request,timeout=min(5,remaining)) as response:
                content=response.read(256*1024+1)
                if len(content)>256*1024: raise RuntimeError('Provider recovery response exceeds its bound')
                return json.loads(content) if content else None
        except urllib.error.HTTPError as error:
            if missing and error.code==404: return None
            raise RuntimeError('Identity recovery request failed: HTTP '+str(error.code)) from None
        except (OSError,ValueError):
            raise RuntimeError('Identity recovery provider is unavailable or returned invalid data') from None

    def revoke(self, accounts):
        # Validate every immutable binding before modifying any provider grant.
        metadata=self.request('/realms/'+self.realm+'/.well-known/openid-configuration',authenticated=False)
        if metadata.get('issuer')!=self.issuer:
            raise Corruption('Recovery provider discovery issuer does not match the backup')
        client_ids=[]
        for client in self.clients:
            matches=self.request('/admin/realms/'+self.realm+'/clients?clientId='+urllib.parse.quote(client,safe=''))
            if len(matches)!=1 or matches[0]['clientId']!=client:
                raise Corruption('Recovery OAuth client is missing or ambiguous')
            client_ids.append(urllib.parse.quote(matches[0]['id'],safe=''))
        targets=[]
        for account in accounts:
            if account['issuer']!=self.issuer:
                raise Corruption('Recovery account issuer mismatch')
            subject=urllib.parse.quote(account['subject'],safe='')
            path='/admin/realms/'+self.realm+'/users/'+subject
            user=self.request(path)
            if user.get('id')!=account['subject'] or user.get('attributes',{}).get('gtd_account_id')!=[account['id']]:
                raise Corruption('Recovery provider identity does not match its GTD account')
            # Disabling/resetting access invalidates GTD's generation before
            # provider work. A disabled account can intentionally retain an old
            # provider generation. Its immutable binding still must match; grant
            # revocation never enables it or repairs a provisioning operation.
            if (account.get('enabled',True) and account.get('credential_generation')
                    and user.get('attributes',{}).get('gtd_generation')!=[account['credential_generation']]):
                raise Corruption('Recovery credential generation does not match its GTD account')
            targets.append(path)
        for path in targets:
            self.request(path+'/logout','POST')
            for client in self.clients:
                self.request(path+'/consents/'+urllib.parse.quote(client,safe=''),'DELETE',missing=True)
            if self.request(path+'/sessions'):
                raise Corruption('Provider still reports restored user sessions')
            for client_id in client_ids:
                if self.request(path+'/offline-sessions/'+client_id):
                    raise Corruption('Provider still reports restored offline grants')
        return {'accounts_processed':len(targets),'oauth_clients':len(self.clients)}
