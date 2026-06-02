-- Run this in Supabase → SQL Editor → New Query → Run
-- Safe to run multiple times (uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS trades (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  symbol TEXT,
  side TEXT,
  qty TEXT,
  order_type TEXT,
  limit_price TEXT,
  stop_loss_price TEXT,
  take_profit_price TEXT,
  rationale TEXT,
  order_id TEXT,
  status TEXT,
  pnl FLOAT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  tool TEXT,
  symbol TEXT,
  blocked BOOLEAN DEFAULT FALSE,
  result TEXT
);

CREATE TABLE IF NOT EXISTS nav_history (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  equity FLOAT,
  cash FLOAT,
  day_pnl FLOAT
);

CREATE TABLE IF NOT EXISTS halt_events (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ DEFAULT NOW(),
  halted BOOLEAN
);

ALTER TABLE trades ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE nav_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE halt_events ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "public read trades" ON trades FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "public read audit" ON audit_log FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "public read nav" ON nav_history FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "public read halt" ON halt_events FOR SELECT USING (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon insert trades" ON trades FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon insert audit" ON audit_log FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon insert nav" ON nav_history FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY "anon insert halt" ON halt_events FOR INSERT WITH CHECK (true);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
