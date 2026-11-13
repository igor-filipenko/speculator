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
              i.pair,
              COALESCE(a.cash_usdc, 0) AS cash_usdc,
              COALESCE(a.realized_pnl, 0) AS realized_pnl,
              COALESCE(p.side, 'flat') AS position_side,
              COALESCE(p.size, 0) AS position_size,
              COALESCE(p.entry_price, 0) AS entry_price,
              p.opened_at,
              COALESCE(a.updated_at, p.updated_at, now()) AS updated_at,
              ($2 = 'paper') AS simulated
            FROM strategy.instances i
            LEFT JOIN bot.virtual_accounts a
              ON a.strategy_id = i.id
             AND a.bot_id = $1
             AND a.mode = $2::bot.mode
            LEFT JOIN bot.positions p
              ON p.strategy_id = i.id
             AND p.bot_id = $1
             AND p.mode = $2::bot.mode
            WHERE a.strategy_id IS NOT NULL OR p.strategy_id IS NOT NULL
            ORDER BY i.pair, i.id
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
