#!/usr/bin/env python3
"""Shared offline deployment configuration; explicit fixed layouts, no activation.

Staging and production entry points select separate immutable layouts. This module
never connects to a provider, publishes ingress, starts services or enrolls users.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import uuid
from dataclasses import dataclass
from types import MappingProxyType

POSTGRES = 'postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c'
MEILI = 'getmeili/meilisearch:v1.54.3@sha256:e68913ab7d6f5b159529e472cfd362ce3c741fafd3c127961b2142abbe41b3c9'
ROOT = Path(__file__).resolve().parents[2]


@dataclass(frozen=True)
class Layout:
    environment: str
    realm: str
    project: str
    database: str
    identity_database: str
    base_port: int

    @property
    def ports(self):
        return MappingProxyType({name: self.base_port+offset for name, offset in (
            ('service',0), ('website',1), ('identity',2), ('adapter',3),
            ('database',4), ('public_gateway',5), ('search',6), ('identity_health',8))})

    def client_id(self, role):
        if role not in ('website','chatgpt','claude','administration','resource'):
            raise ValueError('Unknown identity client role')
        return self.realm+'-'+role


STAGING = Layout('staging','gtd-staging','gtd-multi-user-staging','gtd_staging','gtd_staging_identity',19541)
PRODUCTION = Layout('production','gtd','gtd-multi-user-production','gtd_production','gtd_production_identity',20541)


def require_layout(layout):
    if layout not in (STAGING, PRODUCTION):
        raise ValueError('Only the defined independent deployment layouts are supported')


def hostname(value, layout):
    require_layout(layout)
    if not isinstance(value, str) or len(value) > 253 or not re.fullmatch(
            r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+', value):
        raise ValueError('Expected a canonical hostname without scheme, port or path')
    if any(len(part) > 63 for part in value.split('.')):
        raise ValueError('Invalid hostname length')
    labels = value.split('.')[0].split('-')
    if layout == STAGING:
        if 'staging' not in labels:
            raise ValueError('Staging requires distinct staging hostnames')
    elif any(part in ('staging','checkpoint','test') for part in labels):
        raise ValueError('Production cannot reuse staging/checkpoint/test hostnames')
    return value


def image_id(value):
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', value):
        raise ValueError('Use the exact local image ID, not a mutable tag')
    return value


def write(path, text):
    with path.open('x') as output:
        os.chmod(path, 0o600)
        output.write(text)


def write_json(path, value):
    write(path, json.dumps(value, indent=2) + '\n')


def mount(source, target, *, readonly=True):
    return {'type': 'bind', 'source': str(source), 'target': target,
            'read_only': readonly, 'bind': {'create_host_path': False}}


def schema_text(identity, layout):
    require_layout(layout)
    source = ''.join((ROOT / 'src/postgres' / name).read_text() for name in (
        'schema.sql', 'administration.sql', 'settings.sql', 'activity.sql',
        'timed_holds_index.sql', 'sessions.sql'))
    if not source.endswith('COMMIT;\n'):
        raise ValueError('Schema transaction boundary changed; review deployment bootstrap')
    identity = str(uuid.UUID(str(identity)))
    return source[:-len('COMMIT;\n')] + (
        "INSERT INTO gtd.schema_meta VALUES(true,13,'" + layout.environment + "','" + identity + "');\nCOMMIT;\n")


def gateway(auth, mcp, website, layout):
    require_layout(layout)
    template = '''{
    admin off
    persist_config off
    auto_https off
    servers {
        trusted_proxies static 127.0.0.1/32
        client_ip_headers CF-Connecting-IP
        trusted_proxies_strict
    }
}

http://:WEBSITE_PORT {
    bind 127.0.0.1
    request_body {
        max_size 4MB
    }
    @website host WEBSITE_HOST
    handle @website {
        @internal path /internal /internal/*
        respond @internal 404
        reverse_proxy 127.0.0.1:SERVICE_PORT
    }
    respond 404
}

http://:PUBLIC_GATEWAY_PORT {
    bind 127.0.0.1
    header Cache-Control "no-store"
    header X-Content-Type-Options "nosniff"
    request_body {
        max_size 4MB
    }
    @identity host AUTH_HOST
    handle @identity {
        @discovery path /.well-known/oauth-authorization-server/realms/REALM_NAME
        rewrite @discovery /realms/REALM_NAME/.well-known/openid-configuration
        @browser path /realms/REALM_NAME/.well-known/* /realms/REALM_NAME/protocol/openid-connect/* /realms/REALM_NAME/login-actions/* /realms/REALM_NAME/account /realms/REALM_NAME/account/* /resources/*
        handle @browser {
            reverse_proxy 127.0.0.1:IDENTITY_PORT {
                header_up -Forwarded
                header_up -X-Forwarded-Prefix
                header_up X-Forwarded-Proto https
                header_up X-Forwarded-Host AUTH_HOST
                header_up X-Forwarded-Port 443
                header_up X-Forwarded-For {client_ip}
            }
        }
        respond 404
    }
    @mcp host MCP_HOST
    handle @mcp {
        @metadata {
            method GET
            path /.well-known/oauth-protected-resource /.well-known/oauth-protected-resource/mcp
        }
        handle @metadata {
            reverse_proxy 127.0.0.1:ADAPTER_PORT
        }
        # Validated checkpoint range; recheck the published source before ingress.
        # https://platform.claude.com/docs/en/api/ip-addresses
        @claude {
            path /mcp
            client_ip 160.79.104.0/21
        }
        handle @claude {
            reverse_proxy 127.0.0.1:ADAPTER_PORT
        }
        respond 403
    }
    respond 404
}
'''

    replacements = {'AUTH_HOST': auth, 'MCP_HOST': mcp, 'WEBSITE_HOST': website, 'REALM_NAME': layout.realm}
    replacements.update({name.upper()+'_PORT': str(port) for name, port in layout.ports.items()})
    for key, value in replacements.items(): template = template.replace(key, value)
    return template


INIT_TEMPLATE = r'''-- Applied only to a new database directory, with ON_ERROR_STOP.
-- Interrupted initialization must be inspected, not silently recreated.
\getenv runtime_password GTD_RUNTIME_PASSWORD
\getenv identity_password GTD_IDENTITY_PASSWORD
CREATE ROLE gtd_owner NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE gtd_runtime LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'runtime_password';
CREATE ROLE gtd_identity LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'identity_password';
CREATE DATABASE APPLICATION_DATABASE TEMPLATE template0;
CREATE DATABASE IDENTITY_DATABASE OWNER gtd_identity TEMPLATE template0;
REVOKE ALL ON DATABASE APPLICATION_DATABASE, IDENTITY_DATABASE FROM PUBLIC;
GRANT CONNECT ON DATABASE APPLICATION_DATABASE TO gtd_runtime;
GRANT CREATE ON DATABASE APPLICATION_DATABASE TO gtd_owner;
GRANT CONNECT ON DATABASE IDENTITY_DATABASE TO gtd_identity;
\connect APPLICATION_DATABASE
REVOKE ALL ON SCHEMA public FROM PUBLIC;
\i /bootstrap/schema.sql
'''


def bootstrap_sql(layout):
    require_layout(layout)
    return INIT_TEMPLATE.replace('APPLICATION_DATABASE', layout.database).replace('IDENTITY_DATABASE', layout.identity_database)


def prepare(root, *, layout, auth_host, mcp_host, website_host, service_image, adapter_image,
            identity_image, gateway_image, uid=1000, gid=1000):
    require_layout(layout)
    address = lambda name: "127.0.0.1:"+str(layout.ports[name])
    hosts = [hostname(h, layout) for h in (auth_host, mcp_host, website_host)]
    if len(set(hosts)) != 3:
        raise ValueError('Website, identity and MCP hostnames must be distinct')
    images = {key: image_id(value) for key, value in (
        ('service', service_image), ('adapter', adapter_image), ('identity', identity_image), ('gateway', gateway_image))}
    if type(uid) is not int or type(gid) is not int or uid < 1 or gid < 1:
        raise ValueError('Serving processes require non-root UID/GID')
    root = Path(root)
    # Compose interpolates dollars even in JSON. Reject them rather than risk
    # changed bind paths; symlinked ancestors may target another deployment.
    if not root.is_absolute() or root != root.resolve() or re.search(r'[\x00-\x20$]', str(root)):
        raise ValueError('Use an absolute, canonical directory without whitespace or dollar signs')
    if root.exists():
        raise ValueError('Refusing to overwrite existing deployment state')
    identity = str(uuid.uuid4())
    schema = schema_text(identity, layout)
    old_mask = os.umask(0o077)
    try:
        root.mkdir(mode=0o700)  # Parent must already exist; never create arbitrary ancestors.
        for directory in ('database', 'identity', 'service', 'adapter', 'gateway', 'search', 'logs', 'operator'):
            (root / directory).mkdir(mode=0o700)
        passwords = {name: secrets.token_urlsafe(32) for name in (
            'database', 'runtime', 'identity', 'bootstrap', 'website', 'administration', 'search')}
        write(root / 'database/environment', '\n'.join([
            'POSTGRES_USER=postgres', 'POSTGRES_DB=postgres', 'POSTGRES_PASSWORD='+passwords['database'],
            'POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256',
            'GTD_RUNTIME_PASSWORD='+passwords['runtime'], 'GTD_IDENTITY_PASSWORD='+passwords['identity']])+'\n')
        write(root / 'database/init.sql', bootstrap_sql(layout))
        write(root / 'database/schema.sql', schema)
        # Nonsecret bootstrap sources are mounted as individual files into the
        # postgres UID. The containing host directory stays private (0700).
        (root / 'database/init.sql').chmod(0o644)
        (root / 'database/schema.sql').chmod(0o644)
        write(root / 'identity/environment', '\n'.join([
            'KC_DB=postgres', 'KC_DB_URL=jdbc:postgresql://'+address('database')+'/'+layout.identity_database,
            'KC_DB_USERNAME=gtd_identity', 'KC_DB_PASSWORD='+passwords['identity'],
            'KC_BOOTSTRAP_ADMIN_USERNAME='+layout.realm+'-operator', 'KC_BOOTSTRAP_ADMIN_PASSWORD='+passwords['bootstrap']])+'\n')
        write(root / 'service/runtime.dsn', 'host=127.0.0.1 port='+str(layout.ports['database'])+' dbname='+layout.database+' user=gtd_runtime password='+passwords['runtime']+'\n')
        for name in ('website', 'administration', 'search'):
            write(root / 'service' / (name+'.secret'), passwords[name]+'\n')
        write(root / 'search/environment', 'MEILI_MASTER_KEY='+passwords['search']+'\n')
        (root / 'search/data').mkdir(mode=0o700)
        issuer = 'https://'+auth_host+'/realms/'+layout.realm
        resource = 'https://'+mcp_host+'/mcp'
        write_json(root / 'service/config.json', {
            'environment': layout.environment, 'listen': address('service'), 'database_identity': identity,
            'database_dsn_file': '/config/runtime.dsn', 'pool_size': 8, 'issuer': issuer, 'resource': resource,
            'protected_resource_metadata': 'https://'+mcp_host+'/.well-known/oauth-protected-resource/mcp',
            'search_url': 'http://'+address('search'), 'search_key_file': '/config/search.secret',
            'background': False, 'diagnostics_file': '/logs/service.db',
            'website': {'origin': 'https://'+website_host+'/', 'client_id': layout.client_id('website'),
                'client_secret_file': '/config/website.secret', 'provider_private_url': 'http://'+address('identity')+'/',
                'realm': layout.realm, 'administration_client_id': layout.client_id('administration'),
                'administration_secret_file': '/config/administration.secret',
                'oauth_clients': [layout.client_id('website'), layout.client_id('chatgpt'), layout.client_id('claude')]}})
        write_json(root / 'adapter/config.json', {
            'environment': layout.environment, 'port': layout.ports['adapter'], 'backendOrigin': 'http://'+address('service'),
            'issuer': issuer, 'resource': resource, 'ingresses': [
                {'host': mcp_host, 'metadataOrigin': 'https://'+mcp_host, 'uiHost': 'claude'},
                {'host': address('adapter'), 'metadataOrigin': 'http://'+address('adapter'), 'uiHost': 'openai'}]})
        write(root / 'gateway/Caddyfile', gateway(auth_host, mcp_host, website_host, layout))
        common = {'network_mode': 'host', 'restart': 'unless-stopped', 'read_only': True,
            'cap_drop': ['ALL'], 'security_opt': ['no-new-privileges:true'], 'pids_limit': 256,
            'stop_grace_period': '30s', 'logging': {'driver': 'json-file', 'options': {'max-size': '5m', 'max-file': '2'}}}
        def process(image, memory, user, tmpfs):
            return {**common, 'image': image, 'user': user, 'mem_limit': memory, 'cpus': '2.0', 'tmpfs': tmpfs}
        app_user = f'{uid}:{gid}'
        temporary = [f'/tmp:rw,size=32m,uid={uid},gid={gid}']
        services = {
            'database': {**process(POSTGRES, '768m', '999:999', ['/tmp:rw,size=32m,uid=999,gid=999', '/var/run/postgresql:rw,size=16m,uid=999,gid=999']),
                'env_file': [str(root/'database/environment')],
                'command': ['postgres', '-c', 'listen_addresses=127.0.0.1', '-p', str(layout.ports['database']), '-c', 'max_connections=80'],
                'volumes': ['application-data:/var/lib/postgresql', mount(root/'database/init.sql', '/docker-entrypoint-initdb.d/10-gtd.sql'), mount(root/'database/schema.sql', '/bootstrap/schema.sql')],
                'healthcheck': {'test': ['CMD', 'pg_isready', '-q', '-h', '127.0.0.1', '-p', str(layout.ports['database']), '-U', 'postgres'], 'interval': '5s', 'timeout': '3s', 'retries': 30}},
            'identity': {**process(identity_image, '1g', app_user, temporary+[f'/opt/keycloak/data:rw,size=64m,uid={uid},gid={gid}']),
                'env_file': [str(root/'identity/environment')], 'depends_on': {'database': {'condition': 'service_healthy'}},
                'command': ['start', '--optimized', '--http-enabled=true', '--http-host=127.0.0.1', '--http-port='+str(layout.ports['identity']),
                    '--http-management-host=127.0.0.1', '--http-management-port='+str(layout.ports['identity_health']), '--hostname=https://'+auth_host,
                    '--proxy-headers=xforwarded', '--proxy-trusted-addresses=127.0.0.1', '--log-level=warn']},
            'search': {**process(MEILI, '512m', app_user, temporary), 'env_file': [str(root/'search/environment')],
                'working_dir': '/data',
                'environment': {'MEILI_ENV': 'production', 'MEILI_HTTP_ADDR': address('search'), 'MEILI_NO_ANALYTICS': 'true',
                    'MEILI_DB_PATH': '/data/index', 'MEILI_DUMP_DIR': '/data/dumps', 'MEILI_SNAPSHOT_DIR': '/data/snapshots',
                    'MEILI_MAX_INDEXING_THREADS': '1', 'MEILI_MAX_INDEXING_MEMORY': '256 MiB'},
                'volumes': [mount(root/'search/data', '/data', readonly=False)]},
            'service': {**process(service_image, '512m', app_user, temporary), 'profiles': ['application'],
                'depends_on': {'database': {'condition': 'service_healthy'}, 'identity': {'condition': 'service_started'}, 'search': {'condition': 'service_started'}},
                'command': ['/config/config.json'], 'volumes': [mount(root/'service', '/config'), mount(root/'logs', '/logs', readonly=False)],
                'healthcheck': {'test': ['CMD', 'curl', '-fsS', '--max-time', '2', 'http://'+address('service')+'/internal/ready'], 'interval': '10s', 'timeout': '3s', 'retries': 6}},
            'adapter': {**process(adapter_image, '256m', app_user, temporary), 'profiles': ['application'],
                'depends_on': {'service': {'condition': 'service_healthy'}}, 'command': ['/config/config.json'],
                'volumes': [mount(root/'adapter', '/config')]},
            'gateway': {**process(gateway_image, '128m', app_user, temporary),
                'command': ['caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
                'volumes': [mount(root/'gateway/Caddyfile', '/etc/caddy/Caddyfile')]},
        }
        write_json(root/'compose.json', {'name': layout.project, 'services': services,
            'volumes': {'application-data': {}}})
        manifest = {'format': 1, 'environment': layout.environment, 'database_identity': identity,
            'realm': layout.realm, 'issuer': issuer, 'resource': resource, 'website': 'https://'+website_host+'/',
            'ports': dict(layout.ports), 'images': images, 'uid': uid, 'gid': gid, 'schema_sha256': hashlib.sha256(schema.encode()).hexdigest(),
            'application_enabled': False, 'background_enabled': False, 'ingress_published': False}
        write_json(root/'manifest.json', manifest)
        return manifest
    finally:
        os.umask(old_mask)


