pub mod health;
pub mod portfolio;
pub mod signal;

use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;

use crate::auth::{extract_tma_init_data, validate_init_data, AuthError};
use crate::AppState;

#[derive(Serialize)]
pub struct ErrorBody {
    pub error: String,
}

pub fn map_auth(err: AuthError) -> (StatusCode, Json<ErrorBody>) {
    let status = match err {
        AuthError::Forbidden => StatusCode::FORBIDDEN,
        AuthError::Expired => StatusCode::UNAUTHORIZED,
        AuthError::MissingHeader | AuthError::BadScheme | AuthError::InvalidInitData(_) => {
            StatusCode::UNAUTHORIZED
        }
    };
    (
        status,
        Json(ErrorBody {
            error: err.to_string(),
        }),
    )
}

/// Telegram `initData` check shared by read routes. No-op when `--dev` set `skip_auth`.
pub fn authorize(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ErrorBody>)> {
    if state.config.skip_auth {
        tracing::debug!("auth skipped (--dev)");
        return Ok(());
    }
    let auth_header = match headers.get("authorization") {
        None => None,
        Some(value) => match value.to_str() {
            Ok(s) => Some(s),
            Err(err) => {
                tracing::warn!(error = %err, "telegram Authorization header is not ASCII");
                return Err(map_auth(AuthError::BadScheme));
            }
        },
    };
    tracing::debug!(
        has_authorization = auth_header.is_some(),
        header_names = ?headers.keys().map(|n| n.as_str()).collect::<Vec<_>>(),
        "auth headers"
    );
    let init_data = extract_tma_init_data(auth_header).map_err(map_auth)?;
    validate_init_data(
        init_data,
        &state.config.telegram_bot_token,
        state.config.telegram_allowed_user_id,
        state.config.init_data_max_age_secs,
    )
    .map_err(map_auth)?;
    Ok(())
}
