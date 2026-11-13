-- migrate:up

CREATE TYPE market.chain AS ENUM (
  'solana',      -- Fast finality and very low DEX fees (Jupiter, Raydium)
  'base',        -- Ethereum L2 with cheap gas and deep liquidity
  'arbitrum',    -- Ethereum L2 with deep liquidity and fast finality
  'optimism',    -- Ethereum L2 with low gas and deep Uniswap liquidity
  'polygon',     -- Low-fee EVM network for smart contracts and cross-chain trading
  'bsc',         -- BNB Smart Chain, low fees for high-yield pools and token scans
  'avalanche',   -- C-chain, low fees and active DEX volume
  'sonic',       -- Low-fee EVM chain with active DEX trading
  'unichain',    -- Uniswap L2, low fees and native DEX liquidity
  'berachain',   -- Low-fee EVM chain built around DEX liquidity
  'hyperliquid', -- Low-fee perps trading
  'sui',         -- Low fees and fast finality for DEX trading
  'aptos',       -- Low fees and growing DEX liquidity
  'sei',         -- Order-book chain with low trading fees
  'injective',   -- Trading-focused chain with low fees
  'ton',         -- Low fees and high retail trading volume
  'tron'         -- Very cheap transfers and deep USDT liquidity
);
COMMENT ON TYPE market.chain IS 'Chains with low trading fees. bot.wallets.chain uses this type';

CREATE SCHEMA IF NOT EXISTS exchange;
COMMENT ON SCHEMA exchange IS 'Venue catalog, account kinds, and the net open position per bot, mode, and pair';

CREATE TYPE exchange.account_type AS ENUM ('wallet', 'exchange');
COMMENT ON TYPE exchange.account_type IS
  'wallet is a chain address in bot.wallets; exchange is a venue login in bot.exchange_accounts';

CREATE TABLE IF NOT EXISTS exchange.integrations (
  id            TEXT PRIMARY KEY,
  account_type  exchange.account_type NOT NULL,
  UNIQUE (id, account_type)
);
COMMENT ON TABLE exchange.integrations IS
  'Venue adapters. Paper and backtest write emulated on the exchange position; instances store the live adapter';
COMMENT ON COLUMN exchange.integrations.id IS 'Integration identifier (primary key)';
COMMENT ON COLUMN exchange.integrations.account_type IS
  'Which bot account subtype can hold this integration';
COMMENT ON CONSTRAINT integrations_id_account_type_key ON exchange.integrations IS
  'Lets a subtype row reference both the integration and its account kind';

INSERT INTO exchange.integrations (id, account_type) VALUES
  ('emulated', 'exchange'),
  ('jupiter', 'wallet')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS strategy.instances (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  registry_id     TEXT NOT NULL REFERENCES strategy.registry (id),
  pair            TEXT NOT NULL,
  candle_source   market.candle_source NOT NULL,
  exchange_id     TEXT NOT NULL REFERENCES exchange.integrations (id),
  risk_percent    DOUBLE PRECISION NOT NULL DEFAULT 2,
  params          JSONB NOT NULL DEFAULT '{}',
  CONSTRAINT instances_risk_percent_check CHECK (risk_percent > 0 AND risk_percent <= 100)
);
COMMENT ON TABLE strategy.instances IS
  'One configured strategy and exactly one pair. bot.strategy_id values reference this id';
COMMENT ON COLUMN strategy.instances.id IS 'Strategy identity used by virtual accounts, positions, trades, and signals';
COMMENT ON COLUMN strategy.instances.registry_id IS 'strategy.registry id of the code module';
COMMENT ON COLUMN strategy.instances.pair IS 'The one pair this instance trades';
COMMENT ON COLUMN strategy.instances.candle_source IS 'OHLCV vendor for this instance';
COMMENT ON COLUMN strategy.instances.exchange_id IS
  'Live venue. Required on every instance; paper writes emulated on the exchange position';
COMMENT ON COLUMN strategy.instances.risk_percent IS 'Percent of this instance equity risked on a new entry';
COMMENT ON COLUMN strategy.instances.params IS 'Knob snapshot. Missing keys still resolve from code defaults';
COMMENT ON CONSTRAINT instances_risk_percent_check ON strategy.instances IS
  'risk_percent is greater than 0 and at most 100';

