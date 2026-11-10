-- Both readiness checks use this predicate before decoding the calendar time.
CREATE INDEX IF NOT EXISTS tasks_timed_holds ON gtd.tasks(account_id)
    WHERE entity_type='task'
      AND document::jsonb->>'status'='blocked'
      AND document::jsonb->>'not_before' IS NOT NULL;
