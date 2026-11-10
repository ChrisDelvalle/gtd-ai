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

The inspected patch is [keycloak-offline-resource.patch](keycloak-offline-resource.patch).
The [builder](build-keycloak-patch.py) contains the exact upstream source and image
references. [NOTICE](NOTICE) and [LICENSE](LICENSE) accompany this Apache-2.0
component. A future stock release may replace the patch only after rerunning
OAuth linking, resource/audience rejection, refresh, revocation and recovery tests.
Do not change the provider version as part of an unrelated application upgrade.
