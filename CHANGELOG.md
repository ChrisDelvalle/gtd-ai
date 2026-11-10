# Changelog

## 2026-11-10 — priority and ordering

- Use an active project's deadline when a committed task has no deadline of its own.
- Balance importance with bounded deadline urgency and retain complete,
  deterministic ordering through dependency chains.
- Add timing filters and sorted task lists to Priorities, visible list sort
  controls, deadline-source labels, and Planned today.
- Keep the website, widgets, and interactive demos on the same priority rules.
- Preserve warm views during refresh and keep narrow, wrapped widget controls
  usable while scrolling.

## Unreleased — open-source preparation

- Separate reusable source from installation-specific operations and evidence.
- Provide a configurable Linux Docker Compose installation and first administrator.
- Document the shared website/MCP architecture, task semantics, and recovery model.
- Add reproducible identity-provider compatibility builds and third-party notices.
- Add automated checks and a source/license link.
- Keep malformed chart responses local to chart recovery, and surface refreshed
  task conflicts without discarding drafts or moving the edited row.
- Include exact release images in encrypted backups for independent recovery.

## 0.20.0 — source baseline

The initial public source baseline includes invitation-only accounts, PostgreSQL
row-level isolation, Keycloak OAuth, shared website and MCP widgets, projects,
dependencies, recurring tasks, history/undo, activity charts, inherited priorities,
and account-bound widget launch/preload data. Earlier private deployment records
are not part of this repository's release history.
