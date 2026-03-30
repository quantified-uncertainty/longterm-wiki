-- Delete stale facts with value "[object Object]"
--
-- Root cause: Before the March 1 2026 fix (f892d3d3e), the old data/facts/*.yaml
-- sync system called String({min: N}) on min-bound values, storing the literal
-- string "[object Object]" in the facts.value column with format = NULL.
--
-- Migration 0147 (sid_ prefix) made these visible to the frontend by giving them
-- the same entity_id as new KB facts. When getFactBaseLatest tie-breaks on
-- fact_id order, old IDs (e.g. "78c51cfd") sort before new ("f_..."), so the
-- stale "[object Object]" value is returned and rendered in stat cards.
--
-- Affected entities: anthropic (total-funding), openai (valuation),
-- coefficient-giving (total-funding), and potentially others.
--
-- Idempotent: WHERE clause only matches the specific artifact string.

DELETE FROM facts WHERE value = '[object Object]';
