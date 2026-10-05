-- migrate:up

CREATE SCHEMA IF NOT EXISTS strategy;
COMMENT ON SCHEMA strategy IS 'Strategies and their parameters';

CREATE TABLE IF NOT EXISTS strategy.registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL
);
COMMENT ON TABLE strategy.registry IS 'Strategies';
COMMENT ON COLUMN strategy.registry.id IS 'Strategy identifier (primary key)';
COMMENT ON COLUMN strategy.registry.name IS 'Strategy display name';
COMMENT ON COLUMN strategy.registry.type IS 'Strategy type';

INSERT INTO strategy.registry (id, name, type) VALUES
  ('bollinger', 'Bollinger Bands', 'mean-reversion'),
  ('donchian', 'Donchian Channel', 'trend-following'),
  ('grid', 'Grid', 'mean-reversion')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS bot.positions (
  bot_id         TEXT        NOT NULL,
  mode           bot.mode    NOT NULL,
  pair           TEXT        NOT NULL,
  strategy_id    TEXT        NOT NULL REFERENCES strategy.registry(id),
  strategy_data  JSONB       NOT NULL DEFAULT '{}',
  side           TEXT        NOT NULL,
  size           DOUBLE PRECISION NOT NULL,
  entry_price    DOUBLE PRECISION NOT NULL,
  sl_price       DOUBLE PRECISION NOT NULL,
  opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, mode, pair)
);
COMMENT ON TABLE bot.positions IS
  'Open position for one bot, mode (paper/live), and pair';
COMMENT ON COLUMN bot.positions.bot_id IS 'BOT_ID that owns this position';
COMMENT ON COLUMN bot.positions.mode IS 'paper (simulated) or live (on-chain)';
COMMENT ON COLUMN bot.positions.pair IS 'WATCHLIST pair (e.g. SOL/USDC)';
COMMENT ON COLUMN bot.positions.strategy_id IS 'strategy.registry id that opened this position';
COMMENT ON COLUMN bot.positions.strategy_data IS 'Reserved strategy state. Always an empty object';
COMMENT ON COLUMN bot.positions.side IS 'long or short';
COMMENT ON COLUMN bot.positions.size IS 'Base size of the open position';
COMMENT ON COLUMN bot.positions.entry_price IS 'Fill price of the open position';
COMMENT ON COLUMN bot.positions.sl_price IS 'Hard stop price set at open (long: entry − ATR stop, short: entry + ATR stop)';
COMMENT ON COLUMN bot.positions.opened_at IS 'When this position was opened (UTC)';
COMMENT ON COLUMN bot.positions.updated_at IS 'Last position write time (UTC)';
COMMENT ON CONSTRAINT positions_pkey ON bot.positions IS
  'One open position per bot, mode, and pair';
COMMENT ON CONSTRAINT positions_strategy_id_fkey ON bot.positions IS
  'strategy_id must exist in strategy.registry';

-- migrate:down

DROP TABLE IF EXISTS bot.positions;
DROP SCHEMA IF EXISTS strategy CASCADE;
