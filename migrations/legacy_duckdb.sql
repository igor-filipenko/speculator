-- DuckDB source schema expected by `pnpm import-duckdb`.
-- Not applied by `pnpm migrate` (Timescale uses Vn__*.sql only).

CREATE SCHEMA IF NOT EXISTS paper;
CREATE SCHEMA IF NOT EXISTS live;
CREATE SCHEMA IF NOT EXISTS solana;

CREATE TABLE IF NOT EXISTS candles (
  symbol     VARCHAR NOT NULL,
  timeframe  VARCHAR NOT NULL,
  time       BIGINT  NOT NULL,
  open       DOUBLE  NOT NULL,
  high       DOUBLE  NOT NULL,
  low        DOUBLE  NOT NULL,
  close      DOUBLE  NOT NULL,
  volume     DOUBLE  NOT NULL,
  fetched_at TIMESTAMP NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, timeframe, time)
);

CREATE SEQUENCE IF NOT EXISTS paper.trades_id_seq;
CREATE SEQUENCE IF NOT EXISTS signals_id_seq;
CREATE SEQUENCE IF NOT EXISTS live.trades_id_seq;

CREATE TABLE IF NOT EXISTS paper.portfolios (
  pair           VARCHAR NOT NULL PRIMARY KEY,
  cash_usdc      DOUBLE  NOT NULL,
  realized_pnl   DOUBLE  NOT NULL,
  position_side  VARCHAR NOT NULL,
  position_size  DOUBLE  NOT NULL,
  entry_price    DOUBLE  NOT NULL,
  opened_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS paper.trades (
  id           BIGINT PRIMARY KEY DEFAULT nextval('paper.trades_id_seq'),
  pair         VARCHAR NOT NULL,
  side         VARCHAR NOT NULL,
  price        DOUBLE  NOT NULL,
  size         DOUBLE  NOT NULL,
  realized_pnl DOUBLE,
  "at"         TIMESTAMP NOT NULL,
  simulated    BOOLEAN NOT NULL DEFAULT true
);

CREATE INDEX IF NOT EXISTS paper_trades_pair_idx ON paper.trades (pair);

CREATE TABLE IF NOT EXISTS live.portfolios (
  pair           VARCHAR NOT NULL PRIMARY KEY,
  cash_usdc      DOUBLE  NOT NULL,
  realized_pnl   DOUBLE  NOT NULL,
  position_side  VARCHAR NOT NULL,
  position_size  DOUBLE  NOT NULL,
  entry_price    DOUBLE  NOT NULL,
  opened_at      TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS live.trades (
  id           BIGINT PRIMARY KEY DEFAULT nextval('live.trades_id_seq'),
  pair         VARCHAR NOT NULL,
  side         VARCHAR NOT NULL,
  price        DOUBLE  NOT NULL,
  size         DOUBLE  NOT NULL,
  realized_pnl DOUBLE,
  "at"         TIMESTAMP NOT NULL,
  simulated    BOOLEAN NOT NULL DEFAULT false,
  tx_signature VARCHAR
);

CREATE INDEX IF NOT EXISTS live_trades_pair_idx ON live.trades (pair);

CREATE TABLE IF NOT EXISTS signals (
  id        BIGINT PRIMARY KEY DEFAULT nextval('signals_id_seq'),
  "at"      TIMESTAMP NOT NULL,
  pair      VARCHAR NOT NULL,
  side      VARCHAR NOT NULL,
  price     DOUBLE  NOT NULL,
  reason    VARCHAR NOT NULL,
  ema_fast  DOUBLE,
  ema_slow  DOUBLE,
  rsi       DOUBLE,
  trend_ema DOUBLE,
  atr       DOUBLE,
  adx       DOUBLE
);

CREATE INDEX IF NOT EXISTS signals_at_idx ON signals ("at");

CREATE TABLE IF NOT EXISTS solana.tokens (
  symbol       VARCHAR NOT NULL PRIMARY KEY,
  mint         VARCHAR NOT NULL,
  decimals     INTEGER NOT NULL,
  pool_address VARCHAR
);

INSERT INTO solana.tokens (symbol, mint, decimals, pool_address)
VALUES
  ('SOL', 'So11111111111111111111111111111111111111112', 9, '8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj'),
  ('USDC', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', 6, NULL),
  ('JUP', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN', 6, 'HfgjZDmexhFVD28Vkb1NbQwWeXP3uDcVTLPjSGHmRHhL'),
  ('JTO', 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL', 9, '93MjUKNKxazKmgS3GBX2Gj2BttEjJUyi7NYeyDHdHSc2')
ON CONFLICT (symbol) DO NOTHING;