CREATE TABLE IF NOT EXISTS exchange.positions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id          TEXT NOT NULL,
  mode            bot.mode NOT NULL,
  integration_id  TEXT NOT NULL REFERENCES exchange.integrations (id),
  pair            TEXT NOT NULL,
  side            TEXT NOT NULL,
  size            DOUBLE PRECISION NOT NULL,
  CONSTRAINT exchange_positions_bot_mode_pair_key UNIQUE (bot_id, mode, pair),
  CONSTRAINT exchange_positions_side_size_check CHECK (
    (side = 'flat' AND size = 0) OR (side IN ('long', 'short') AND size > 0)
  )
);
COMMENT ON TABLE exchange.positions IS
  'One venue position per bot, mode, and pair. It exists only while a bot position links to it';
COMMENT ON COLUMN exchange.positions.id IS 'Identity referenced by bot.positions';
COMMENT ON COLUMN exchange.positions.bot_id IS 'BOT_ID that owns this venue position';
COMMENT ON COLUMN exchange.positions.mode IS 'paper uses emulated; live uses the instance integration';
COMMENT ON COLUMN exchange.positions.integration_id IS 'Adapter that holds this position';
COMMENT ON COLUMN exchange.positions.pair IS 'Pair of the net position';
COMMENT ON COLUMN exchange.positions.side IS 'long, short, or flat when the linked books offset';
COMMENT ON COLUMN exchange.positions.size IS 'Net base size. Zero while linked books offset';
COMMENT ON CONSTRAINT exchange_positions_bot_mode_pair_key ON exchange.positions IS
  'One venue position per bot, mode, and pair';
COMMENT ON CONSTRAINT exchange_positions_side_size_check ON exchange.positions IS
  'flat has size 0; long and short have size greater than zero';

CREATE TABLE IF NOT EXISTS bot.strategies (
  bot_id        TEXT NOT NULL,
  strategy_id   UUID NOT NULL REFERENCES strategy.instances (id) ON DELETE CASCADE,
  deposit_usdc  DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (bot_id, strategy_id),
  CONSTRAINT strategies_deposit_check CHECK (deposit_usdc >= 0)
);
COMMENT ON TABLE bot.strategies IS 'Instances assigned to a bot and each instance virtual deposit';
COMMENT ON COLUMN bot.strategies.bot_id IS 'BOT_ID that owns this assignment';
COMMENT ON COLUMN bot.strategies.strategy_id IS 'strategy.instances id';
COMMENT ON COLUMN bot.strategies.deposit_usdc IS 'Virtual USDC deposit for this instance on this bot';
COMMENT ON CONSTRAINT strategies_deposit_check ON bot.strategies IS 'deposit_usdc is not negative';

CREATE TABLE IF NOT EXISTS bot.selection (
  bot_id       TEXT PRIMARY KEY,
  strategy_id  UUID NOT NULL REFERENCES strategy.instances (id) ON DELETE CASCADE
);
COMMENT ON TABLE bot.selection IS 'The one instance backtest and tune run for this bot';
COMMENT ON COLUMN bot.selection.bot_id IS 'BOT_ID';
COMMENT ON COLUMN bot.selection.strategy_id IS 'strategy.instances id selected by strategy use';

CREATE TABLE IF NOT EXISTS bot.virtual_accounts (
  bot_id        TEXT NOT NULL,
  mode          bot.mode NOT NULL,
  strategy_id   UUID NOT NULL REFERENCES strategy.instances (id) ON DELETE CASCADE,
  cash_usdc     DOUBLE PRECISION NOT NULL,
  realized_pnl  DOUBLE PRECISION NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, mode, strategy_id)
);
COMMENT ON TABLE bot.virtual_accounts IS 'Virtual cash ledger for one bot, mode, and strategy instance';
COMMENT ON COLUMN bot.virtual_accounts.bot_id IS 'BOT_ID that owns this ledger';
COMMENT ON COLUMN bot.virtual_accounts.mode IS 'paper (simulated) or live (on-chain)';
COMMENT ON COLUMN bot.virtual_accounts.strategy_id IS 'strategy.instances id';
COMMENT ON COLUMN bot.virtual_accounts.cash_usdc IS 'Quote cash on this instance';
COMMENT ON COLUMN bot.virtual_accounts.realized_pnl IS 'Cumulative realized PnL in USDC';
COMMENT ON COLUMN bot.virtual_accounts.updated_at IS 'Last ledger write time (UTC)';

