# Pinned Keycloak build

The deployment uses Keycloak **26.8.1** with a four-line upstream backport that
preserves the MCP resource binding during offline-token renewal. This dependency
also enables Keycloak's experimental resource-binding feature. Dynamic client
registration and experimental CIMD are not enabled.

`python3 deploy/build.py` builds the patched image and then the application images.
The builder pins the base/JDK images, source file digest and patch digest; compiles
only the changed class family; and verifies that every other entry in the provider
JAR remains byte-identical. Its generated `build.json` records the inputs, output
image ID and verification evidence under ignored `artifacts/`.

The inspected patch is [keycloak-offline-resource.patch](keycloak-offline-resource.patch),
from [upstream fix 4e4578e](https://github.com/keycloak/keycloak/commit/4e4578e57544965d8691de42f1aa6b65075491e7).
The [builder](build-keycloak-patch.py) contains the exact upstream source and image
references. [NOTICE](NOTICE) and [LICENSE](LICENSE) accompany this Apache-2.0
component. A future stock release may replace the patch only after rerunning
OAuth linking, resource/audience rejection, refresh, revocation and recovery tests.
Do not change the provider version as part of an unrelated application upgrade.

Checked **November 10, 2026**: the latest stable release,
[26.8.2](https://github.com/keycloak/keycloak/releases/tag/26.8.2), still lacks this
fix. Its offline-refresh branch recreates the session context without preserving
`GRANT_TYPE` and `RESOURCE`; the four-line patch applies cleanly to the
[released TokenManager source](https://github.com/keycloak/keycloak/blob/26.8.2/services/src/main/java/org/keycloak/protocol/oidc/TokenManager.java).
Updating to stock 26.8.2 would therefore reintroduce the renewal bug. Retain the
tested build until a stable release includes the fix and passes the checks above.
