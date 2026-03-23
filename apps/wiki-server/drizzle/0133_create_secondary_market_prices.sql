-- Secondary market prices: tracks private company valuations across platforms over time
CREATE TABLE IF NOT EXISTS secondary_market_prices (
    id VARCHAR(10) PRIMARY KEY,
    company_id TEXT NOT NULL,
    company_entity_id TEXT REFERENCES entities(stable_id) ON DELETE SET NULL,
    company_display_name TEXT,
    platform TEXT NOT NULL,
    date TEXT NOT NULL,
    price_per_share NUMERIC,
    implied_valuation NUMERIC,
    implied_valuation_low NUMERIC,
    implied_valuation_high NUMERIC,
    volume NUMERIC,
    open_interest NUMERIC,
    bid_price NUMERIC,
    ask_price NUMERIC,
    spread_percent NUMERIC,
    price_type TEXT NOT NULL DEFAULT 'last_trade',
    source TEXT,
    notes TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_smp_company ON secondary_market_prices(company_id);
CREATE INDEX IF NOT EXISTS idx_smp_company_entity ON secondary_market_prices(company_entity_id);
CREATE INDEX IF NOT EXISTS idx_smp_platform ON secondary_market_prices(platform);
CREATE INDEX IF NOT EXISTS idx_smp_date ON secondary_market_prices(date);
CREATE INDEX IF NOT EXISTS idx_smp_company_date ON secondary_market_prices(company_entity_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_smp_unique ON secondary_market_prices(company_id, platform, date, price_type);
