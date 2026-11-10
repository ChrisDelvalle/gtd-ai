-- Private website session vault. Opaque random keys are hashed before storage.
-- Tokens never appear in task records, normal account reads, or audit events.
CREATE TABLE gtd.web_logins (
    state_hash text PRIMARY KEY CHECK (state_hash ~ '^[0-9a-f]{64}$'),
    browser_hash text NOT NULL CHECK (browser_hash ~ '^[0-9a-f]{64}$'),
    document text NOT NULL CHECK (octet_length(document)<=16384 AND jsonb_typeof(document::jsonb)='object'),
    expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes'
);
CREATE INDEX web_logins_expiry ON gtd.web_logins(expires_at);
CREATE TABLE gtd.web_sessions (
    key_hash text PRIMARY KEY CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    account_id uuid NOT NULL REFERENCES gtd.accounts(id),
    document text NOT NULL CHECK (octet_length(document)<=65536 AND jsonb_typeof(document::jsonb)='object'),
    expires_at timestamptz NOT NULL
);
CREATE INDEX web_sessions_expiry ON gtd.web_sessions(expires_at);
CREATE INDEX web_sessions_account ON gtd.web_sessions(account_id);

CREATE FUNCTION gtd.web_login_create(p_state text,p_browser text,p_document text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
BEGIN
    -- A short lock bounds unauthenticated state, not authenticated task traffic.
    PERFORM pg_advisory_xact_lock(214716023,2);
    DELETE FROM gtd.web_logins WHERE expires_at<=now();
    IF (SELECT count(*) FROM gtd.web_logins)>=2048 THEN
        RAISE EXCEPTION 'session_capacity' USING ERRCODE='P0001';
    END IF;
    INSERT INTO gtd.web_logins(state_hash,browser_hash,document) VALUES(p_state,p_browser,p_document);
END;
$$;
CREATE FUNCTION gtd.web_login_consume(p_state text,p_browser text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
    DELETE FROM gtd.web_logins WHERE state_hash=p_state AND browser_hash=p_browser
        AND expires_at>now() RETURNING document;
$$;
CREATE FUNCTION gtd.web_session_create(p_key text,p_identity jsonb,p_document text,p_remember boolean) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
DECLARE account uuid; expiry timestamptz;
BEGIN
    SELECT a.id INTO account FROM gtd.resolve_account(p_identity->>'issuer',p_identity->>'subject',
        (p_identity->>'generation')::uuid,(p_identity->>'authenticated_at')::bigint,false) a;
    IF account IS NULL THEN RAISE EXCEPTION 'account_unavailable' USING ERRCODE='P0001'; END IF;
    expiry:=now()+CASE WHEN p_remember THEN interval '30 days' ELSE interval '12 hours' END;
    INSERT INTO gtd.web_sessions(key_hash,account_id,document,expires_at) VALUES(p_key,account,p_document,expiry);
    RETURN floor(extract(epoch FROM expiry))::bigint;
END;
$$;
-- Row lock coalesces refresh-token rotation across tabs and application replicas.
-- It does not lock account task state or other users' sessions.
CREATE FUNCTION gtd.web_session_lock(p_key text)
RETURNS TABLE(document text,account_id uuid,expires_at bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
    SELECT s.document,s.account_id,floor(extract(epoch FROM s.expires_at))::bigint
        FROM gtd.web_sessions s WHERE s.key_hash=p_key AND s.expires_at>now()
        AND gtd.account_enabled(s.account_id) FOR UPDATE OF s;
$$;
CREATE FUNCTION gtd.web_session_replace(p_key text,p_document text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
BEGIN
    UPDATE gtd.web_sessions SET document=p_document WHERE key_hash=p_key AND expires_at>now();
    RETURN FOUND;
END;
$$;
-- Logout must remain available during provider outages, expiry or disablement.
-- The application checks the stored CSRF secret and bound account under this lock.
CREATE FUNCTION gtd.web_session_lock_for_logout(p_key text)
RETURNS TABLE(document text,account_id uuid,expires_at bigint)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
    SELECT s.document,s.account_id,floor(extract(epoch FROM s.expires_at))::bigint
        FROM gtd.web_sessions s WHERE s.key_hash=p_key FOR UPDATE OF s;
$$;
CREATE FUNCTION gtd.web_session_delete(p_key text) RETURNS text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
    DELETE FROM gtd.web_sessions WHERE key_hash=p_key RETURNING document;
$$;
CREATE FUNCTION gtd.web_session_cleanup() RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gtd AS $$
DECLARE removed bigint;
BEGIN
    WITH expired AS (SELECT key_hash FROM gtd.web_sessions WHERE expires_at<=now() ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED)
        DELETE FROM gtd.web_sessions WHERE key_hash IN (SELECT key_hash FROM expired);
    GET DIAGNOSTICS removed=ROW_COUNT;
    DELETE FROM gtd.web_logins WHERE expires_at<=now();
    RETURN removed;
END;
$$;
GRANT EXECUTE ON FUNCTION gtd.web_login_create(text,text,text),gtd.web_login_consume(text,text),
    gtd.web_session_create(text,jsonb,text,boolean),gtd.web_session_lock(text),
    gtd.web_session_lock_for_logout(text),
    gtd.web_session_replace(text,text),gtd.web_session_delete(text),gtd.web_session_cleanup() TO gtd_runtime;
COMMIT;
