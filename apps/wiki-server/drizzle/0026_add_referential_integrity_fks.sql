-- Add referential integrity FK constraints across the database.
-- Uses defensive IF NOT EXISTS blocks (same pattern as 0008/0009).

-- ============================================================
-- entity_id → entities.id (CASCADE)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'facts_entity_id_entities_id_fk'
      AND table_name = 'facts'
  ) THEN
    ALTER TABLE "facts" ADD CONSTRAINT "facts_entity_id_entities_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'claims_entity_id_entities_id_fk'
      AND table_name = 'claims'
  ) THEN
    ALTER TABLE "claims" ADD CONSTRAINT "claims_entity_id_entities_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'summaries_entity_id_entities_id_fk'
      AND table_name = 'summaries'
  ) THEN
    ALTER TABLE "summaries" ADD CONSTRAINT "summaries_entity_id_entities_id_fk"
    FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ============================================================
-- subject → entities.id (SET NULL)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'facts_subject_entities_id_fk'
      AND table_name = 'facts'
  ) THEN
    ALTER TABLE "facts" ADD CONSTRAINT "facts_subject_entities_id_fk"
    FOREIGN KEY ("subject") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ============================================================
-- source_resource → resources.id (SET NULL)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'facts_source_resource_resources_id_fk'
      AND table_name = 'facts'
  ) THEN
    ALTER TABLE "facts" ADD CONSTRAINT "facts_source_resource_resources_id_fk"
    FOREIGN KEY ("source_resource") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ============================================================
-- page_id → wiki_pages.id (CASCADE)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'citation_quotes_page_id_wiki_pages_id_fk'
      AND table_name = 'citation_quotes'
  ) THEN
    ALTER TABLE "citation_quotes" ADD CONSTRAINT "citation_quotes_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'citation_accuracy_snapshots_page_id_wiki_pages_id_fk'
      AND table_name = 'citation_accuracy_snapshots'
  ) THEN
    ALTER TABLE "citation_accuracy_snapshots" ADD CONSTRAINT "citation_accuracy_snapshots_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'edit_logs_page_id_wiki_pages_id_fk'
      AND table_name = 'edit_logs'
  ) THEN
    ALTER TABLE "edit_logs" ADD CONSTRAINT "edit_logs_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'hallucination_risk_snapshots_page_id_wiki_pages_id_fk'
      AND table_name = 'hallucination_risk_snapshots'
  ) THEN
    ALTER TABLE "hallucination_risk_snapshots" ADD CONSTRAINT "hallucination_risk_snapshots_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'session_pages_page_id_wiki_pages_id_fk'
      AND table_name = 'session_pages'
  ) THEN
    ALTER TABLE "session_pages" ADD CONSTRAINT "session_pages_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'auto_update_results_page_id_wiki_pages_id_fk'
      AND table_name = 'auto_update_results'
  ) THEN
    ALTER TABLE "auto_update_results" ADD CONSTRAINT "auto_update_results_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'resource_citations_page_id_wiki_pages_id_fk'
      AND table_name = 'resource_citations'
  ) THEN
    ALTER TABLE "resource_citations" ADD CONSTRAINT "resource_citations_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'page_improve_runs_page_id_wiki_pages_id_fk'
      AND table_name = 'page_improve_runs'
  ) THEN
    ALTER TABLE "page_improve_runs" ADD CONSTRAINT "page_improve_runs_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE cascade ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ============================================================
-- resource_id → resources.id (SET NULL)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'citation_quotes_resource_id_resources_id_fk'
      AND table_name = 'citation_quotes'
  ) THEN
    ALTER TABLE "citation_quotes" ADD CONSTRAINT "citation_quotes_resource_id_resources_id_fk"
    FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- ============================================================
-- routed_to_page_id → wiki_pages.id (SET NULL)
-- ============================================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'auto_update_news_items_routed_to_page_id_wiki_pages_id_fk'
      AND table_name = 'auto_update_news_items'
  ) THEN
    ALTER TABLE "auto_update_news_items" ADD CONSTRAINT "auto_update_news_items_routed_to_page_id_wiki_pages_id_fk"
    FOREIGN KEY ("routed_to_page_id") REFERENCES "public"."wiki_pages"("id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;
