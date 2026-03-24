-- Bluesky data source: tracked accounts and their posts
-- Used to surface social media activity from AI safety researchers and orgs.

CREATE TABLE IF NOT EXISTS bluesky_accounts (
    did TEXT PRIMARY KEY,
    handle TEXT NOT NULL,
    display_name TEXT,
    description TEXT,
    follower_count INTEGER,
    post_count INTEGER,
    entity_stable_id TEXT REFERENCES entities(stable_id) ON DELETE SET NULL,
    relevance_tags JSONB,
    last_fetched_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ba_handle ON bluesky_accounts(handle);
CREATE INDEX IF NOT EXISTS idx_ba_entity ON bluesky_accounts(entity_stable_id);

CREATE TABLE IF NOT EXISTS bluesky_posts (
    uri TEXT PRIMARY KEY,
    cid TEXT,
    account_did TEXT NOT NULL REFERENCES bluesky_accounts(did) ON DELETE CASCADE,
    text TEXT,
    posted_at TIMESTAMPTZ NOT NULL,
    like_count INTEGER,
    repost_count INTEGER,
    reply_count INTEGER,
    quote_count INTEGER,
    embedded_url TEXT,
    embedded_title TEXT,
    reply_to_uri TEXT,
    resource_id TEXT REFERENCES resources(id) ON DELETE SET NULL,
    entity_stable_ids JSONB,
    fetched_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_bp_account_did ON bluesky_posts(account_did);
CREATE INDEX IF NOT EXISTS idx_bp_posted_at ON bluesky_posts(posted_at);
CREATE INDEX IF NOT EXISTS idx_bp_embedded_url ON bluesky_posts(embedded_url);
CREATE INDEX IF NOT EXISTS idx_bp_resource_id ON bluesky_posts(resource_id);
