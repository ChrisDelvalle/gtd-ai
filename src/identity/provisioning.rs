//! Recoverable account provisioning. The database holds intent and ownership;
//! Keycloak owns credentials. No automatic retries and no stored passwords.
use crate::postgres::{
    Store,
    administration::{self, Operation, OperationState, WebsiteIdentity, Work},
};
use uuid::Uuid;

pub mod keycloak;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Administration(#[from] administration::Error),
    #[error(
        "Identity administration is temporarily unavailable; inspect the pending operation before retrying"
    )]
    ProviderUnavailable,
    #[error("Identity administration is not permitted by the provider configuration")]
    ProviderPermission,
    #[error("The provider identity does not belong to this invitation")]
    IdentityConflict,
    #[error("The provider did not confirm the required account security state")]
    Verification,
    #[error("Invalid identity administration configuration")]
    Configuration,
}

/// No Debug/Serialize: only the website's explicit one-time response may reveal
/// this value. Completed request replay returns metadata, never another password.
pub struct TemporaryPassword(String);
impl TemporaryPassword {
    fn generate() -> Self {
        // UUID v4 supplies 122 random bits. Prefix satisfies the realm's basic
        // mixed-character policy without reducing that entropy.
        Self(format!("Gtd-9!{}", Uuid::new_v4().simple()))
    }
    pub fn expose_once(self) -> String {
        self.0
    }
    pub(super) fn value(&self) -> &str {
        &self.0
    }
}

pub struct Provisioned {
    pub operation: Operation,
    pub temporary_password: Option<TemporaryPassword>,
}

/// Implementations must confirm the immutable gtd_account_id provider attribute,
/// never adopt an identity just because its username matches. Provider attributes
/// used here must be administrator-only in the realm user-profile configuration.
pub trait Provider {
    fn ensure_identity(&self, work: &Work) -> Result<String, Error>;
    fn replace_credentials(
        &self,
        work: &Work,
        subject: &str,
        password: &TemporaryPassword,
    ) -> Result<(), Error>;
    fn disable(&self, work: &Work, subject: &str) -> Result<(), Error>;
    fn revoke_grants(&self, work: &Work, subject: &str) -> Result<(), Error>;
    fn verify(&self, work: &Work, subject: &str, credentials: bool) -> Result<(), Error>;
}

pub struct Provisioner<P> {
    store: Store,
    provider: P,
}
impl<P: Provider> Provisioner<P> {
    pub fn new(store: Store, provider: P) -> Self {
        Self { store, provider }
    }

    /// Explicitly resumed by the website with recent authentication. A lease
    /// prevents overlapping attempts; each recovered attempt has a new signed
    /// generation so a delayed provider response cannot regain GTD access.
    pub fn resume(&self, identity: &WebsiteIdentity<'_>, id: Uuid) -> Result<Provisioned, Error> {
        let mut lifecycle = self.store.provisioning_session()?;
        let work = lifecycle.claim(identity, id)?;
        if work.operation.state != OperationState::Pending {
            return Ok(Provisioned {
                operation: work.operation,
                temporary_password: None,
            });
        }
        let attempt = work.operation.attempt.ok_or(Error::Verification)?;
        let subject = self.provider.ensure_identity(&work)?;
        if matches!(work.operation.kind.as_str(), "invite" | "regenerate") {
            lifecycle.bind(identity, id, attempt, &subject)?;
        }
        let credentials = matches!(
            work.operation.kind.as_str(),
            "invite" | "regenerate" | "reset_password"
        );
        let password = if credentials {
            let password = TemporaryPassword::generate();
            self.provider
                .replace_credentials(&work, &subject, &password)?;
            Some(password)
        } else {
            self.provider.disable(&work, &subject)?;
            None
        };
        self.provider.revoke_grants(&work, &subject)?;
        self.provider.verify(&work, &subject, credentials)?;
        let operation = lifecycle.complete(identity, id, attempt)?;
        Ok(Provisioned {
            operation,
            temporary_password: password,
        })
    }
}
