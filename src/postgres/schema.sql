-- PostgreSQL storage foundation. Install only into a new application database.
-- gtd_owner owns schema/migrations; gtd_runtime must be a separate non-owner role.
-- Install together with administration.sql in the SAME transaction (see SCHEMA
-- in mod.rs). Runtime integration and import are separate acceptance steps.
BEGIN;
SET LOCAL ROLE gtd_owner;
CREATE SCHEMA gtd AUTHORIZATION gtd_owner;
REVOKE ALL ON SCHEMA gtd FROM PUBLIC;
GRANT USAGE ON SCHEMA gtd TO gtd_runtime;
-- Function EXECUTE is a global default grant. A per-schema REVOKE cannot
-- subtract it; revoke at the owner-role level before creating any functions.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

CREATE TABLE gtd.schema_meta (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    compatibility integer NOT NULL CHECK (compatibility = 13),
    environment text NOT NULL CHECK (environment IN ('production', 'staging')),
    identity uuid NOT NULL UNIQUE
);

-- Enrollment is controlled by private provisioning, never by ordinary task SQL.
CREATE TABLE gtd.accounts (
    id uuid PRIMARY KEY,
    issuer text NOT NULL CHECK (length(issuer) > 0),
    subject text NOT NULL CHECK (length(subject) > 0),
    username text NOT NULL CHECK (length(username) > 0),
    display_name text,
    timezone text NOT NULL DEFAULT 'America/New_York',
    administrator boolean NOT NULL DEFAULT false,
    credential_generation uuid,
    authenticated_after bigint,
    enabled boolean NOT NULL DEFAULT false,
    enrollment text NOT NULL CHECK (enrollment IN ('pending', 'active', 'expired', 'revoked')),
    UNIQUE (issuer, subject),
    UNIQUE (username)
);

CREATE FUNCTION gtd.immutable_identity() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, gtd AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.issuer IS DISTINCT FROM OLD.issuer
       OR NEW.subject IS DISTINCT FROM OLD.subject THEN
        RAISE EXCEPTION 'account identity is immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER immutable_account_identity BEFORE UPDATE ON gtd.accounts
    FOR EACH ROW EXECUTE FUNCTION gtd.immutable_identity();

-- The caller is trusted application code after issuer/signature/audience/scope
-- verification. Neither identity claim may come from task/tool arguments.
CREATE FUNCTION gtd.resolve_account(p_issuer text, p_subject text, p_generation uuid DEFAULT NULL,
    p_authenticated_at bigint DEFAULT NULL, p_background boolean DEFAULT false)
