//! Freeze validated search IDs at one account revision. Never return index
//! documents as task records; the authoritative read path supplies every body.
use super::{
    search::{active, get, prefix, put, valid_index},
    *,
};
use crate::{search_engine::*, store::StoreError};
use chrono::Utc;
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    time::Instant,
};

impl Store {
    pub(super) fn prepare_search(&self, principal: &Principal, query: &str) -> Result<i64> {
        let normalized = validated_query(query)?;
        let deadline = Instant::now() + BUDGET;
        let config = self.search.as_ref().ok_or(StoreError::SearchUnavailable)?;
        let (target, account, prefix) =
            self.read(principal, |tx| Ok((tx.high, tx.account.id, prefix(tx))))?;
        let engine = Engine::new(config, prefix, deadline)?;
        loop {
            remaining(deadline)?;
            let (published, repair) =
                self.read(principal, |tx| Ok((active(tx)?, get(tx, "repair")?)))?;
            if let Some(published) = published
                && published.high >= target
                && valid_index(&engine, &published)
                && repair.as_deref() != Some(&published.index)
            {
                let mut invalid_projection = false;
                let result = (|| {
                    let mut ids = Vec::new();
                    let mut seen = HashSet::new();
                    loop {
                        let response = engine
                            .request(
                                reqwest::Method::POST,
                                &format!("/indexes/{}/search", published.index),
                                Some(&json!({
                                    "q":normalized,"matchingStrategy":"all",
                                    "filter":format!("account_id = \"{}\"",account),
                                    "attributesToRetrieve":["id","revision","account_id"],
                                    "offset":ids.len(),"limit":SEARCH_PAGE
                                })),
                            )
                            .map_err(|error| {
                                invalid_projection = matches!(error, RemoteError::Missing);
                                Error::from(error)
                            })?;
                        let Some(hits) = response["hits"].as_array() else {
                            invalid_projection = true;
                            return Err(StoreError::SearchUnavailable.into());
                        };
                        if response["degraded"] == true
                            || hits.len() > SEARCH_PAGE
                            || ids.len() + hits.len() > published.count
                        {
                            invalid_projection = true;
                            return Err(StoreError::SearchUnavailable.into());
                        }
                        let mut batch = HashMap::new();
                        for hit in hits {
                            if hit["account_id"].as_str() != Some(&account.to_string()) {
                                invalid_projection = true;
                                return Err(StoreError::SearchUnavailable.into());
                            }
                            let (Some(id), Some(revision)) =
                                (hit["id"].as_str(), hit["revision"].as_i64())
                            else {
                                invalid_projection = true;
                                return Err(StoreError::SearchUnavailable.into());
                            };
                            let id = id.to_string();
                            if !seen.insert(id.clone()) {
                                invalid_projection = true;
                                return Err(StoreError::SearchUnavailable.into());
                            }
                            batch.insert(id.clone(), revision);
                            ids.push(id);
                        }
                        // RLS plus account-qualified SQL checks IDs and revisions even
                        // if a search deployment is misconfigured or returns bad hits.
                        self.read(principal, |tx| {
                            if published.high>tx.high { invalid_projection = true; return Err(StoreError::SearchUnavailable.into()); }
                            let sql = format!("{} SELECT entity_id,(document::jsonb->>'last_change_id')::bigint FROM records WHERE entity_id=ANY($3)",super::read_snapshot::source(published.high==tx.high));
                            let keys:Vec<_>=batch.keys().cloned().collect();
                            let rows = tx.tx.query(&sql,&[&tx.account.id,&published.high,&keys])?;
                            if rows.len()!=batch.len() || rows.iter().any(|r|batch.get(&r.get::<_,String>(0))!=Some(&r.get::<_,i64>(1))) {
                                invalid_projection = true;
                                return Err(StoreError::SearchUnavailable.into());
                            }
                            Ok(())
                        })?;
                        remaining(deadline)?;
                        if hits.len() < SEARCH_PAGE {
                            break;
                        }
                    }
                    self.write(principal, |tx| {
                        remaining(deadline)?;
                        tx.tx.execute("INSERT INTO gtd.search_sessions VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,id) DO UPDATE SET expires=excluded.expires", &[&tx.account.id,&key(query,published.high),&tx.identity.to_string(),&query,&published.high,&(Utc::now().timestamp()+3600),&serde_json::to_string(&ids)?])?;
                        remaining(deadline)?;
                        Ok(published.high)
                    })
                })();
                if invalid_projection {
                    // Mark this exact generation only. A newer publication must not
                    // be invalidated by a delayed failure from an older request.
                    self.write(principal, |tx| {
                        if active(tx)?.is_some_and(|p| p.index == published.index) {
                            put(tx, "repair", &published.index)?;
                        }
                        Ok(())
                    })?;
                }
                return result;
            }
            std::thread::sleep(Duration::from_millis(40).min(remaining(deadline)?));
        }
    }

    pub fn search_health(&self, principal: &Principal) -> Result<Value> {
        self.read(principal,|tx| {
            let published=active(tx)?;
            let repair=get(tx,"repair")?;
            let check=get(tx,"last_check")?;
            let error=get(tx,"last_error")?.filter(|v|!v.is_empty());
            let live=check.as_deref().and_then(|v|chrono::DateTime::parse_from_rfc3339(v).ok()).is_some_and(|v|(Utc::now()-v.with_timezone(&Utc)).num_seconds()<15);
            Ok(json!({"configured":self.search.is_some(),"indexed_checkpoint":published.as_ref().map(|p|p.high),"store_checkpoint":tx.high,"ready":live&&error.is_none()&&published.as_ref().is_some_and(|p|p.high==tx.high&&repair.as_deref()!=Some(&p.index)),"last_success":get(tx,"last_success")?,"last_check":check,"error_code":error}))
        })
    }
}

impl AccountTransaction<'_> {
    pub(super) fn search_matches(
        &mut self,
        query: Option<&str>,
        high: i64,
    ) -> Result<Option<HashMap<String, usize>>> {
        let Some(query) = query.filter(|q| !q.trim().is_empty()) else {
            return Ok(None);
        };
        validated_query(query)?;
        let row=self.tx.query_opt("SELECT ids FROM gtd.search_sessions WHERE account_id=$1 AND id=$2 AND store=$3 AND query=$4 AND high=$5 AND expires>=extract(epoch FROM clock_timestamp())::bigint", &[&self.account.id,&key(query,high),&self.identity.to_string(),&query,&high])?.ok_or(Error::ResetRequired)?;
        let ids: Vec<String> = serde_json::from_str(&row.get::<_, String>(0))?;
        Ok(Some(
            ids.into_iter().enumerate().map(|(n, id)| (id, n)).collect(),
        ))
    }
}
