# Operations

Use the same checkout and ignored installation configuration used to create the
installation. Every state-changing command requires its immutable database ID.
Keep the source checkout separate from application state.

```sh
python3 deploy/gtd.py --expected-database "$DATABASE_ID" status
python3 deploy/gtd.py --expected-database "$DATABASE_ID" stop
python3 deploy/gtd.py --expected-database "$DATABASE_ID" start
```

Stopping retains databases and search state. Never use `docker compose down -v`
as an upgrade command. Keep application and provider administration private.

## Encrypted backups

Install Restic and keep the backup repository separate from live database storage.
The installer creates a random backup password at `operator/backup.secret` inside
your private state directory. Keep an independently protected copy of that file:
losing it makes the encrypted repository unrecoverable.

```sh
python3 deploy/gtd.py --expected-database "$DATABASE_ID" \
  --repository /path/to/backup-repository backup-init
python3 deploy/gtd.py --expected-database "$DATABASE_ID" \
  --repository /path/to/backup-repository backup
```

Capture coordinates account lifecycle changes and exports consistent application
and identity snapshots, recording each capture time. Before saving the payload to
Restic, it restores it into disposable databases and verifies table counts and
identity/account mappings. Essential configuration and operator recovery material
are included. Search indexes are derived and can be rebuilt.

The backup command does not prune snapshots. Keep an independent encrypted copy,
verify it with `restic check --read-data`, and rehearse recovery. Do not delete the
last verified recovery point. Copying files on the same disk is not an independent
backup. Do not store a repository password alongside a publicly accessible copy.

## Recovery and upgrades

Recovery must target a new empty state directory with all public ingress stopped.
Use the explicit recovery command described by `python3 deploy/recover.py --help`.
It verifies the backup, restores the paired databases and configuration, invalidates
application sessions/cursors, and revokes provider grants before enabling access.
It never overwrites an existing installation or starts public ingress.

```sh
python3 deploy/recover.py --repository /path/to/backup-repository \
  --password-file /path/to/private/backup.secret \
  --snapshot "$SNAPSHOT_ID" --expected-database "$DATABASE_ID" \
  --state-dir /srv/gtd-restored
```

Use the full snapshot ID printed by the backup command, not `latest`. Build the
matching source first so the pinned application and identity images are available.
Point a copy of the original installation configuration at the new state directory;
keep its hostnames and identity settings unchanged. Failed recovery attempts stay
private for inspection and cannot be started. Retry into another empty directory.

After recovery, resolve the original failed installation before routing clients
to the recovered one. Do not let two independent writers serve the same identity
and hostname. Rebuild derived search state and require users to sign in again.

For an upgrade, first make a verified backup and retain the current source revision,
image IDs, and runtime configuration. Stop the adapter and application writers;
build and test the candidate on disposable data. Run required compatibility-guarded
operator migrations before starting the new service. Recheck readiness, sign-in,
account isolation, MCP discovery, and widget assets before reopening use.

`python3 deploy/upgrade.py --help` provides paired image switching and retained
configuration for same-schema upgrades. It requires an explicit database ID and a
fresh verified backup. It does not automatically migrate or downgrade schema.

```sh
python3 deploy/upgrade.py --expected-database "$DATABASE_ID" \
  --service-image "$SERVICE_IMAGE_ID" --adapter-image "$ADAPTER_IMAGE_ID"
```

Both image arguments are immutable local `sha256:` IDs. For a same-schema rollback,
use the preceding pair recorded in the private release journal with this same
command, after a fresh verified backup. No authoritative records are replaced.

Rollback can restore the previous application images when they support the current
schema. Never restore an old database snapshot over subsequent user writes. If a
migration changes compatibility, use its separately rehearsed rollback procedure
or reconcile later writes explicitly. A failed upgrade must leave evidence and
preserve both release configurations.