CREATE TABLE IF NOT EXISTS bot.accounts (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        TEXT NOT NULL,
  account_type  exchange.account_type NOT NULL,
  usdc          DOUBLE PRECISION NOT NULL,
  UNIQUE (id, account_type),
  CONSTRAINT accounts_usdc_check CHECK (usdc >= 0)
);
COMMENT ON TABLE bot.accounts IS
  'Real account for one bot. account_type picks bot.wallets or bot.exchange_accounts';
COMMENT ON COLUMN bot.accounts.id IS 'Identity shared with exactly one subtype row';
COMMENT ON COLUMN bot.accounts.bot_id IS 'BOT_ID that owns this account';
COMMENT ON COLUMN bot.accounts.account_type IS 'wallet or exchange. Fixed for the life of the row';
COMMENT ON COLUMN bot.accounts.usdc IS 'USDC balance on this account';
COMMENT ON CONSTRAINT accounts_id_account_type_key ON bot.accounts IS
  'Lets a subtype row reference both the account and its kind';
COMMENT ON CONSTRAINT accounts_usdc_check ON bot.accounts IS 'usdc is not negative';

CREATE TABLE IF NOT EXISTS bot.wallets (
  account_id      UUID PRIMARY KEY,
  account_type    exchange.account_type NOT NULL DEFAULT 'wallet',
  chain           market.chain NOT NULL,
  public_address  TEXT NOT NULL,
  native_balance  DOUBLE PRECISION NOT NULL,
  CONSTRAINT wallets_type_check CHECK (account_type = 'wallet'),
  CONSTRAINT wallets_address_check CHECK (length(public_address) > 0),
  CONSTRAINT wallets_native_balance_check CHECK (native_balance >= 0),
  CONSTRAINT wallets_account_fkey
    FOREIGN KEY (account_id, account_type) REFERENCES bot.accounts (id, account_type) ON DELETE CASCADE,
  CONSTRAINT wallets_chain_address_key UNIQUE (chain, public_address)
);
COMMENT ON TABLE bot.wallets IS 'Chain wallet subtype of bot.accounts';
COMMENT ON COLUMN bot.wallets.account_id IS 'bot.accounts id';
COMMENT ON COLUMN bot.wallets.account_type IS 'Always wallet, so this row cannot point at an exchange account';
COMMENT ON COLUMN bot.wallets.chain IS 'Chain this address lives on';
COMMENT ON COLUMN bot.wallets.public_address IS 'Public address. The keypair stays outside the database';
COMMENT ON COLUMN bot.wallets.native_balance IS 'Native coin balance on this address';
COMMENT ON CONSTRAINT wallets_type_check ON bot.wallets IS 'account_type is wallet';
COMMENT ON CONSTRAINT wallets_address_check ON bot.wallets IS 'public_address is not empty';
COMMENT ON CONSTRAINT wallets_native_balance_check ON bot.wallets IS 'native_balance is not negative';
COMMENT ON CONSTRAINT wallets_account_fkey ON bot.wallets IS
  'account_id must be a bot.accounts row whose account_type is wallet';
COMMENT ON CONSTRAINT wallets_chain_address_key ON bot.wallets IS
  'One wallet row per chain and address';

