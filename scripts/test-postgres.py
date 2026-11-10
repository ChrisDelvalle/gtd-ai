#!/usr/bin/env python3
"""Run bounded deterministic integration tests in freshly created containers."""
from pathlib import Path
import subprocess
root=Path(__file__).resolve().parents[1]
image='postgres:18.6-bookworm@sha256:afc7e2d441324c0388fa80c3d24f733b4194a4eb7f47dd8ee2b08eb1a24a647c'
subprocess.run(['docker','pull',image],check=True)
# These tests do not accept a DSN. Each generates its own password and database.
tests=[
 'postgres::tests::',
 'postgres::read_tests::',
 'postgres::write_tests::',
 'postgres::identity_tests::verified_http_identity_resolves_current_account_without_username_fallback',
 'postgres::website_tests::',
 'postgres::activity_tests::',
 'postgres::administration::tests::',
]
for name in tests:
 subprocess.run(['cargo','test','--locked','--features','postgres-operator','--lib',name,'--','--ignored','--test-threads=1'],cwd=root,check=True,timeout=600)
