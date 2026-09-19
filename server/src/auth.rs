//! Telegram Mini App `initData` validation.

use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

use hmac::{Hmac, Mac};
use serde::Deserialize;
use sha2::Sha256;
use thiserror::Error;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, Error)]
pub enum AuthError {
    #[error("missing Authorization header")]
    MissingHeader,
    #[error("Authorization must be 'tma <initData>'")]
    BadScheme,
    #[error("invalid initData ({0})")]
    InvalidInitData(&'static str),
    #[error("initData expired")]
    Expired,
    #[error("user not allowed")]
    Forbidden,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TelegramUser {
    pub id: i64,
}

#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub id: i64,
}

/// Validate Telegram WebApp `initData` per
/// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
pub fn validate_init_data(
    init_data: &str,
    bot_token: &str,
    allowed_user_id: i64,
    max_age_secs: u64,
) -> Result<AuthedUser, AuthError> {
    tracing::debug!(
        init_data_len = init_data.len(),
        token_len = bot_token.len(),
        allowed_user_id,
        max_age_secs,
        "telegram initData validate start"
    );

    if init_data.is_empty() {
        tracing::warn!("telegram auth failed: empty initData");
        return Err(AuthError::InvalidInitData("empty"));
    }

    let mut map = BTreeMap::<String, String>::new();
    let mut pair_count = 0usize;
    let mut skipped_pairs = 0usize;
    for pair in init_data.split('&') {
        pair_count += 1;
        let Some((k, v)) = pair.split_once('=') else {
            skipped_pairs += 1;
            continue;
        };
        let key = urlencoding::decode(k)
            .map_err(|_| {
                tracing::warn!(key = k, "telegram auth failed: key percent-decode");
                AuthError::InvalidInitData("key decode")
            })?
            .into_owned();
        let value = urlencoding::decode(v)
            .map_err(|_| {
                tracing::warn!(key = %key, "telegram auth failed: value percent-decode");
                AuthError::InvalidInitData("value decode")
            })?
            .into_owned();
        map.insert(key, value);
    }

    let keys: Vec<String> = map.keys().cloned().collect();
    tracing::debug!(
        pair_count,
        skipped_pairs,
        keys = ?keys,
        "telegram initData fields"
    );

    let received_hash = match map.remove("hash") {
        Some(h) => h,
        None => {
            tracing::warn!(keys = ?keys, "telegram auth failed: missing hash field");
            return Err(AuthError::InvalidInitData("missing hash"));
        }
    };

    let data_check_string = map
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("\n");

    let mut secret_mac = HmacSha256::new_from_slice(b"WebAppData").map_err(|_| {
        tracing::error!("telegram auth failed: hmac key init");
        AuthError::InvalidInitData("hmac init")
    })?;
    secret_mac.update(bot_token.as_bytes());
    let secret_key = secret_mac.finalize().into_bytes();

    let mut mac = HmacSha256::new_from_slice(&secret_key).map_err(|_| {
        tracing::error!("telegram auth failed: hmac secret init");
        AuthError::InvalidInitData("hmac secret")
    })?;
    mac.update(data_check_string.as_bytes());
    let expected = mac.finalize().into_bytes();
    let expected_hex = hex::encode(expected);

    if !constant_time_eq(expected_hex.as_bytes(), received_hash.as_bytes()) {
        tracing::warn!(
            expected_len = expected_hex.len(),
            received_len = received_hash.len(),
            expected_prefix = %prefix(&expected_hex, 8),
            received_prefix = %prefix(&received_hash, 8),
            check_string_len = data_check_string.len(),
            keys = ?keys,
            "telegram auth failed: hash mismatch"
        );
        return Err(AuthError::InvalidInitData("hash mismatch"));
    }

    let auth_date_raw = match map.get("auth_date") {
        Some(v) => v,
        None => {
            tracing::warn!("telegram auth failed: missing auth_date");
            return Err(AuthError::InvalidInitData("missing auth_date"));
        }
    };
    let auth_date: u64 = match auth_date_raw.parse() {
        Ok(v) => v,
        Err(_) => {
            tracing::warn!(auth_date = %auth_date_raw, "telegram auth failed: auth_date not an integer");
            return Err(AuthError::InvalidInitData("auth_date"));
        }
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AuthError::InvalidInitData("clock"))?
        .as_secs();
    let age_secs = now.saturating_sub(auth_date);
    if age_secs > max_age_secs {
        tracing::warn!(
            auth_date,
            now,
            age_secs,
            max_age_secs,
            "telegram auth failed: expired"
        );
        return Err(AuthError::Expired);
    }

    let user_json = match map.get("user") {
        Some(v) => v,
        None => {
            tracing::warn!("telegram auth failed: missing user field");
            return Err(AuthError::InvalidInitData("missing user"));
        }
    };
    let user: TelegramUser = match serde_json::from_str(user_json) {
        Ok(u) => u,
        Err(err) => {
            tracing::warn!(error = %err, user_len = user_json.len(), "telegram auth failed: user json");
            return Err(AuthError::InvalidInitData("user json"));
        }
    };

    if user.id != allowed_user_id {
        tracing::warn!(
            user_id = user.id,
            allowed_user_id,
            "telegram auth failed: user not allowed"
        );
        return Err(AuthError::Forbidden);
    }

    tracing::info!(user_id = user.id, age_secs, "telegram auth ok");
    Ok(AuthedUser { id: user.id })
}

pub fn extract_tma_init_data(authorization: Option<&str>) -> Result<&str, AuthError> {
    let header = match authorization {
        Some(h) => h,
        None => {
            tracing::warn!("telegram auth failed: no Authorization header");
            return Err(AuthError::MissingHeader);
        }
    };
    tracing::debug!(
        header_len = header.len(),
        scheme_prefix = %prefix(header, 8),
        "telegram Authorization header"
    );
    let Some((scheme, rest)) = header.split_once(' ') else {
        tracing::warn!(
            header_len = header.len(),
            "telegram auth failed: Authorization has no space"
        );
        return Err(AuthError::BadScheme);
    };
    if !scheme.eq_ignore_ascii_case("tma") {
        tracing::warn!(scheme, "telegram auth failed: expected tma scheme");
        return Err(AuthError::BadScheme);
    }
    if rest.is_empty() {
        tracing::warn!("telegram auth failed: tma scheme with empty initData");
        return Err(AuthError::BadScheme);
    }
    Ok(rest)
}

fn prefix(value: &str, n: usize) -> String {
    value.chars().take(n).collect()
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_init_data(token: &str, user_id: i64, auth_date: u64) -> String {
        let user = format!("{{\"id\":{user_id}}}");
        let user_enc = urlencoding::encode(&user);
        let unsigned = format!("auth_date={auth_date}&user={user_enc}");
        let mut map = BTreeMap::new();
        map.insert("auth_date".to_string(), auth_date.to_string());
        map.insert("user".to_string(), user);
        let data_check_string = map
            .iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut secret_mac = HmacSha256::new_from_slice(b"WebAppData").unwrap();
        secret_mac.update(token.as_bytes());
        let secret_key = secret_mac.finalize().into_bytes();
        let mut mac = HmacSha256::new_from_slice(&secret_key).unwrap();
        mac.update(data_check_string.as_bytes());
        let hash = hex::encode(mac.finalize().into_bytes());
        format!("{unsigned}&hash={hash}")
    }

    #[test]
    fn rejects_missing_hash() {
        let err = validate_init_data("auth_date=1&user=%7B%22id%22%3A1%7D", "token", 1, 86400)
            .unwrap_err();
        assert!(matches!(err, AuthError::InvalidInitData("missing hash")));
    }

    #[test]
    fn accepts_valid_init_data() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let init = signed_init_data("test-token", 42, now);
        let user = validate_init_data(&init, "test-token", 42, 86400).unwrap();
        assert_eq!(user.id, 42);
    }

    #[test]
    fn rejects_wrong_user() {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let init = signed_init_data("test-token", 42, now);
        let err = validate_init_data(&init, "test-token", 99, 86400).unwrap_err();
        assert!(matches!(err, AuthError::Forbidden));
    }
}
