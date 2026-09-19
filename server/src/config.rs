//! Process config from environment.

use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub database_url: String,
    pub bot_id: String,
    pub telegram_bot_token: String,
    pub telegram_allowed_user_id: i64,
    pub listen: String,
    pub static_dir: PathBuf,
    /// Max age of Telegram `auth_date` in seconds (default 24h).
    pub init_data_max_age_secs: u64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let database_url = normalize_database_url(&required("DATABASE_URL")?);
        let bot_id = env_or("BOT_ID", "local");
        let telegram_bot_token = required("TELEGRAM_BOT_TOKEN")?;
        let allowed = env_or("TELEGRAM_ALLOWED_USER_ID", "").trim().to_string();
        let allowed = if allowed.is_empty() {
            // Fall back to TELEGRAM_CHAT_ID (private chat id == user id).
            required("TELEGRAM_CHAT_ID")?
        } else {
            allowed
        };
        let telegram_allowed_user_id: i64 = allowed
            .parse()
            .map_err(|_| "TELEGRAM_ALLOWED_USER_ID / TELEGRAM_CHAT_ID must be an integer")?;

        let listen = env_or("WEB_LISTEN", "127.0.0.1:8787");
        let static_dir = PathBuf::from(env_or("WEB_STATIC_DIR", "web/dist"));
        let init_data_max_age_secs: u64 = env_or("TELEGRAM_INIT_DATA_MAX_AGE_SECS", "86400")
            .parse()
            .map_err(|_| "TELEGRAM_INIT_DATA_MAX_AGE_SECS must be an integer")?;

        Ok(Self {
            database_url,
            bot_id,
            telegram_bot_token,
            telegram_allowed_user_id,
            listen,
            static_dir,
            init_data_max_age_secs,
        })
    }
}

fn required(key: &str) -> Result<String, String> {
    std::env::var(key)
        .map(|v| v.trim().to_string())
        .ok()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("missing required env {key}"))
}

fn optional(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_or(key: &str, default: &str) -> String {
    optional(key).unwrap_or_else(|| default.to_string())
}

/// sqlx does not accept Node/`pg` `sslmode=no-verify` (TLS, skip cert check).
/// Map it to libpq/sqlx `require`, which has the same meaning.
fn normalize_database_url(url: &str) -> String {
    let mut out = url.to_string();
    for key in ["sslmode", "ssl_mode"] {
        for sep in ['?', '&'] {
            let from = format!("{sep}{key}=no-verify");
            let to = format!("{sep}{key}=require");
            out = out.replace(&from, &to);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_no_verify_to_require() {
        let url = "postgres://u:p@db:5432/speculator?sslmode=no-verify";
        assert_eq!(
            normalize_database_url(url),
            "postgres://u:p@db:5432/speculator?sslmode=require"
        );
    }
}