RETURNS TABLE (id uuid, username text, display_name text, timezone text, administrator boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
    SELECT a.id, a.username, a.display_name, a.timezone, a.administrator
    FROM gtd.accounts a
    WHERE a.issuer = p_issuer AND a.subject = p_subject
      AND a.enabled AND a.enrollment = 'active'
      AND (p_background OR ((a.credential_generation IS NULL OR a.credential_generation = p_generation)
          AND (a.authenticated_after IS NULL OR p_authenticated_at > a.authenticated_after)));
$$;
GRANT EXECUTE ON FUNCTION gtd.resolve_account(text, text, uuid, bigint, boolean) TO gtd_runtime;

-- Internal scheduler directory: one active identity at a time, no task data or
-- identity administration. Never exposed as a tool or caller-selected account.
CREATE FUNCTION gtd.next_worker_account(p_after uuid)
RETURNS TABLE (id uuid, issuer text, subject text, credential_generation uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
    SELECT a.id, a.issuer, a.subject, a.credential_generation FROM gtd.accounts a
    WHERE a.enabled AND a.enrollment = 'active'
    ORDER BY CASE WHEN p_after IS NULL OR a.id > p_after THEN 0 ELSE 1 END, a.id
    LIMIT 1;
$$;
GRANT EXECUTE ON FUNCTION gtd.next_worker_account(uuid) TO gtd_runtime;

CREATE FUNCTION gtd.current_account() RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
    SELECT nullif(current_setting('gtd.account_id', true), '')::uuid;
$$;
CREATE FUNCTION gtd.account_enabled(p_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
    SELECT EXISTS (SELECT 1 FROM gtd.accounts a
                   WHERE a.id = p_id AND a.enabled AND a.enrollment = 'active');
$$;
GRANT EXECUTE ON FUNCTION gtd.current_account(), gtd.account_enabled(uuid) TO gtd_runtime;

-- Every authoritative write locks this account's row before reading state or
-- allocating revisions. The high-water mark advances in that same transaction.
-- No global sequence: a later commit cannot hide below an emitted sync cursor.
CREATE TABLE gtd.account_state (
    account_id uuid PRIMARY KEY REFERENCES gtd.accounts(id),
    identity uuid NOT NULL UNIQUE,
    high bigint NOT NULL DEFAULT 0 CHECK (high >= 0)
);

-- Raw JSON text preserves retained content and historical receipts exactly.
-- Generated columns provide typed, ownership-aware relational constraints.
CREATE TABLE gtd.tasks (
    account_id uuid NOT NULL REFERENCES gtd.accounts(id),
    id text NOT NULL,
    document text NOT NULL CHECK (jsonb_typeof(document::jsonb) = 'object'),
    entity_type text GENERATED ALWAYS AS (COALESCE(document::jsonb ->> 'entity_type','task')) STORED NOT NULL,
    project_id text GENERATED ALWAYS AS (document::jsonb ->> 'project_id') STORED,
    series_id text GENERATED ALWAYS AS (document::jsonb #>> '{occurrence,series_id}') STORED,
    occurrence_date text GENERATED ALWAYS AS (document::jsonb #>> '{occurrence,original_date}') STORED,
    PRIMARY KEY (account_id, id),
    CHECK (document::jsonb ->> 'id' IS NOT NULL AND document::jsonb ->> 'id' = id),
    CHECK (entity_type IN ('task', 'project', 'recurrence')),
    FOREIGN KEY (account_id, project_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (account_id, series_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    UNIQUE (account_id, series_id, occurrence_date)
);
CREATE INDEX tasks_project ON gtd.tasks(account_id, project_id);
CREATE INDEX tasks_kind ON gtd.tasks(account_id, entity_type);

CREATE TABLE gtd.dependencies (
    account_id uuid NOT NULL,
    task_id text NOT NULL,
    prerequisite_id text NOT NULL,
    PRIMARY KEY (account_id, task_id, prerequisite_id),
    CHECK (task_id <> prerequisite_id),
    FOREIGN KEY (account_id, task_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (account_id, prerequisite_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX dependencies_reverse ON gtd.dependencies(account_id, prerequisite_id, task_id);

CREATE TABLE gtd.changes (
    account_id uuid NOT NULL,
    id bigint NOT NULL CHECK (id > 0),
    task_id text NOT NULL,
    document text NOT NULL CHECK (jsonb_typeof(document::jsonb) = 'object'),
    entity_type text NOT NULL,
    batch_id text,
    token text NOT NULL,
    PRIMARY KEY (account_id, id),
    FOREIGN KEY (account_id, task_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX changes_task ON gtd.changes(account_id, task_id, id);
CREATE TABLE gtd.revisions (
    account_id uuid NOT NULL,
    seq bigint NOT NULL,
    entity_id text NOT NULL,
    entity_type text NOT NULL,
    document text NOT NULL CHECK (jsonb_typeof(document::jsonb) = 'object'),
    PRIMARY KEY (account_id, seq),
    FOREIGN KEY (account_id, seq) REFERENCES gtd.changes(account_id, id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (account_id, entity_id) REFERENCES gtd.tasks(account_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX revisions_entity ON gtd.revisions(account_id, entity_id, seq);
CREATE TABLE gtd.requests (
    account_id uuid NOT NULL REFERENCES gtd.accounts(id),
    id text NOT NULL,
    request text NOT NULL,
    response text NOT NULL CHECK (jsonb_typeof(response::jsonb) = 'object'),
    PRIMARY KEY (account_id, id)
);
CREATE TABLE gtd.action_groups (
    account_id uuid NOT NULL,
    change_id bigint NOT NULL,
    group_id text NOT NULL,
    PRIMARY KEY (account_id, change_id),
    FOREIGN KEY (account_id, change_id) REFERENCES gtd.changes(account_id, id)
        DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX action_groups_group ON gtd.action_groups(account_id, group_id);

CREATE TABLE gtd.search_state (
    account_id uuid NOT NULL REFERENCES gtd.accounts(id),
    key text NOT NULL,
    value text NOT NULL,
    PRIMARY KEY (account_id, key)
);
CREATE TABLE gtd.search_sessions (
    account_id uuid NOT NULL REFERENCES gtd.accounts(id),
    id text NOT NULL,
    store text NOT NULL,
    query text NOT NULL,
    high bigint NOT NULL CHECK (high >= 0),
    expires bigint NOT NULL,
    ids text NOT NULL CHECK (jsonb_typeof(ids::jsonb) = 'array'),
    PRIMARY KEY (account_id, id)
);

-- Private migration tooling uses this immutable receipt for exact retries.
-- No importer or account selector is exposed by ordinary application tools.
CREATE TABLE gtd.legacy_imports (
    account_id uuid PRIMARY KEY REFERENCES gtd.accounts(id),
    source_identity uuid NOT NULL,
    source_environment text NOT NULL,
    digest text NOT NULL CHECK (digest ~ '^[0-9a-f]{64}$'),
    report text NOT NULL CHECK (jsonb_typeof(report::jsonb) = 'object'),
    imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION gtd.append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
    RAISE EXCEPTION 'immutable history cannot be changed' USING ERRCODE = '23514';
END;
$$;

DO $$
DECLARE table_name text;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['account_state', 'tasks', 'dependencies',
        'changes', 'revisions', 'requests', 'action_groups', 'search_state', 'search_sessions', 'legacy_imports']
    LOOP
        EXECUTE format('ALTER TABLE gtd.%I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('ALTER TABLE gtd.%I FORCE ROW LEVEL SECURITY', table_name);
        EXECUTE format('CREATE POLICY account_isolation ON gtd.%I TO gtd_runtime, gtd_owner
            USING (account_id = (SELECT gtd.current_account())
                   AND (SELECT gtd.account_enabled(gtd.current_account())))
            WITH CHECK (account_id = (SELECT gtd.current_account())
                        AND (SELECT gtd.account_enabled(gtd.current_account())))', table_name);
    END LOOP;
    FOREACH table_name IN ARRAY ARRAY['changes', 'revisions', 'requests', 'action_groups', 'legacy_imports']
    LOOP
        EXECUTE format('CREATE TRIGGER append_only BEFORE UPDATE OR DELETE ON gtd.%I
            FOR EACH ROW EXECUTE FUNCTION gtd.append_only()', table_name);
        EXECUTE format('GRANT SELECT, INSERT ON gtd.%I TO gtd_runtime', table_name);
    END LOOP;
END;
$$;
GRANT SELECT ON gtd.schema_meta TO gtd_runtime;
GRANT SELECT, UPDATE ON gtd.account_state TO gtd_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON gtd.tasks, gtd.dependencies,
    gtd.search_state, gtd.search_sessions TO gtd_runtime;
