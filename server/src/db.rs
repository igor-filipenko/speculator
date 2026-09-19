//! Timescale / Postgres access for portfolio reads.

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
}
