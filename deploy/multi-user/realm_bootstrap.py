"""Private Keycloak configuration with separate staging/production entry points.

`admin` is an already authenticated, bounded private operator transport. There is
no HTTP entry point or username-based enrollment fallback. Setup is resumable
only for the realm marked with the same environment and database identity.
"""
import uuid
from urllib.parse import urlsplit

from stack_config import STAGING, PRODUCTION, hostname, require_layout

REALM = STAGING.realm

CLIENTS = ('gtd-staging-website', 'gtd-staging-chatgpt', 'gtd-staging-claude')
SERVICE = 'gtd-staging-administration'
RESOURCE_CLIENT = 'gtd-staging-resource'
MANAGED_ROLES = {'manage-users', 'view-users', 'query-users'}


def exact(actual, expected, context):
    for key, value in expected.items():
        if actual.get(key) != value:
            raise RuntimeError('Identity configuration drift: '+context+'/'+key)


def _configure(admin, manifest, website_secret, administration_secret, *, layout):
    require_layout(layout)
    realm_name = layout.realm
    clients = tuple(layout.client_id(role) for role in ('website', 'chatgpt', 'claude'))
    service_client = layout.client_id('administration')
    resource_client = layout.client_id('resource')
    if manifest.get('environment') != layout.environment or manifest.get('realm') != realm_name:
        raise RuntimeError('Identity bootstrap does not match the selected deployment')
    identity = str(uuid.UUID(manifest['database_identity']))
    issuer, resource, website = (manifest[key] for key in ('issuer', 'resource', 'website'))
    urls = [urlsplit(url) for url in (issuer, resource, website)]
    for url in urls:
        if url.scheme != 'https' or url.username or url.password or url.port or url.query or url.fragment:
            raise RuntimeError('Invalid identity URL')
        hostname(url.hostname, layout)
    if (urls[0].path != '/realms/'+realm_name or urls[1].path != '/mcp' or urls[2].path != '/'
            or len({u.netloc for u in urls}) != 3):
        raise RuntimeError('Invalid identity boundaries')
    if any(not isinstance(secret, str) or not 32 <= len(secret) <= 4096 for secret in (website_secret, administration_secret)):
        raise RuntimeError('Missing private client credential')
    if (admin.realm != realm_name or admin.issuer != issuer
            or admin.base != 'http://127.0.0.1:'+str(layout.ports['identity'])):
        raise RuntimeError('Private provider transport does not match the selected deployment')
    prefix = '/admin/realms/'+realm_name
    realm = {
        'realm': realm_name, 'enabled': True, 'displayName': 'GTD Test' if layout == STAGING else 'GTD', 'loginTheme': 'gtd',
        'registrationAllowed': False, 'resetPasswordAllowed': False,
        'loginWithEmailAllowed': False, 'editUsernameAllowed': False,
        'sslRequired': 'external', 'bruteForceProtected': True,
        'failureFactor': 5, 'waitIncrementSeconds': 60, 'maxFailureWaitSeconds': 900,
        'accessTokenLifespan': 120, 'revokeRefreshToken': True, 'refreshTokenMaxReuse': 0,
        'ssoSessionIdleTimeout': 43200, 'ssoSessionMaxLifespan': 43200,
        'offlineSessionIdleTimeout': 2592000, 'offlineSessionMaxLifespanEnabled': True,
        'offlineSessionMaxLifespan': 2592000,
        'eventsEnabled': True, 'eventsExpiration': 604800,
        'adminEventsEnabled': True, 'adminEventsDetailsEnabled': False,
        'attributes': {'gtd_'+layout.environment+'_database': identity},
    }
    existing = admin.request(prefix, missing=True)
    if existing is None:
        admin.request('/admin/realms', 'POST', realm)
        existing = admin.request(prefix)
    # Never adopt a similarly named realm or quietly overwrite changed policy.
    exact(existing, {k: v for k, v in realm.items() if k != 'attributes'}, 'realm')
    exact(existing.get('attributes', {}), realm['attributes'], 'realm-attributes')
    profile = admin.request(prefix+'/users/profile')
    profile['unmanagedAttributePolicy'] = None
    for attribute in profile['attributes']:
        if attribute['name'] in ('email', 'firstName', 'lastName'):
            attribute.pop('required', None)
    for name in ('gtd_account_id', 'gtd_generation'):
        expected = {'name': name, 'multivalued': False,
                    'permissions': {'view': ['admin'], 'edit': ['admin']},
                    'validations': {'length': {'max': 36}}}
        current = next((a for a in profile['attributes'] if a['name'] == name), None)
        if current is None: profile['attributes'].append(expected)
        else: exact(current, expected, 'attribute')
    admin.request(prefix+'/users/profile', 'PUT', profile)
    scopes = admin.request(prefix+'/client-scopes')
    if not any(s['name'] == 'gtd:access' for s in scopes):
        admin.request(prefix+'/client-scopes', 'POST', {'name': 'gtd:access', 'protocol': 'openid-connect',
            'attributes': {'include.in.token.scope': 'true', 'display.on.consent.screen': 'true', 'consent.screen.text': 'GTD'}})
    scopes = admin.request(prefix+'/client-scopes')
    if not {'basic', 'profile', 'roles', 'offline_access', 'gtd:access'} <= {s['name'] for s in scopes}:
        raise RuntimeError('Required provider scopes are missing')
    generation = {'name': 'gtd-generation', 'protocol': 'openid-connect',
        'protocolMapper': 'oidc-usermodel-attribute-mapper',
        'config': {'user.attribute': 'gtd_generation', 'claim.name': 'gtd_generation',
            'jsonType.label': 'String', 'access.token.claim': 'true', 'id.token.claim': 'true', 'multivalued': 'false'}}
    audience = {'name': 'gtd-resource', 'protocol': 'openid-connect', 'protocolMapper': 'oidc-audience-mapper',
        'config': {'included.client.audience': resource_client, 'access.token.claim': 'true', 'id.token.claim': 'false'}}
    definitions = [
        {'clientId': resource_client, 'enabled': True, 'protocol': 'openid-connect', 'bearerOnly': True,
         'attributes': {'resource_url': resource}},
        {'clientId': service_client, 'enabled': True, 'protocol': 'openid-connect', 'publicClient': False,
         'serviceAccountsEnabled': True, 'standardFlowEnabled': False,
         'directAccessGrantsEnabled': False, 'implicitFlowEnabled': False, 'secret': administration_secret},
    ]
    for client, callback in zip(clients, (website+'api/auth/callback',
            'https://chatgpt.com/connector_platform_oauth_redirect', 'https://claude.ai/api/mcp/auth_callback')):
        definition = {'clientId': client, 'enabled': True, 'protocol': 'openid-connect',
            'publicClient': client != clients[0], 'standardFlowEnabled': True, 'directAccessGrantsEnabled': False,
            'implicitFlowEnabled': False, 'serviceAccountsEnabled': False, 'redirectUris': [callback],
            'attributes': {'pkce.code.challenge.method': 'S256'},
            'defaultClientScopes': ['basic', 'profile', 'roles'], 'optionalClientScopes': ['gtd:access', 'offline_access'],
            'protocolMappers': [generation, audience]}
        if client == clients[0]: definition['secret'] = website_secret
        definitions.append(definition)
    if manifest.get('chatgpt_resource'):
        chatgpt_resource = manifest['chatgpt_resource']
        parsed = urlsplit(chatgpt_resource)
        if (parsed.scheme != 'https' or parsed.path != '/mcp' or parsed.port
                or parsed.username or parsed.password or parsed.query or parsed.fragment):
            raise RuntimeError('Invalid ChatGPT resource')
        hostname(parsed.hostname, layout)
        resource_id = layout.client_id('chatgpt')+'-resource'
        definitions.append({'clientId': resource_id, 'enabled': True, 'protocol': 'openid-connect',
            'bearerOnly': True, 'attributes': {'resource_url': chatgpt_resource}})
        client = next(d for d in definitions if d['clientId'] == clients[1])
        client['protocolMappers'] = [generation, {**audience, 'config': {
            **audience['config'], 'included.client.audience': resource_id}}]
        # Some ChatGPT connection dialogs request email automatically. No email is
        # required for GTD identities; this scope never changes account binding.
        client['optionalClientScopes'].append('email')
    if 'integrations' in manifest:
        for integration in ('chatgpt','claude'):
            next(d for d in definitions if d['clientId']==layout.client_id(integration))['enabled'] = integration in manifest['integrations']
    observed = admin.request(prefix+'/clients')
    for definition in definitions:
        current = next((c for c in observed if c['clientId'] == definition['clientId']), None)
        if current is None:
            admin.request(prefix+'/clients', 'POST', definition)
        else:
            comparable = {k: v for k, v in definition.items() if k not in ('secret', 'protocolMappers', 'defaultClientScopes', 'optionalClientScopes')}
            # Keycloak supplies additional operational attributes; expected keys
            # must match, but unrelated provider defaults are not user policy.
            attributes = comparable.pop('attributes', {})
            exact(current, comparable, 'client')
            exact(current.get('attributes', {}), attributes, 'client-attributes')
            for key in ('defaultClientScopes', 'optionalClientScopes'):
                if key in definition and set(current.get(key, [])) != set(definition[key]):
                    raise RuntimeError('Identity client scopes drifted')
            for mapper in definition.get('protocolMappers', []):
                match = next((m for m in current.get('protocolMappers', []) if m['name'] == mapper['name']), {})
                exact(match, {k: v for k, v in mapper.items() if k != 'config'}, 'mapper')
                exact(match.get('config', {}), mapper['config'], 'mapper-config')
            if 'secret' in definition:
                saved = admin.request(prefix+'/clients/'+current['id']+'/client-secret')['value']
                if saved != definition['secret']: raise RuntimeError('Identity client credential mismatch')
    observed = admin.request(prefix+'/clients')
    service = next(c for c in observed if c['clientId'] == service_client)
    management = next(c for c in observed if c['clientId'] == 'realm-management')
    user = admin.request(prefix+'/clients/'+service['id']+'/service-account-user')
    roles = admin.request(prefix+'/clients/'+management['id']+'/roles')
    path = prefix+'/users/'+user['id']+'/role-mappings/clients/'+management['id']
    existing_roles = admin.request(path)
    if {r['name'] for r in existing_roles} - MANAGED_ROLES:
        raise RuntimeError('Unexpected privileges on administration client')
    admin.request(path, 'POST', [r for r in roles if r['name'] in MANAGED_ROLES])
    return {'environment': layout.environment, 'realm': realm_name, 'database_identity': identity,
            'clients': [d['clientId'] for d in definitions], 'accounts_created': 0}



def configure(admin, manifest, website_secret, administration_secret):
    """Existing staging entry point; it cannot select production."""
    return _configure(admin, manifest, website_secret, administration_secret, layout=STAGING)


def configure_production(admin, manifest, website_secret, administration_secret):
    """Private production operator step; does not enroll users or open ingress."""
    return _configure(admin, manifest, website_secret, administration_secret, layout=PRODUCTION)
