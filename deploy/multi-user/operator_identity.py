"""Replace temporary Keycloak bootstrap access with a private operator client.

Called by an authenticated operator, never by an HTTP or model-facing route.
The credential journal must be included in essential encrypted recovery material
and must not be mounted into the serving GTD/identity containers. The caller owns
the maintenance/lifecycle locks and deployment restart; this module opens none.
"""
import json
import os
from pathlib import Path
import secrets
import stat
import sys
import uuid
from urllib.parse import quote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backups'))
from gtd_backup import atomic_json
from recovery_ops import ProviderRecovery


def private_read(path, *, max_bytes=8192):
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor) as stream:
        meta = os.fstat(stream.fileno())
        if not stat.S_ISREG(meta.st_mode) or meta.st_mode & 0o077 or meta.st_size > max_bytes:
            raise RuntimeError('Operator credentials must be a private bounded regular file')
        return json.load(stream)


def connect(template, state):
    operator = ProviderRecovery(template.base, template.realm, template.issuer,
        state['client_id'], state['secret'], template.clients, template.deadline,
        authentication_realm='master')
    operator.opener = template.opener
    return operator


def load_operator(template, manifest, journal_path):
    """Authenticate only an already completed, exactly bound private operator."""
    state = private_read(journal_path)
    expected = {key: manifest[key] for key in ('database_identity', 'issuer', 'realm', 'environment')}
    if (state.get('format') != 1 or state.get('completed') is not True
            or any(state.get(k) != v for k, v in expected.items())
            or state.get('client_id') != 'gtd-private-operator-'+str(uuid.UUID(expected['database_identity']))
            or not isinstance(state.get('secret'), str) or not 48 <= len(state['secret']) <= 512):
        raise RuntimeError('Private operator does not match the completed deployment enrollment')
    client_uuid = str(uuid.UUID(state['client_uuid']))
    operator = connect(template, state)
    client = operator.request('/admin/realms/master/clients/'+client_uuid)
    if (client.get('clientId') != state['client_id']
            or client.get('attributes', {}).get('gtd_database_identity') != expected['database_identity']):
        raise RuntimeError('Private operator immutable binding differs')
    return operator


def replace_bootstrap(admin, manifest, journal_path, bootstrap_subject):
    identity = str(uuid.UUID(manifest['database_identity']))
    bootstrap_subject = str(uuid.UUID(bootstrap_subject))
    if (manifest.get('environment') not in ('staging', 'production')
            or manifest.get('realm') != admin.realm or manifest.get('issuer') != admin.issuer
            or admin.realm == 'master' or urlsplit(admin.issuer).path != '/realms/'+admin.realm):
        raise RuntimeError('Operator provisioning requires the exact deployment identity')
    journal_path = Path(journal_path)
    if (not journal_path.is_absolute() or journal_path.parent != journal_path.parent.resolve()
            or stat.S_IMODE(journal_path.parent.stat().st_mode) & 0o077):
        raise RuntimeError('Operator journal requires a private canonical parent directory')
    expected = {'format': 1, 'database_identity': identity, 'issuer': admin.issuer,
        'realm': admin.realm, 'environment': manifest['environment'],
        'client_id': 'gtd-private-operator-'+identity, 'bootstrap_subject': bootstrap_subject}
    if journal_path.exists() or journal_path.is_symlink():
        state = private_read(journal_path)
        if any(state.get(k) != v for k, v in expected.items()):
            raise RuntimeError('Operator journal belongs to a different deployment or bootstrap account')
    else:
        state = {**expected, 'secret': secrets.token_urlsafe(48)}
        atomic_json(journal_path, state)
    if not isinstance(state.get('secret'), str) or not 48 <= len(state['secret']) <= 512:
        raise RuntimeError('Invalid private operator credential')
    # A completed attempt resumes with its own credential; the deleted bootstrap
    # identity is not needed. An uncertain deletion is also recoverable this way.
    operator = connect(admin, state)
    if state.get('client_uuid'):
        try:
            operator.request('/admin/realms/master')
            admin = operator
        except RuntimeError:
            if state.get('completed'):
                raise RuntimeError('Established operator credential failed; do not recreate it') from None
    prefix = '/admin/realms/master'
    clients = admin.request(prefix+'/clients?clientId='+quote(state['client_id'], safe=''))
    definition = {'clientId': state['client_id'], 'enabled': True, 'protocol': 'openid-connect',
        'publicClient': False, 'standardFlowEnabled': False, 'directAccessGrantsEnabled': False,
        'implicitFlowEnabled': False, 'serviceAccountsEnabled': True,
        'attributes': {'gtd_database_identity': identity}, 'secret': state['secret']}
    if not clients:
        if state.get('client_uuid'):
            raise RuntimeError('Established private operator disappeared')
        admin.request(prefix+'/clients', 'POST', definition)
        clients = admin.request(prefix+'/clients?clientId='+quote(state['client_id'], safe=''))
    if len(clients) != 1:
        raise RuntimeError('Ambiguous private operator identity')
    client = clients[0]
    for key, value in definition.items():
        if key == 'secret': continue
        if key == 'attributes':
            if client.get(key, {}).get('gtd_database_identity') == identity: continue
        elif client.get(key) == value: continue
        raise RuntimeError('Private operator configuration changed')
    client_uuid = str(uuid.UUID(client['id']))
    if state.get('client_uuid', client_uuid) != client_uuid:
        raise RuntimeError('Private operator immutable identity changed')
    if admin.request(prefix+'/clients/'+client_uuid+'/client-secret')['value'] != state['secret']:
        raise RuntimeError('Private operator credential differs from its journal')
    state['client_uuid'] = client_uuid
    atomic_json(journal_path, state)
    account = admin.request(prefix+'/clients/'+client_uuid+'/service-account-user')
    role = admin.request(prefix+'/roles/admin')
    admin.request(prefix+'/users/'+quote(account['id'], safe='')+'/role-mappings/realm', 'POST', [role])
    # Obtain a NEW token after role assignment; prove independent access before
    # removing the temporary account. No broader grant is added to the GTD client.
    operator = connect(admin, state)
    operator.request('/admin/realms/master')
    operator.request('/admin/realms/'+admin.realm+'/clients')
    target = prefix+'/users/'+bootstrap_subject
    existing = operator.request(target, missing=True)
    if existing is not None:
        if existing['id'] != bootstrap_subject or existing['id'] == account['id']:
            raise RuntimeError('Unexpected bootstrap identity')
        operator.request(target, 'DELETE')
    if operator.request(target, missing=True) is not None:
        raise RuntimeError('Temporary bootstrap account still exists')
    state['completed'] = True
    atomic_json(journal_path, state)
    return operator, {'private_operator_ready': True, 'bootstrap_removed': True,
        'database_identity': identity, 'application_client_privileges_changed': False}
