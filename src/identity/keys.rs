use super::*;
use jsonwebtoken::jwk::{AlgorithmParameters, JwkSet, KeyAlgorithm, KeyOperations, PublicKeyUse};
use std::collections::HashSet;

pub(super) fn parse(bytes: &[u8]) -> Result<HashMap<String, DecodingKey>, Error> {
    let set: JwkSet = serde_json::from_slice(bytes).map_err(|_| Error::Unavailable)?;
    if set.keys.is_empty() || set.keys.len() > 64 {
        return Err(Error::Unavailable);
    }
    let mut seen = HashSet::new();
    let mut keys = HashMap::new();
    for jwk in set.keys {
        let Some(kid) = &jwk.common.key_id else {
            continue;
        };
        if !valid_key_id(kid) || !seen.insert(kid.clone()) {
            return Err(Error::Unavailable);
        }
        if !matches!(jwk.algorithm, AlgorithmParameters::RSA(_))
            || !matches!(jwk.common.key_algorithm, None | Some(KeyAlgorithm::RS256))
            || !matches!(
                jwk.common.public_key_use,
                None | Some(PublicKeyUse::Signature)
            )
            || jwk
                .common
                .key_operations
                .as_ref()
                .is_some_and(|ops| !ops.contains(&KeyOperations::Verify))
        {
            continue;
        }
        // The crypto provider verifies RSA modulus validity and supported size.
        let key = DecodingKey::from_jwk(&jwk).map_err(|_| Error::Unavailable)?;
        keys.insert(kid.clone(), key);
    }
    if keys.is_empty() {
        Err(Error::Unavailable)
    } else {
        Ok(keys)
    }
}
