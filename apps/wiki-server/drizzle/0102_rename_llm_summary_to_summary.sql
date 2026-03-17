-- Rename llm_summary column to summary.
-- The old name "llmSummary" implied LLM-only consumption, but this field
-- is shown to human readers in page previews, tooltips, and PageStatus.
ALTER TABLE wiki_pages RENAME COLUMN llm_summary TO summary;
