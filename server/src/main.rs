//! Speculator Telegram Mini App HTTP server.

mod auth;
mod config;
mod db;
mod routes;

use std::net::SocketAddr;
use std::sync::Arc;

use axum::routing::get;
use axum::Router;
use tower_http::cors::CorsLayer;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing_subscriber::EnvFilter;

use crate::config::Config;
use crate::db::Db;
use crate::routes::{health, portfolio};

pub struct AppState {
    pub config: Config,
    pub db: Db,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| EnvFilter::new("speculator_web=debug,tower_http=info,info")),
        )
        .init();

    let _ = dotenvy::dotenv();
    let config = Config::from_env()?;
    tracing::info!(
        listen = %config.listen,
        bot_id = %config.bot_id,
        allowed_user_id = config.telegram_allowed_user_id,
        token_len = config.telegram_bot_token.len(),
        static_dir = %config.static_dir.display(),
        "starting miniapp"
    );
    let db = Db::connect(&config.database_url).await?;
    let state = Arc::new(AppState {
        config: config.clone(),
        db,
    });

    let static_dir = config.static_dir.clone();
    let index = static_dir.join("index.html");
    let spa = ServeDir::new(&static_dir).not_found_service(ServeFile::new(index));

    let api = Router::new()
        .route("/health", get(health::health))
        .route("/portfolio", get(portfolio::portfolio))
        .with_state(state);

    let app = Router::new()
        .nest("/api", api)
        .fallback_service(spa)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = config.listen.parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "listening (HTTP)");
    axum::serve(listener, app).await?;

    Ok(())
}
