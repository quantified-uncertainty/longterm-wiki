DROP INDEX IF EXISTS "idx_cc_page_id";
ALTER TABLE "citation_content" DROP COLUMN IF EXISTS "page_id";
ALTER TABLE "citation_content" DROP COLUMN IF EXISTS "footnote";
