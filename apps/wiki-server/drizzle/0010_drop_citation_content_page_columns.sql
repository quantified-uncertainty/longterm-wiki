-- Migration 0010: Drop page_id and footnote from citation_content
--
-- citation_content is a URL content cache. The page_id/footnote columns
-- caused a data-loss bug: when two pages cited the same URL, the last
-- writer overwrote the previous page's context. The page/footnote
-- relationship is already tracked in citation_quotes.
--
-- See: https://github.com/quantified-uncertainty/longterm-wiki/issues/454

DROP INDEX IF EXISTS "idx_cc_page_id";--> statement-breakpoint
ALTER TABLE "citation_content" DROP COLUMN IF EXISTS "page_id";--> statement-breakpoint
ALTER TABLE "citation_content" DROP COLUMN IF EXISTS "footnote";
