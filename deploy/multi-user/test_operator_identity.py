"""Private operator guards; actual provider transition uses the recovery fixture."""
import json
from pathlib import Path
import tempfile
import types
import unittest
import uuid

from operator_identity import load_operator, private_read, replace_bootstrap


class OperatorBoundary(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='gtd-operator-check-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.identity, self.subject = str(uuid.uuid4()), str(uuid.uuid4())
        self.manifest = {'environment': 'staging', 'realm': 'gtd-staging',
            'issuer': 'https://auth-staging.example.invalid/realms/gtd-staging',
            'database_identity': self.identity}
        self.admin = types.SimpleNamespace(realm='gtd-staging', issuer=self.manifest['issuer'])

    def test_foreign_manifest_is_rejected_before_provider_access(self):
        for field, value in [('environment', 'unknown'), ('realm', 'master'),
                             ('issuer', 'https://unrelated.invalid/realms/gtd-staging'),
                             ('database_identity', 'not-a-uuid')]:
            with self.subTest(field=field), self.assertRaises((RuntimeError, ValueError)):
                replace_bootstrap(self.admin, {**self.manifest, field:value}, self.root/'operator.json', self.subject)
            self.assertFalse((self.root/'operator.json').exists())

    def test_private_bounded_credential_files_and_no_symlink(self):
        path = self.root/'operator.json'
        path.write_text('{}'); path.chmod(0o600)
        self.assertEqual(private_read(path), {})
        link = self.root/'link'; link.symlink_to(path)
        with self.assertRaises(OSError): private_read(link)
        path.chmod(0o644)
        with self.assertRaises(RuntimeError): private_read(path)
        path.chmod(0o600); path.write_text(' '*8193)
        with self.assertRaises(RuntimeError): private_read(path)

    def test_foreign_journal_is_never_adopted_or_overwritten(self):
        path = self.root/'operator.json'
        content = json.dumps({'database_identity': str(uuid.uuid4()), 'secret':'kept'})
        path.write_text(content); path.chmod(0o600)
        with self.assertRaisesRegex(RuntimeError, 'different deployment'):
            replace_bootstrap(self.admin, self.manifest, path, self.subject)
        self.assertEqual(path.read_text(), content)
        self.root.chmod(0o755)
        try:
            with self.assertRaisesRegex(RuntimeError, 'private canonical'):
                replace_bootstrap(self.admin, self.manifest, self.root/'other.json', self.subject)
        finally:
            self.root.chmod(0o700)

    def test_recovery_requires_completed_matching_operator_enrollment(self):
        path = self.root/'operator.json'
        state = {**self.manifest, 'format': 1, 'completed': True,
            'client_id': 'gtd-private-operator-'+self.identity, 'secret': 's'*64,
            'client_uuid': str(uuid.uuid4())}
        for key, value in [('database_identity', str(uuid.uuid4())), ('completed', False),
                ('issuer', 'https://other.invalid'), ('client_id', 'gtd-staging-administration'),
                ('environment', 'production'), ('secret', '')]:
            path.write_text(json.dumps({**state, key:value})); path.chmod(0o600)
            with self.subTest(field=key), self.assertRaisesRegex(RuntimeError, 'completed deployment'):
                load_operator(self.admin, self.manifest, path)


if __name__ == '__main__': unittest.main()
