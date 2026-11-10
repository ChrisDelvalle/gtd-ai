# Dependency review

Run `cargo deny check`, both `npm audit` commands, and the full deterministic
suite when updating dependencies. Direct JavaScript versions and the Keycloak
build inputs are pinned; lockfiles pin the full dependency graphs. CI does not
silently update them. Treat dictionary data and icons as assets with licensing
requirements as well as library code.

## Narrow advisory exceptions

The locked OpenID Connect library (`openidconnect 4.0.1`) depends on `rsa 0.9.10`
and `crypto-bigint 0.5.5`. These versions have private-key timing advisories
[RUSTSEC-2023-0071](https://rustsec.org/advisories/RUSTSEC-2023-0071.html) and
[RUSTSEC-2026-0387](https://rustsec.org/advisories/RUSTSEC-2026-0387.html).
GTD uses the library to verify provider ID-token signatures with public keys.
It does not load RSA private keys, sign tokens, or decrypt RSA ciphertexts with
these crates. Provider signing remains inside Keycloak; bearer verification uses
the separately configured JWT verifier.

The two exceptions in `deny.toml` apply only to that reviewed use. The repository
check pins the affected chain and rejects new private-key use in source. Review
and remove the exceptions when the upstream OIDC library adopts the fixed RSA
major version. Do not copy these exceptions into a signing/decryption service.

All other advisory findings from the preparation audit were resolved by updating
the affected lockfile entries and retesting. This is a point-in-time assessment;
future CI advisory results take precedence.

## Redistributed notices

The frontend build emits `THIRD_PARTY_NOTICES.txt` and preserves inline legal
comments. Rust notices are assembled from the locked crates and the checked-in,
commit-pinned upstream license files in `third_party/licenses/`. Dictionary
notices are included too. The identity patch retains its own Apache-2.0 license
and upstream notices under `deploy/keycloak/`.
