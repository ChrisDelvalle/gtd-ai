use super::{Principal, Store, metadata, validate_runtime};
use chrono_tz::Tz;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("Choose a valid IANA timezone")]
    InvalidTimezone,
    #[error("Your timezone changed elsewhere. Reload the setting before saving")]
    Conflict,
    #[error("Sign in to continue")]
    AccountUnavailable,
    #[error("Account settings are temporarily unavailable")]
    Unavailable,
}
impl From<postgres::Error> for Error {
    fn from(error: postgres::Error) -> Self {
        match error.as_db_error().map(|e| e.message()) {
            Some("account_unavailable") => Self::AccountUnavailable,
            Some("invalid_timezone") => Self::InvalidTimezone,
            Some("timezone_conflict") => Self::Conflict,
            _ => Self::Unavailable,
        }
    }
}
impl Store {
    pub(crate) fn set_account_timezone(
        &self,
        principal: &Principal,
        expected: &str,
        zone: &str,
    ) -> Result<String, Error> {
        if principal.background {
            return Err(Error::AccountUnavailable);
        }
        let expected: Tz = expected.parse().map_err(|_| Error::InvalidTimezone)?;
        let zone: Tz = zone.parse().map_err(|_| Error::InvalidTimezone)?;
        let mut connection = self.pool.get().map_err(|_| Error::Unavailable)?;
        validate_runtime(&mut connection).map_err(|_| Error::Unavailable)?;
        let mut tx = connection.transaction()?;
        tx.batch_execute("SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'; SET LOCAL idle_in_transaction_session_timeout='15s'")?;
        metadata(&mut tx, self.environment, Some(self.identity)).map_err(|_| Error::Unavailable)?;
        let value = tx
            .query_one(
                "SELECT gtd.set_account_timezone($1,$2,$3,$4,$5,$6)",
                &[
                    &principal.issuer,
                    &principal.subject,
                    &principal.credential_generation,
                    &principal.authenticated_at,
                    &expected.name(),
                    &zone.name(),
                ],
            )?
            .get(0);
        tx.commit()?;
        Ok(value)
    }
}
