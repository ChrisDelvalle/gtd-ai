# Security policy

Please report vulnerabilities privately through this repository's **Security →
Report a vulnerability** control once private reporting is enabled. Do not open a
public issue with exploit details, tokens, or personal task content. Before that
channel is available, keep vulnerability details private and ask the maintainer
to enable it without disclosing the issue publicly.

Include the affected revision, deployment topology, impact, and a minimal
reproduction using disposable accounts. Redact credentials and unrelated data.
There is no promised response SLA or paid bounty.

Security fixes target the current release. Deployment operators remain responsible
for HTTPS, host access, secret storage, backups, identity-provider maintenance,
and updating pinned dependencies. See [the security model](docs/security.md).

This project has deterministic security tests, not a certification or independent
penetration-test claim. Never reuse the public signing fixtures in an installation.