CREATE TABLE IF NOT EXISTS bot.exchange_accounts (
  account_id    UUID PRIMARY KEY,
  account_type  exchange.account_type NOT NULL DEFAULT 'exchange',
  exchange_id   TEXT NOT NULL,
  CONSTRAINT exchange_accounts_type_check CHECK (account_type = 'exchange'),
  CONSTRAINT exchange_accounts_account_fkey
    FOREIGN KEY (account_id, account_type) REFERENCES bot.accounts (id, account_type) ON DELETE CASCADE,
  CONSTRAINT exchange_accounts_exchange_fkey
    FOREIGN KEY (exchange_id, account_type) REFERENCES exchange.integrations (id, account_type)
);
COMMENT ON TABLE bot.exchange_accounts IS 'Venue-login subtype of bot.accounts';
COMMENT ON COLUMN bot.exchange_accounts.account_id IS 'bot.accounts id';
COMMENT ON COLUMN bot.exchange_accounts.account_type IS
  'Always exchange, so this row cannot point at a wallet account or a wallet integration';
COMMENT ON COLUMN bot.exchange_accounts.exchange_id IS 'exchange.integrations id whose account_type is exchange';
COMMENT ON CONSTRAINT exchange_accounts_type_check ON bot.exchange_accounts IS 'account_type is exchange';
COMMENT ON CONSTRAINT exchange_accounts_account_fkey ON bot.exchange_accounts IS
  'account_id must be a bot.accounts row whose account_type is exchange';
COMMENT ON CONSTRAINT exchange_accounts_exchange_fkey ON bot.exchange_accounts IS
  'exchange_id must be an integration whose account_type is exchange';

-- One instance per open registry id and pair. Cash on bot.portfolios is the whole
-- wallet, so it is not copied. No bot.strategies deposit is invented.
INSERT INTO strategy.instances (registry_id, pair, candle_source, exchange_id, risk_percent, params)
SELECT DISTINCT strategy_id, pair, 'gecko-terminal'::market.candle_source, 'jupiter', 2, '{}'::jsonb
FROM bot.positions;

INSERT INTO exchange.positions (bot_id, mode, integration_id, pair, side, size)
SELECT
  bot_id,
  mode,
  CASE WHEN mode = 'paper' THEN 'emulated' ELSE 'jupiter' END,
  pair,
  side,
  size
FROM bot.positions;

ALTER TABLE bot.positions ADD COLUMN instance_id UUID;
ALTER TABLE bot.positions ADD COLUMN exchange_position_id UUID;

UPDATE bot.positions AS p
SET
  instance_id = i.id,
  exchange_position_id = e.id
FROM strategy.instances AS i, exchange.positions AS e
WHERE i.registry_id = p.strategy_id
  AND i.pair = p.pair
  AND e.bot_id = p.bot_id
  AND e.mode = p.mode
  AND e.pair = p.pair;

ALTER TABLE bot.positions DROP CONSTRAINT positions_pkey;
ALTER TABLE bot.positions DROP CONSTRAINT positions_strategy_id_fkey;
ALTER TABLE bot.positions DROP COLUMN strategy_id;
ALTER TABLE bot.positions DROP COLUMN strategy_data;
ALTER TABLE bot.positions RENAME COLUMN instance_id TO strategy_id;
ALTER TABLE bot.positions ALTER COLUMN strategy_id SET NOT NULL;
ALTER TABLE bot.positions ALTER COLUMN exchange_position_id SET NOT NULL;
ALTER TABLE bot.positions ADD PRIMARY KEY (bot_id, mode, strategy_id);
ALTER TABLE bot.positions
  ADD CONSTRAINT positions_strategy_id_fkey
  FOREIGN KEY (strategy_id) REFERENCES strategy.instances (id) ON DELETE RESTRICT;
ALTER TABLE bot.positions
  ADD CONSTRAINT positions_exchange_position_id_fkey
  FOREIGN KEY (exchange_position_id) REFERENCES exchange.positions (id) ON DELETE RESTRICT;

COMMENT ON TABLE bot.positions IS 'Open virtual position for one strategy instance';
COMMENT ON COLUMN bot.positions.strategy_id IS 'strategy.instances id that owns this position';
COMMENT ON COLUMN bot.positions.pair IS 'Copy of the instance pair';
COMMENT ON COLUMN bot.positions.exchange_position_id IS 'Venue position this book is netted into';
COMMENT ON CONSTRAINT positions_pkey ON bot.positions IS
  'One open position per bot, mode, and strategy instance';
