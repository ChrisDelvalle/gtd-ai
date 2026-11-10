-- Website-only account lifecycle. No runtime table grants and no task-data
-- access. The Rust OIDC session boundary supplies identity/authentication time.
-- Continues schema.sql; sessions.sql commits the complete schema.

CREATE TABLE gtd.invitations (
    id uuid PRIMARY KEY,
    issuer text NOT NULL,
    username text NOT NULL UNIQUE,
    display_name text,
    subject text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL DEFAULT now() + interval '7 days',
    ready boolean NOT NULL DEFAULT false,
    revoked boolean NOT NULL DEFAULT false,
    CHECK (expires_at > created_at),
    UNIQUE (issuer, subject)
);
CREATE TABLE gtd.admin_operations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_id uuid NOT NULL REFERENCES gtd.accounts(id),
    request_id uuid NOT NULL,
    command jsonb NOT NULL,
    target_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('invite','regenerate','reset_password','revoke','disable')),
    state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','complete','cancelled')),
    attempt uuid,
    lease_until timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz,
    UNIQUE (actor_id, request_id)
);
CREATE UNIQUE INDEX admin_one_pending ON gtd.admin_operations(target_id) WHERE state = 'pending';
CREATE TABLE gtd.admin_events (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at timestamptz NOT NULL DEFAULT now(),
    actor_id uuid REFERENCES gtd.accounts(id),
    target_id uuid NOT NULL,
    operation_id uuid REFERENCES gtd.admin_operations(id),
    event text NOT NULL CHECK (event IN ('requested','attempted','bound','completed','cancelled','activated'))
);
CREATE TRIGGER admin_events_append_only BEFORE UPDATE OR DELETE ON gtd.admin_events
    FOR EACH ROW EXECUTE FUNCTION gtd.append_only();

-- Serializes only rare account administration, never task reads/writes.
-- The provider orchestrator holds the same session lock across all journal
-- commits and external calls. A coordinated backup holds it across both dumps.
-- Private operator account/realm changes must participate in this protocol.
CREATE FUNCTION gtd.admin_lock() RETURNS void
LANGUAGE sql SET search_path = pg_catalog AS $$
    SELECT pg_advisory_xact_lock(214716023, 1);
$$;
CREATE FUNCTION gtd.protect_last_administrator() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
BEGIN
    IF OLD.administrator AND OLD.enabled AND OLD.enrollment = 'active'
       AND (TG_OP = 'DELETE' OR NOT NEW.administrator OR NOT NEW.enabled OR NEW.enrollment <> 'active') THEN
        PERFORM gtd.admin_lock();
        IF NOT EXISTS (SELECT 1 FROM gtd.accounts WHERE id <> OLD.id
                       AND administrator AND enabled AND enrollment = 'active') THEN
            RAISE EXCEPTION 'last_administrator' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
CREATE TRIGGER protect_last_administrator BEFORE UPDATE OR DELETE ON gtd.accounts
    FOR EACH ROW EXECUTE FUNCTION gtd.protect_last_administrator();

CREATE FUNCTION gtd.require_administrator(p_identity jsonb, p_recent boolean) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE actor uuid; authenticated bigint;
BEGIN
    SELECT a.id INTO actor FROM gtd.resolve_account(p_identity->>'issuer',p_identity->>'subject',
        (p_identity->>'generation')::uuid,(p_identity->>'authenticated_at')::bigint,false) a WHERE a.administrator;
    IF actor IS NULL THEN RAISE EXCEPTION 'admin_forbidden' USING ERRCODE = 'P0001'; END IF;
    IF p_recent THEN
        authenticated := (p_identity->>'authenticated_at')::bigint;
        IF authenticated IS NULL OR authenticated < extract(epoch FROM clock_timestamp())::bigint - 300
           OR authenticated > extract(epoch FROM clock_timestamp())::bigint + 5 THEN
            RAISE EXCEPTION 'reauthentication_required' USING ERRCODE = 'P0001';
        END IF;
    END IF;
    RETURN actor;
END;
$$;

