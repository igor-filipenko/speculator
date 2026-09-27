//! Timescale / Postgres access for read-only Mini App queries.

use chrono::{DateTime, Utc};
use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

#[derive(Clone)]
pub struct Db {
    pool: PgPool,
}

#[derive(Debug, sqlx::FromRow)]
pub struct PortfolioRow {
    pub pair: String,
    pub cash_usdc: f64,
    pub realized_pnl: f64,
    pub position_side: String,
    pub position_size: f64,
    pub entry_price: f64,
    pub opened_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
    pub simulated: bool,
}

#[derive(Debug, sqlx::FromRow)]
pub struct SignalRow {
    pub pair: String,
    pub side: String,
    pub price: f64,
    pub reason: String,
    pub at: DateTime<Utc>,
    pub ema_fast: Option<f64>,
    pub ema_slow: Option<f64>,
    pub rsi: Option<f64>,
    pub trend_ema: Option<f64>,
    pub atr: Option<f64>,
    pub adx: Option<f64>,
}

impl Db {
    pub async fn connect(database_url: &str) -> Result<Self, sqlx::Error> {
        let pool = PgPoolOptions::new()
            .max_connections(5)
            .connect(database_url)
            .await?;
        Ok(Self { pool })
    }

    pub async fn list_portfolios(
        &self,
        bot_id: &str,
        mode: &str,
    ) -> Result<Vec<PortfolioRow>, sqlx::Error> {
        // `simulated` is true for paper; for live we still flag from mode.
        sqlx::query_as::<_, PortfolioRow>(
            r#"
            SELECT
              pair,
              cash_usdc,
              realized_pnl,
              position_side,
              position_size,
              entry_price,
              opened_at,
              updated_at,
              ($2 = 'paper') AS simulated
            FROM bot.portfolios
            WHERE bot_id = $1 AND mode = $2::bot.mode
            ORDER BY pair
            "#,
        )
        .bind(bot_id)
        .bind(mode)
        .fetch_all(&self.pool)
        .await
    }

    /// Newest strategy signal for this bot (`market.signals`).
    pub async fn latest_signal(&self, bot_id: &str) -> Result<Option<SignalRow>, sqlx::Error> {
        sqlx::query_as::<_, SignalRow>(
            r#"
            SELECT
              pair,
              side,
              price,
              reason,
              "at",
              ema_fast,
              ema_slow,
              rsi,
              trend_ema,
              atr,
              adx
            FROM market.signals
            WHERE bot_id = $1
            ORDER BY "at" DESC, id DESC
            LIMIT 1
            "#,
        )
        .bind(bot_id)
        .fetch_optional(&self.pool)
        .await
    }
}