COMMENT ON CONSTRAINT positions_strategy_id_fkey ON bot.positions IS
  'strategy_id must exist in strategy.instances';
COMMENT ON CONSTRAINT positions_exchange_position_id_fkey ON bot.positions IS
  'Every bot position links to an exchange position';

ALTER TABLE bot.trades
  ADD COLUMN strategy_id UUID REFERENCES strategy.instances (id) ON DELETE SET NULL;
COMMENT ON COLUMN bot.trades.strategy_id IS
  'strategy.instances id. Null on fills written before instances existed';

ALTER TABLE market.signals
  ADD COLUMN strategy_id UUID REFERENCES strategy.instances (id) ON DELETE SET NULL;
COMMENT ON COLUMN market.signals.strategy_id IS
  'strategy.instances id. Null on signals written before instances existed';

DROP INDEX IF EXISTS market.signals_bot_pair_at_uidx;
CREATE UNIQUE INDEX IF NOT EXISTS signals_bot_strategy_at_uidx
  ON market.signals (bot_id, strategy_id, "at");
COMMENT ON INDEX market.signals_bot_strategy_at_uidx IS
  'One signal per bot, strategy instance, and timestamp';

DROP TABLE bot.portfolios;

-- migrate:down

CREATE TABLE IF NOT EXISTS bot.portfolios (
  bot_id         TEXT        NOT NULL,
  mode           bot.mode    NOT NULL,
  pair           TEXT        NOT NULL,
  cash_usdc      DOUBLE PRECISION NOT NULL,
  realized_pnl   DOUBLE PRECISION NOT NULL,
  position_side  TEXT        NOT NULL,
  position_size  DOUBLE PRECISION NOT NULL,
  entry_price    DOUBLE PRECISION NOT NULL,
  opened_at      TIMESTAMPTZ,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, mode, pair)
);

DROP INDEX IF EXISTS market.signals_bot_strategy_at_uidx;
ALTER TABLE market.signals DROP COLUMN IF EXISTS strategy_id;
CREATE UNIQUE INDEX IF NOT EXISTS signals_bot_pair_at_uidx
  ON market.signals (bot_id, pair, "at");

ALTER TABLE bot.trades DROP COLUMN IF EXISTS strategy_id;

ALTER TABLE bot.positions ADD COLUMN registry_id TEXT;
ALTER TABLE bot.positions ADD COLUMN strategy_data JSONB NOT NULL DEFAULT '{}';
UPDATE bot.positions AS p
SET registry_id = i.registry_id
FROM strategy.instances AS i
WHERE i.id = p.strategy_id;

ALTER TABLE bot.positions DROP CONSTRAINT IF EXISTS positions_pkey;
ALTER TABLE bot.positions DROP CONSTRAINT IF EXISTS positions_strategy_id_fkey;
ALTER TABLE bot.positions DROP CONSTRAINT IF EXISTS positions_exchange_position_id_fkey;
ALTER TABLE bot.positions DROP COLUMN strategy_id;
ALTER TABLE bot.positions DROP COLUMN exchange_position_id;
ALTER TABLE bot.positions RENAME COLUMN registry_id TO strategy_id;
ALTER TABLE bot.positions ALTER COLUMN strategy_id SET NOT NULL;
ALTER TABLE bot.positions ADD PRIMARY KEY (bot_id, mode, pair);
ALTER TABLE bot.positions
  ADD CONSTRAINT positions_strategy_id_fkey
  FOREIGN KEY (strategy_id) REFERENCES strategy.registry (id);

DROP TABLE IF EXISTS bot.wallets;
DROP TABLE IF EXISTS bot.exchange_accounts;
DROP TABLE IF EXISTS bot.accounts;
DROP TABLE IF EXISTS bot.virtual_accounts;
DROP TABLE IF EXISTS bot.selection;
DROP TABLE IF EXISTS bot.strategies;
DROP TABLE IF EXISTS exchange.positions;
DROP TABLE IF EXISTS strategy.instances;
DROP TABLE IF EXISTS exchange.integrations;
DROP TYPE IF EXISTS exchange.account_type;
DROP SCHEMA IF EXISTS exchange;
DROP TYPE IF EXISTS market.chain;
