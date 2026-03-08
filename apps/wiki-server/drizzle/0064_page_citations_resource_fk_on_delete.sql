-- Fix page_citations.resource_id FK to use ON DELETE SET NULL
-- (consistent with statement_citations.resource_id and claim_citations.resource_id)
ALTER TABLE page_citations
  DROP CONSTRAINT IF EXISTS page_citations_resource_id_resources_id_fk;

ALTER TABLE page_citations
  ADD CONSTRAINT page_citations_resource_id_resources_id_fk
  FOREIGN KEY (resource_id) REFERENCES resources(id) ON DELETE SET NULL;
