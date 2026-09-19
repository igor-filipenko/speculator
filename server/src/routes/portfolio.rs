use std::sync::Arc;

use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::{Deserialize, Serialize};

use crate::auth::{extract_tma_init_data, validate_init_data, AuthError};
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct PortfolioQuery {
    /// `paper` (default) or `live`.
    #[serde(default = "default_mode")]
    pub mode: String,
}

fn default_mode() -> String {
    "paper".to_string()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionDto {
    pub pair: String,
    pub side: String,
    pub size: f64,
    pub entry_price: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opened_at: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioItemDto {
    pub pair: String,
    pub cash_usdc: f64,
    pub realized_pnl: f64,
    /// Mark-to-market using entry price when long (no live mark in DB).
    pub equity: f64,
    pub position: PositionDto,
    pub simulated: bool,
    pub updated_at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PortfolioResponse {
    pub mode: String,
    pub bot_id: String,
    pub portfolios: Vec<PortfolioItemDto>,
}

#[derive(Serialize)]
pub struct ErrorBody {
    error: String,
}

pub async fn portfolio(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<PortfolioQuery>,
) -> Result<Json<PortfolioResponse>, (StatusCode, Json<ErrorBody>)> {
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
        "portfolio auth headers"
    );
    let init_data = extract_tma_init_data(auth_header).map_err(map_auth)?;
    validate_init_data(
        init_data,
        &state.config.telegram_bot_token,
        state.config.telegram_allowed_user_id,
        state.config.init_data_max_age_secs,
    )
    .map_err(map_auth)?;

    let mode = query.mode.trim().to_ascii_lowercase();
    if mode != "paper" && mode != "live" {
        return Err((
            StatusCode::BAD_REQUEST,
            Json(ErrorBody {
                error: "mode must be paper or live".into(),
            }),
        ));
    }

    let rows = state
        .db
        .list_portfolios(&state.config.bot_id, &mode)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "portfolio query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "database error".into(),
                }),
            )
        })?;

    let portfolios = rows
        .into_iter()
        .map(|row| {
            let position_value = if row.position_side == "long" {
                row.position_size * row.entry_price
            } else {
                0.0
            };
            PortfolioItemDto {
                pair: row.pair.clone(),
                cash_usdc: row.cash_usdc,
                realized_pnl: row.realized_pnl,
                equity: row.cash_usdc + position_value,
                position: PositionDto {
                    pair: row.pair,
                    side: row.position_side,
                    size: row.position_size,
                    entry_price: row.entry_price,
                    opened_at: row.opened_at.map(|t| t.to_rfc3339()),
                },
                simulated: row.simulated,
                updated_at: row.updated_at.to_rfc3339(),
            }
        })
        .collect();

    Ok(Json(PortfolioResponse {
        mode,
        bot_id: state.config.bot_id.clone(),
        portfolios,
    }))
}

fn map_auth(err: AuthError) -> (StatusCode, Json<ErrorBody>) {
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
