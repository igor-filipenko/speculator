use std::sync::Arc;

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use serde::Serialize;

use super::{authorize, ErrorBody};
use crate::db::SignalRow;
use crate::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalDto {
    pub pair: String,
    pub side: String,
    pub price: f64,
    pub reason: String,
    pub at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ema_fast: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ema_slow: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rsi: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trend_ema: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub atr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adx: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalResponse {
    pub bot_id: String,
    pub signal: Option<SignalDto>,
}

pub async fn signal(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
) -> Result<Json<SignalResponse>, (StatusCode, Json<ErrorBody>)> {
    authorize(&state, &headers)?;

    let row = state
        .db
        .latest_signal(&state.config.bot_id)
        .await
        .map_err(|e| {
            tracing::error!(error = %e, "signal query failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorBody {
                    error: "database error".into(),
                }),
            )
        })?;

    Ok(Json(SignalResponse {
        bot_id: state.config.bot_id.clone(),
        signal: row.map(signal_dto),
    }))
}

fn signal_dto(row: SignalRow) -> SignalDto {
    SignalDto {
        pair: row.pair,
        side: row.side,
        price: row.price,
        reason: row.reason,
        at: row.at.to_rfc3339(),
        ema_fast: row.ema_fast,
        ema_slow: row.ema_slow,
        rsi: row.rsi,
        trend_ema: row.trend_ema,
        atr: row.atr,
        adx: row.adx,
    }
}
