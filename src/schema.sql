CREATE TABLE tasks (
    id TEXT PRIMARY KEY NOT NULL,
    document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE TABLE changes (
    id INTEGER PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id),
    document TEXT NOT NULL CHECK (json_valid(document))
);
CREATE INDEX changes_task ON changes(task_id, id);
CREATE TABLE requests (
    id TEXT PRIMARY KEY NOT NULL,
    request TEXT NOT NULL,
    response TEXT NOT NULL CHECK (json_valid(response))
);
CREATE TRIGGER changes_no_update BEFORE UPDATE ON changes
BEGIN SELECT RAISE(ABORT, 'audit history is append-only'); END;
CREATE TRIGGER changes_no_delete BEFORE DELETE ON changes
BEGIN SELECT RAISE(ABORT, 'audit history is append-only'); END;
PRAGMA user_version = 1;

