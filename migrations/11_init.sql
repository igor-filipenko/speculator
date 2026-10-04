-- migrate:up

CREATE SCHEMA IF NOT EXISTS strategy;
COMMENT ON SCHEMA strategy IS 'Strategies and their parameters';

DO $$ BEGIN
  CREATE TYPE strategy.type AS ENUM ('mean-reversion', 'trend-following', 'momentum', 'arbitrage');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
COMMENT ON TYPE strategy.type IS 'Strategy type';

CREATE TABLE IF NOT EXISTS strategy.registry (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type strategy.type NOT NULL
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

-- migrate:down

DROP SCHEMA IF EXISTS strategy CASCADE;
