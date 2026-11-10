-- Personal preferences, never administrator-selected accounts. This function
-- changes only the default for future input/account-relative calendar dates.
-- Existing tasks, recurring schedules, history and retry receipts are untouched.
CREATE FUNCTION gtd.set_account_timezone(p_issuer text,p_subject text,p_generation uuid,
    p_authenticated_at bigint,p_expected text,p_timezone text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, gtd AS $$
DECLARE account uuid; previous text;
BEGIN
    SELECT id INTO account FROM gtd.resolve_account(p_issuer,p_subject,p_generation,p_authenticated_at,false);
    IF account IS NULL THEN RAISE EXCEPTION 'account_unavailable' USING ERRCODE='P0001'; END IF;
    SELECT timezone INTO previous FROM gtd.accounts WHERE id=account FOR UPDATE;
    -- Recheck after waiting for an administrator's concurrent reset/disable.
    IF NOT EXISTS (SELECT 1 FROM gtd.resolve_account(p_issuer,p_subject,p_generation,p_authenticated_at,false) WHERE id=account) THEN
        RAISE EXCEPTION 'account_unavailable' USING ERRCODE='P0001';
    END IF;
    IF p_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name=p_timezone) THEN
        RAISE EXCEPTION 'invalid_timezone' USING ERRCODE='P0001';
    END IF;
    -- A response-lost retry of the same desired value is harmless. A different
    -- intervening preference is not overwritten by the old form.
    IF previous IS DISTINCT FROM p_expected AND previous IS DISTINCT FROM p_timezone THEN
        RAISE EXCEPTION 'timezone_conflict' USING ERRCODE='P0001';
    END IF;
    UPDATE gtd.accounts SET timezone=p_timezone WHERE id=account AND timezone IS DISTINCT FROM p_timezone;
    RETURN p_timezone;
END;
$$;
GRANT EXECUTE ON FUNCTION gtd.set_account_timezone(text,text,uuid,bigint,text,text) TO gtd_runtime;
