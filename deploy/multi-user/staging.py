#!/usr/bin/env python3
"""Prepare a new private staging stack. Never selects or changes production."""
import argparse
import json
from pathlib import Path

from stack_config import (STAGING, ROOT, POSTGRES, MEILI, image_id, write, write_json, mount,
                          hostname as _hostname, schema_text as _schema_text,
                          gateway as _gateway, bootstrap_sql, prepare as _prepare)

REALM = STAGING.realm
PORTS = dict(STAGING.ports)
INIT = bootstrap_sql(STAGING)


def hostname(value): return _hostname(value, STAGING)

def schema_text(identity): return _schema_text(identity, STAGING)

def gateway(auth, mcp, website): return _gateway(auth, mcp, website, STAGING)

def prepare(root, **options): return _prepare(root, layout=STAGING, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    for field in ('auth-host', 'mcp-host', 'website-host', 'service-image', 'adapter-image', 'identity-image', 'gateway-image'):
        parser.add_argument('--'+field, required=True)
    parser.add_argument('--uid', type=int, default=1000)
    parser.add_argument('--gid', type=int, default=1000)
    args = vars(parser.parse_args())
    manifest = prepare(args.pop('directory'), **args)
    print(json.dumps({'environment': manifest['environment'], 'database_identity': manifest['database_identity'],
                      'services_started': False, 'credentials_printed': False}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError):
        raise SystemExit('Staging preparation failed; existing state was not overwritten. Check private operator configuration.') from None