CREATE FUNCTION gtd.admin_result(p_id uuid) RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
    SELECT jsonb_build_object('id',id,'target_id',target_id,'kind',kind,'state',state,
        'attempt',attempt,'lease_until',lease_until,'created_at',created_at,'completed_at',completed_at)
    FROM gtd.admin_operations WHERE id=p_id;
$$;

CREATE FUNCTION gtd.admin_begin(p_identity jsonb, p_request uuid, p_command jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE actor uuid; op gtd.admin_operations; target uuid; command_kind text;
    chosen_username text; chosen_display text; invitation gtd.invitations; account gtd.accounts;
BEGIN
    PERFORM gtd.admin_lock();
    actor := gtd.require_administrator(p_identity,true);
    SELECT * INTO op FROM gtd.admin_operations WHERE actor_id=actor AND request_id=p_request;
    IF FOUND THEN
        IF op.command IS DISTINCT FROM p_command THEN
            RAISE EXCEPTION 'admin_request_conflict' USING ERRCODE = 'P0001';
        END IF;
        RETURN gtd.admin_result(op.id);
    END IF;
    command_kind := p_command->>'action';
    IF jsonb_typeof(p_command) <> 'object' OR command_kind IS NULL OR command_kind NOT IN
        ('invite','regenerate','reset_password','revoke','disable') THEN
        RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001';
    END IF;
    IF command_kind = 'invite' THEN
        IF p_command - ARRAY['action','username','display_name'] <> '{}'::jsonb THEN
            RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001';
        END IF;
        chosen_username := p_command->>'username'; chosen_display := p_command->>'display_name';
        IF chosen_username IS NULL OR chosen_username !~ '^[a-z0-9][a-z0-9._-]{0,63}$'
           OR (chosen_display IS NOT NULL AND (length(chosen_display) NOT BETWEEN 1 AND 100
               OR chosen_display ~ '[[:cntrl:]]' OR btrim(chosen_display) <> chosen_display)) THEN
            RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001';
        END IF;
        IF EXISTS (SELECT 1 FROM gtd.accounts WHERE lower(username)=chosen_username)
           OR EXISTS (SELECT 1 FROM gtd.invitations WHERE username=chosen_username) THEN
            RAISE EXCEPTION 'username_unavailable' USING ERRCODE = 'P0001';
        END IF;
        target := gen_random_uuid();
        INSERT INTO gtd.invitations(id,issuer,username,display_name)
            VALUES(target,p_identity->>'issuer',chosen_username,chosen_display);
    ELSE
        IF p_command - ARRAY['action','target_id'] <> '{}'::jsonb OR p_command->>'target_id' IS NULL THEN
            RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001';
        END IF;
        target := (p_command->>'target_id')::uuid;
        SELECT * INTO invitation FROM gtd.invitations WHERE id=target AND issuer=p_identity->>'issuer';
        SELECT * INTO account FROM gtd.accounts WHERE id=target AND issuer=p_identity->>'issuer';
        IF invitation.id IS NULL AND account.id IS NULL THEN
            RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
        END IF;
        IF command_kind IN ('regenerate','revoke') AND (invitation.id IS NULL
            OR (account.id IS NOT NULL AND account.enrollment = 'active') OR invitation.revoked) THEN
            RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
        END IF;
        IF command_kind IN ('reset_password','disable') AND
            (account.id IS NULL OR account.enrollment <> 'active') THEN
            RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
        END IF;
        IF target=actor THEN
            RAISE EXCEPTION 'self_account_change' USING ERRCODE = 'P0001';
        END IF;
        -- A revocation/disable may cancel an uncertain remote request. Its old
        -- completion can no longer enable the account. Other changes wait.
        IF command_kind IN ('revoke','disable') OR (command_kind='regenerate'
            AND NOT EXISTS (SELECT 1 FROM gtd.admin_operations WHERE target_id=target AND state='pending'
                AND lease_until>now())) THEN
            WITH cancelled AS (
                UPDATE gtd.admin_operations SET state='cancelled',completed_at=now()
                WHERE target_id=target AND state='pending' RETURNING id
            ) INSERT INTO gtd.admin_events(actor_id,target_id,operation_id,event)
                SELECT actor,target,id,'cancelled' FROM cancelled;
        ELSIF EXISTS (SELECT 1 FROM gtd.admin_operations WHERE target_id=target AND state='pending') THEN
            RAISE EXCEPTION 'admin_operation_pending' USING ERRCODE = 'P0001';
        END IF;
        -- Resetting credentials is not account re-enablement. An existing
        -- reset's exact retry was handled above; a disabled account requires
        -- explicit private operator recovery before a new reset can begin.
        IF command_kind='reset_password' AND NOT account.enabled THEN
            RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
        END IF;
        -- Block GTD immediately, before any provider call. Resetting the last
        -- administrator is refused; that administrator uses account security.
        UPDATE gtd.accounts SET enabled=false, credential_generation=gen_random_uuid(),
            authenticated_after=floor(extract(epoch FROM clock_timestamp()))::bigint,
            enrollment=CASE WHEN command_kind='revoke' THEN 'revoked' ELSE enrollment END WHERE id=target;
        IF command_kind='regenerate' THEN
            UPDATE gtd.invitations SET ready=false,expires_at=now()+interval '7 days' WHERE id=target;
        ELSIF command_kind='revoke' THEN
            UPDATE gtd.invitations SET ready=false,revoked=true WHERE id=target;
        END IF;
    END IF;
    INSERT INTO gtd.admin_operations(actor_id,request_id,command,target_id,kind)
        VALUES(actor,p_request,p_command,target,command_kind) RETURNING * INTO op;
    INSERT INTO gtd.admin_events(actor_id,target_id,operation_id,event) VALUES(actor,target,op.id,'requested');
    RETURN gtd.admin_result(op.id);
END;
$$;

CREATE FUNCTION gtd.admin_claim(p_identity jsonb, p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE actor uuid; op gtd.admin_operations; invitation gtd.invitations; account gtd.accounts;
BEGIN
    PERFORM gtd.admin_lock(); actor := gtd.require_administrator(p_identity,true);
    SELECT * INTO op FROM gtd.admin_operations WHERE id=p_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001'; END IF;
    SELECT * INTO invitation FROM gtd.invitations WHERE id=op.target_id;
    SELECT * INTO account FROM gtd.accounts WHERE id=op.target_id;
    IF coalesce(invitation.issuer,account.issuer) IS DISTINCT FROM p_identity->>'issuer' THEN
        RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
    END IF;
    IF op.state <> 'pending' THEN RETURN gtd.admin_result(op.id); END IF;
    IF op.lease_until > now() THEN RAISE EXCEPTION 'admin_operation_busy' USING ERRCODE = 'P0001'; END IF;
    IF op.kind IN ('invite','regenerate') AND (invitation.revoked OR invitation.expires_at <= now()) THEN
        RAISE EXCEPTION 'invitation_expired' USING ERRCODE = 'P0001';
    END IF;
    UPDATE gtd.admin_operations SET attempt=gen_random_uuid(),lease_until=now()+interval '60 seconds'
        WHERE id=p_id RETURNING * INTO op;
    UPDATE gtd.accounts SET credential_generation=op.attempt WHERE id=op.target_id;
    INSERT INTO gtd.admin_events(actor_id,target_id,operation_id,event) VALUES(actor,op.target_id,op.id,'attempted');
    RETURN gtd.admin_result(p_id) || jsonb_build_object('issuer',coalesce(invitation.issuer,account.issuer),
        'subject',coalesce(invitation.subject,account.subject),'username',coalesce(invitation.username,account.username),
        'display_name',coalesce(invitation.display_name,account.display_name));
END;
$$;

CREATE FUNCTION gtd.admin_attempt(p_identity jsonb, p_id uuid, p_attempt uuid) RETURNS gtd.admin_operations
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE op gtd.admin_operations;
BEGIN
    PERFORM gtd.admin_lock(); PERFORM gtd.require_administrator(p_identity,true);
    SELECT * INTO op FROM gtd.admin_operations WHERE id=p_id AND state='pending'
        AND attempt=p_attempt AND lease_until>now();
    IF NOT FOUND THEN RAISE EXCEPTION 'stale_admin_attempt' USING ERRCODE = 'P0001'; END IF;
    IF NOT EXISTS (SELECT 1 FROM gtd.invitations WHERE id=op.target_id AND issuer=p_identity->>'issuer')
       AND NOT EXISTS (SELECT 1 FROM gtd.accounts WHERE id=op.target_id AND issuer=p_identity->>'issuer') THEN
        RAISE EXCEPTION 'admin_target_unavailable' USING ERRCODE = 'P0001';
    END IF;
    RETURN op;
END;
$$;

-- The private provider client must verify its reserved account-ID attribute
-- before supplying the subject. Username matching is never identity adoption.
CREATE FUNCTION gtd.admin_bind(p_identity jsonb, p_id uuid, p_attempt uuid, p_subject text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE op gtd.admin_operations; invitation gtd.invitations; actor uuid;
BEGIN
    op := gtd.admin_attempt(p_identity,p_id,p_attempt);
    actor := gtd.require_administrator(p_identity,true);
    IF op.kind NOT IN ('invite','regenerate') OR p_subject IS NULL OR length(p_subject) NOT BETWEEN 1 AND 255
       OR p_subject ~ '[[:cntrl:]]' OR btrim(p_subject) <> p_subject THEN
        RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001';
    END IF;
    SELECT * INTO invitation FROM gtd.invitations WHERE id=op.target_id;
    IF invitation.revoked OR invitation.expires_at <= now() THEN
        RAISE EXCEPTION 'invitation_expired' USING ERRCODE = 'P0001';
    END IF;
    IF invitation.subject IS NOT NULL AND invitation.subject <> p_subject THEN
        RAISE EXCEPTION 'identity_binding_conflict' USING ERRCODE = 'P0001';
    END IF;
    IF invitation.subject IS NULL THEN
        INSERT INTO gtd.accounts(id,issuer,subject,username,display_name,credential_generation,authenticated_after,enrollment)
            VALUES(invitation.id,invitation.issuer,p_subject,invitation.username,invitation.display_name,p_attempt,
                floor(extract(epoch FROM clock_timestamp()))::bigint,'pending');
        UPDATE gtd.invitations SET subject=p_subject WHERE id=invitation.id;
        INSERT INTO gtd.admin_events(actor_id,target_id,operation_id,event) VALUES(actor,op.target_id,op.id,'bound');
    END IF;
    RETURN gtd.admin_result(op.id);
END;
$$;

-- Called only after provider read-back confirms the intended identity and
-- generation/required-action state. No password is accepted or persisted here.
CREATE FUNCTION gtd.admin_complete(p_identity jsonb, p_id uuid, p_attempt uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE op gtd.admin_operations; actor uuid;
BEGIN
    op := gtd.admin_attempt(p_identity,p_id,p_attempt);
    actor := gtd.require_administrator(p_identity,true);
    IF op.kind IN ('invite','regenerate') THEN
        UPDATE gtd.invitations SET ready=true WHERE id=op.target_id AND subject IS NOT NULL
            AND NOT revoked AND expires_at>now();
        IF NOT FOUND THEN RAISE EXCEPTION 'invitation_expired' USING ERRCODE = 'P0001'; END IF;
    ELSIF op.kind='reset_password' THEN
        UPDATE gtd.accounts SET enabled=true WHERE id=op.target_id AND enrollment='active'
            AND credential_generation=p_attempt;
        IF NOT FOUND THEN RAISE EXCEPTION 'stale_admin_attempt' USING ERRCODE = 'P0001'; END IF;
    END IF;
    UPDATE gtd.admin_operations SET state='complete',completed_at=now(),lease_until=NULL WHERE id=p_id;
    INSERT INTO gtd.admin_events(actor_id,target_id,operation_id,event) VALUES(actor,op.target_id,op.id,'completed');
    RETURN gtd.admin_result(p_id);
END;
$$;

CREATE FUNCTION gtd.activate_invitation(p_issuer text,p_subject text,p_generation uuid,p_authenticated_at bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE target uuid; previous text;
BEGIN
    PERFORM gtd.admin_lock();
    SELECT a.id INTO target FROM gtd.accounts a JOIN gtd.invitations i ON i.id=a.id
        WHERE a.issuer=p_issuer AND a.subject=p_subject AND a.enrollment='pending'
        AND a.credential_generation=p_generation AND p_authenticated_at>a.authenticated_after
        AND i.ready AND NOT i.revoked AND i.expires_at>now();
    IF target IS NULL THEN RETURN false; END IF;
    UPDATE gtd.accounts SET enabled=true,enrollment='active' WHERE id=target;
    previous := current_setting('gtd.account_id',true);
    PERFORM set_config('gtd.account_id',target::text,true);
    INSERT INTO gtd.account_state(account_id,identity) VALUES(target,gen_random_uuid());
    PERFORM set_config('gtd.account_id',coalesce(previous,''),true);
    INSERT INTO gtd.admin_events(target_id,event) VALUES(target,'activated');
    RETURN true;
END;
$$;

-- An interrupted browser can inspect its own request without retrying a write
-- or rotating credentials. Another administrator's request IDs are unavailable.
CREATE FUNCTION gtd.admin_request(p_identity jsonb,p_request uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE actor uuid; result jsonb;
BEGIN
    actor := gtd.require_administrator(p_identity,false);
    SELECT gtd.admin_result(id) INTO result FROM gtd.admin_operations
        WHERE actor_id=actor AND request_id=p_request;
    RETURN coalesce(result,'null'::jsonb);
END;
$$;

CREATE FUNCTION gtd.admin_operation(p_identity jsonb,p_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE result jsonb;
BEGIN
    PERFORM gtd.require_administrator(p_identity,false);
    SELECT gtd.admin_result(o.id) INTO result FROM gtd.admin_operations o
        WHERE o.id=p_id AND (EXISTS (SELECT 1 FROM gtd.accounts a WHERE a.id=o.target_id AND a.issuer=p_identity->>'issuer')
            OR EXISTS (SELECT 1 FROM gtd.invitations i WHERE i.id=o.target_id AND i.issuer=p_identity->>'issuer'));
    RETURN coalesce(result,'null'::jsonb);
END;
$$;

CREATE FUNCTION gtd.admin_list(p_identity jsonb,p_after uuid,p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE result jsonb;
BEGIN
    PERFORM gtd.require_administrator(p_identity,false);
    IF p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_admin_request' USING ERRCODE = 'P0001'; END IF;
    SELECT coalesce(jsonb_agg(row ORDER BY row->>'id'),'[]'::jsonb) INTO result FROM (
        SELECT jsonb_build_object('id',coalesce(a.id,i.id),'username',coalesce(a.username,i.username),
            'display_name',coalesce(a.display_name,i.display_name),'administrator',coalesce(a.administrator,false),
            'enabled',coalesce(a.enabled,false),'state',CASE
                WHEN a.enrollment='active' THEN 'active' WHEN i.revoked THEN 'revoked'
                WHEN i.expires_at<=now() THEN 'expired' ELSE coalesce(a.enrollment,'pending') END,
            'expires_at',CASE WHEN a.enrollment='active' THEN NULL ELSE i.expires_at END,
            'operation', (SELECT gtd.admin_result(o.id) FROM gtd.admin_operations o
                WHERE o.target_id=coalesce(a.id,i.id) AND o.state='pending')) AS row
        FROM gtd.accounts a FULL JOIN gtd.invitations i ON a.id=i.id
        WHERE coalesce(a.issuer,i.issuer)=p_identity->>'issuer'
            AND (p_after IS NULL OR coalesce(a.id,i.id)>p_after)
        ORDER BY coalesce(a.id,i.id) LIMIT p_limit
    ) listed;
    RETURN result;
END;
$$;
GRANT EXECUTE ON FUNCTION gtd.admin_begin(jsonb,uuid,jsonb),gtd.admin_claim(jsonb,uuid),
    gtd.admin_bind(jsonb,uuid,uuid,text),gtd.admin_complete(jsonb,uuid,uuid),
    gtd.activate_invitation(text,text,uuid,bigint),gtd.admin_list(jsonb,uuid,integer),
    gtd.admin_request(jsonb,uuid),gtd.admin_operation(jsonb,uuid) TO gtd_runtime;
