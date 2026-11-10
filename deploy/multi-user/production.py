#!/usr/bin/env python3
"""Prepare a private production candidate; never activate it or change ingress.

This creates only new local files. Migration, identity enrollment, backups and
cutover require their separate operator checkpoints before any writers start.
"""
import argparse
import json
from pathlib import Path

from stack_config import PRODUCTION, prepare as _prepare


def prepare(root, **options):
    return _prepare(root, layout=PRODUCTION, **options)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    for field in ('auth-host', 'mcp-host', 'website-host', 'service-image',
                  'adapter-image', 'identity-image', 'gateway-image'):
        parser.add_argument('--'+field, required=True)
    parser.add_argument('--uid', type=int, default=1000)
    parser.add_argument('--gid', type=int, default=1000)
    args = vars(parser.parse_args())
    manifest = prepare(args.pop('directory'), **args)
    print(json.dumps({'environment': manifest['environment'],
        'database_identity': manifest['database_identity'], 'services_started': False,
        'ingress_published': False, 'credentials_printed': False}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError):
        raise SystemExit('Production preparation failed; existing state was not overwritten. '
                         'Check private operator configuration.') from None
