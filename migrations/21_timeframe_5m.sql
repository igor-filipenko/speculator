-- migrate:up transaction:false

ALTER TYPE market.timeframe ADD VALUE IF NOT EXISTS '5m';
COMMENT ON TYPE market.timeframe IS 'OHLCV bar size: 5m/15m strategy bars, 1h MTF volatility, 4h/1d higher-timeframe bars';

-- migrate:down

-- Enum values cannot be removed safely; leave 5m in place.
