-- Privileges for role speculator on database speculator. Does not change owners.
-- Run as the object owner after schema migrations that add/drop schemas, tables,
-- sequences, or types:
--   psql postgres://OWNER@host:5432/speculator?sslmode=require -f scripts/grant-privileges.sql
--
--   public, solana : SELECT
--   market         : SELECT, INSERT, UPDATE (candles); SELECT, INSERT (signals + seq); USAGE on chain
--   strategy       : SELECT on registry; SELECT, INSERT, UPDATE, DELETE on instances
--   exchange       : USAGE on account_type; SELECT on integrations; SELECT, INSERT, UPDATE, DELETE on positions
--   bot            : SELECT, INSERT, UPDATE, DELETE (+ trades seq)

REVOKE ALL ON DATABASE speculator FROM speculator;
GRANT CONNECT ON DATABASE speculator TO speculator;

REVOKE ALL ON SCHEMA public FROM speculator;
GRANT USAGE ON SCHEMA public TO speculator;
REVOKE ALL ON TABLE schema_migrations FROM speculator;
GRANT SELECT ON TABLE schema_migrations TO speculator;

REVOKE ALL ON SCHEMA solana FROM speculator;
GRANT USAGE ON SCHEMA solana TO speculator;
REVOKE ALL ON TABLE solana.tokens FROM speculator;
GRANT SELECT ON TABLE solana.tokens TO speculator;
REVOKE ALL ON TABLE solana.pools FROM speculator;
GRANT SELECT ON TABLE solana.pools TO speculator;

REVOKE ALL ON SCHEMA market FROM speculator;
GRANT USAGE ON SCHEMA market TO speculator;
GRANT USAGE ON TYPE market.timeframe TO speculator;
GRANT USAGE ON TYPE market.candle_source TO speculator;
GRANT USAGE ON TYPE market.chain TO speculator;
REVOKE ALL ON TABLE market.candles FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE market.candles TO speculator;
REVOKE ALL ON TABLE market.signals FROM speculator;
GRANT SELECT, INSERT ON TABLE market.signals TO speculator;
REVOKE ALL ON SEQUENCE market.signals_id_seq FROM speculator;
GRANT USAGE, SELECT ON SEQUENCE market.signals_id_seq TO speculator;

REVOKE ALL ON SCHEMA strategy FROM speculator;
GRANT USAGE ON SCHEMA strategy TO speculator;
REVOKE ALL ON TABLE strategy.registry FROM speculator;
GRANT SELECT ON TABLE strategy.registry TO speculator;
REVOKE ALL ON TABLE strategy.instances FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE strategy.instances TO speculator;

REVOKE ALL ON SCHEMA exchange FROM speculator;
GRANT USAGE ON SCHEMA exchange TO speculator;
GRANT USAGE ON TYPE exchange.account_type TO speculator;
REVOKE ALL ON TABLE exchange.integrations FROM speculator;
GRANT SELECT ON TABLE exchange.integrations TO speculator;
REVOKE ALL ON TABLE exchange.positions FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE exchange.positions TO speculator;

REVOKE ALL ON SCHEMA bot FROM speculator;
GRANT USAGE ON SCHEMA bot TO speculator;
GRANT USAGE ON TYPE bot.mode TO speculator;
REVOKE ALL ON TABLE bot.strategies FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.strategies TO speculator;
REVOKE ALL ON TABLE bot.selection FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.selection TO speculator;
REVOKE ALL ON TABLE bot.virtual_accounts FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.virtual_accounts TO speculator;
REVOKE ALL ON TABLE bot.accounts FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.accounts TO speculator;
REVOKE ALL ON TABLE bot.wallets FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.wallets TO speculator;
REVOKE ALL ON TABLE bot.exchange_accounts FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.exchange_accounts TO speculator;
REVOKE ALL ON TABLE bot.positions FROM speculator;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bot.positions TO speculator;
REVOKE ALL ON TABLE bot.trades FROM speculator;
GRANT SELECT, INSERT, UPDATE ON TABLE bot.trades TO speculator;
REVOKE ALL ON SEQUENCE bot.trades_id_seq FROM speculator;
GRANT USAGE, SELECT ON SEQUENCE bot.trades_id_seq TO speculator;

ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA market GRANT SELECT, INSERT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA strategy GRANT SELECT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA exchange GRANT SELECT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA bot GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO speculator;
