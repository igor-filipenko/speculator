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
  side           TEXT             NOT NULL,
  size           DOUBLE PRECISION NOT NULL,
  entry_price    DOUBLE PRECISION NOT NULL,
  sl_price       DOUBLE PRECISION NOT NULL,
  opened_at      TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ      NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, mode, pair),
  CONSTRAINT positions_side_check CHECK (side IN ('long', 'short')),
  CONSTRAINT positions_size_check CHECK (size > 0),
  CONSTRAINT positions_entry_price_check CHECK (entry_price > 0),
  CONSTRAINT positions_sl_price_check CHECK (sl_price > 0)
);
COMMENT ON TABLE bot.positions IS 'Open positions for bot';
COMMENT ON COLUMN bot.positions.bot_id IS 'BOT_ID that owns this position';
COMMENT ON COLUMN bot.positions.mode IS 'paper (simulated) or live (on-chain)';
COMMENT ON COLUMN bot.positions.pair IS 'pair (e.g. SOL/USDC)';
COMMENT ON COLUMN bot.positions.strategy_id IS 'strategy.registry id that opened this position';
COMMENT ON COLUMN bot.positions.strategy_data IS 'Reserved strategy state. Always an empty object';
COMMENT ON COLUMN bot.positions.side IS 'long or short';
COMMENT ON COLUMN bot.positions.size IS 'Base size of the open position';
COMMENT ON COLUMN bot.positions.entry_price IS 'Fill price of the open position';
COMMENT ON COLUMN bot.positions.sl_price IS 'Hard stop price set at open';
COMMENT ON COLUMN bot.positions.opened_at IS 'When this position was opened (UTC)';
COMMENT ON COLUMN bot.positions.updated_at IS 'Last position write time (UTC)';
COMMENT ON CONSTRAINT positions_pkey ON bot.positions IS
  'One open position per bot, mode, and pair';
COMMENT ON CONSTRAINT positions_strategy_id_fkey ON bot.positions IS
  'strategy_id must exist in strategy.registry';
COMMENT ON CONSTRAINT positions_side_check ON bot.positions IS
  'side is long or short';
COMMENT ON CONSTRAINT positions_size_check ON bot.positions IS
  'size is greater than zero';
COMMENT ON CONSTRAINT positions_entry_price_check ON bot.positions IS
  'entry_price is greater than zero';
COMMENT ON CONSTRAINT positions_sl_price_check ON bot.positions IS
  'sl_price is greater than zero';

-- migrate:down

DROP TABLE IF EXISTS bot.positions;
DROP SCHEMA IF EXISTS strategy CASCADE;
