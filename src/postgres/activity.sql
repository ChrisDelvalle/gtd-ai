-- Rebuildable compact history interpretation; authoritative documents stay intact.
CREATE TABLE gtd.activity_events (
    account_id uuid NOT NULL,
    change_id bigint NOT NULL,
    occurred_at timestamptz NOT NULL,
    entity_id text NOT NULL,
    entity_type text NOT NULL,
    category text NOT NULL,
    automatic boolean NOT NULL,
    completion boolean NOT NULL,
    undoes bigint,
    document text NOT NULL CHECK (jsonb_typeof(document::jsonb) = 'object'),
    PRIMARY KEY (account_id, change_id),
    FOREIGN KEY (account_id, change_id) REFERENCES gtd.changes(account_id,id)
);
CREATE INDEX activity_time ON gtd.activity_events(account_id,occurred_at,change_id);
CREATE INDEX activity_undos ON gtd.activity_events(account_id,change_id) WHERE undoes IS NOT NULL;
CREATE INDEX changes_request ON gtd.changes(account_id,batch_id,id);
ALTER TABLE gtd.activity_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE gtd.activity_events FORCE ROW LEVEL SECURITY;
CREATE POLICY account_isolation ON gtd.activity_events TO gtd_runtime, gtd_owner
    USING (account_id = (SELECT gtd.current_account()) AND (SELECT gtd.account_enabled(gtd.current_account())))
    WITH CHECK (account_id = (SELECT gtd.current_account()) AND (SELECT gtd.account_enabled(gtd.current_account())));
GRANT SELECT, INSERT ON gtd.activity_events TO gtd_runtime;
