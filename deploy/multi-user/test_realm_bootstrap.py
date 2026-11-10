"""Staging operator-boundary checks; no provider or account access."""
import unittest
import uuid
from realm_bootstrap import configure, configure_production


class NoProvider:
    def request(self, *_args, **_kwargs):
        raise AssertionError('Invalid setup must fail before contacting a provider')


class BootstrapBoundary(unittest.TestCase):
    def test_invalid_environment_or_origins_cannot_reach_provider(self):
        valid = {'environment': 'staging', 'realm': 'gtd-staging', 'database_identity': str(uuid.uuid4()),
            'issuer': 'https://auth-staging.example.invalid/realms/gtd-staging',
            'resource': 'https://mcp-staging.example.invalid/mcp', 'website': 'https://todo-staging.example.invalid/'}
        for key, value in (
            ('environment', 'production'), ('realm', 'master'), ('database_identity', 'invalid'),
            ('issuer', 'https://auth-checkpoint.example.com/realms/gtd-staging'),
            ('website', 'https://todo.example.com/'), ('resource', 'http://mcp-staging.example.invalid/mcp'),
            ('issuer', 'https://auth-staging.example.invalid/realms/production'),
            ('resource', 'https://auth-staging.example.invalid/mcp'),
            ('website', 'https://name:credential@todo-staging.example.invalid/'),
        ):
            with self.subTest(field=key):
                with self.assertRaises((RuntimeError, ValueError)):
                    configure(NoProvider(), {**valid, key: value}, 'a'*32, 'b'*32)
        with self.assertRaises(RuntimeError): configure(NoProvider(), valid, '', 'b'*32)

    def test_production_entry_rejects_staging_and_mismatched_transport(self):
        valid = {'environment':'production','realm':'gtd','database_identity':str(uuid.uuid4()),
            'issuer':'https://auth.example.invalid/realms/gtd','resource':'https://mcp.example.invalid/mcp',
            'website':'https://todo.example.invalid/'}
        for key, value in (('environment','staging'), ('realm','gtd-staging'),
            ('issuer','https://auth-staging.example.invalid/realms/gtd'),
            ('resource','https://mcp-checkpoint.example.invalid/mcp'),
            ('website','https://todo.example.invalid/?next=https://elsewhere.invalid')):
            with self.subTest(field=key):
                with self.assertRaises((RuntimeError,ValueError)):
                    configure_production(NoProvider(),{**valid,key:value},'a'*32,'b'*32)
        for field, value in (('realm','gtd-staging'),('issuer','https://other.example.invalid/realms/gtd'),
                             ('base','http://127.0.0.1:19543')):
            admin = NoProvider()
            admin.realm, admin.issuer, admin.base = 'gtd', valid['issuer'], 'http://127.0.0.1:20543'
            setattr(admin,field,value)
            with self.subTest(transport=field):
                with self.assertRaises(RuntimeError): configure_production(admin,valid,'a'*32,'b'*32)


if __name__ == '__main__': unittest.main()
