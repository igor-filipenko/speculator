-- migrate:up

DO $$ BEGIN
  CREATE TYPE market.candle_source AS ENUM (
    'gecko-terminal',
    'binance',
    'bybit',
    'okx',
    'coinbase',
    'kraken',
    'bitget',
    'kucoin',
    'gate',
    'mexc',
    'htx',
    'bitfinex',
    'upbit',
    'hyperliquid',
    'birdeye',
    'dexscreener'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
COMMENT ON TYPE market.candle_source IS
  'OHLCV vendor. Rows written before this type existed are gecko-terminal.';

ALTER TABLE market.candles
  ADD COLUMN IF NOT EXISTS source market.candle_source NOT NULL DEFAULT 'gecko-terminal';
COMMENT ON COLUMN market.candles.source IS
  'Vendor that produced this bar. Default keeps inserts that omit the column on gecko-terminal.';

ALTER TABLE market.candles DROP CONSTRAINT IF EXISTS candles_pkey;
ALTER TABLE market.candles
  ADD CONSTRAINT candles_pkey PRIMARY KEY (source, pool_address, timeframe, time);
COMMENT ON CONSTRAINT candles_pkey ON market.candles IS
  'One bar per source, pool, timeframe, and open time';

DROP INDEX IF EXISTS market.candles_pool_tf_time_idx;
CREATE INDEX IF NOT EXISTS candles_source_pool_tf_time_idx
  ON market.candles (source, pool_address, timeframe, time DESC);
COMMENT ON INDEX market.candles_source_pool_tf_time_idx IS
  'Lookup latest bars for a source, pool, and timeframe';

COMMENT ON TABLE market.candles IS
  'Timescale hypertable of OHLCV bars keyed by source, pool, timeframe, and open time';

-- migrate:down

DELETE FROM market.candles WHERE source <> 'gecko-terminal';
DROP INDEX IF EXISTS market.candles_source_pool_tf_time_idx;
ALTER TABLE market.candles DROP CONSTRAINT IF EXISTS candles_pkey;
ALTER TABLE market.candles DROP COLUMN IF EXISTS source;
ALTER TABLE market.candles
  ADD CONSTRAINT candles_pkey PRIMARY KEY (pool_address, timeframe, time);
CREATE INDEX IF NOT EXISTS candles_pool_tf_time_idx
  ON market.candles (pool_address, timeframe, time DESC);
DROP TYPE IF EXISTS market.candle_source;
COMMENT ON TABLE market.candles IS
  'Timescale hypertable of OHLCV bars keyed by pool, timeframe, and open time';
