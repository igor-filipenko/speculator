-- Privileges for role speculator on database speculator. Does not change owners.
-- Run as the object owner:
--   psql postgres://OWNER@host:5432/speculator?sslmode=require -f scripts/grant-privileges.sql
--
--   public, solana : SELECT
--   market         : SELECT, INSERT
--   bot            : SELECT, INSERT, UPDATE

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
REVOKE ALL ON TABLE market.candles FROM speculator;
GRANT SELECT, INSERT ON TABLE market.candles TO speculator;
REVOKE ALL ON TABLE market.signals FROM speculator;
GRANT SELECT, INSERT ON TABLE market.signals TO speculator;
REVOKE ALL ON SEQUENCE market.signals_id_seq FROM speculator;
GRANT USAGE, SELECT ON SEQUENCE market.signals_id_seq TO speculator;

REVOKE ALL ON SCHEMA bot FROM speculator;
GRANT USAGE ON SCHEMA bot TO speculator;
GRANT USAGE ON TYPE bot.mode TO speculator;
REVOKE ALL ON TABLE bot.portfolios FROM speculator;
GRANT SELECT, INSERT, UPDATE ON TABLE bot.portfolios TO speculator;
REVOKE ALL ON TABLE bot.trades FROM speculator;
GRANT SELECT, INSERT, UPDATE ON TABLE bot.trades TO speculator;
REVOKE ALL ON SEQUENCE bot.trades_id_seq FROM speculator;
GRANT USAGE, SELECT ON SEQUENCE bot.trades_id_seq TO speculator;

ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA market GRANT SELECT, INSERT ON TABLES TO speculator;
ALTER DEFAULT PRIVILEGES IN SCHEMA bot GRANT SELECT, INSERT, UPDATE ON TABLES TO speculator;
