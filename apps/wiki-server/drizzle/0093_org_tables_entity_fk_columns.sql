-- Add real FK columns to org-related tables (personnel, grants, investments,
-- funding_rounds, equity_positions).
--
-- Pattern: for each text column that currently stores an entity ID or display
-- name, add a nullable FK column referencing entities.stable_id plus a
-- display_name fallback column. The original text columns are kept temporarily
-- for migration compatibility.
--
-- These tables are small (60-200 rows), so direct ALTER is fine.

-- ============================================================
-- personnel: person_entity_id, person_display_name,
--            org_entity_id, org_display_name
-- ============================================================

ALTER TABLE "personnel"
  ADD COLUMN IF NOT EXISTS "person_entity_id" text,
  ADD COLUMN IF NOT EXISTS "person_display_name" text,
  ADD COLUMN IF NOT EXISTS "org_entity_id" text,
  ADD COLUMN IF NOT EXISTS "org_display_name" text;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'personnel_person_entity_id_entities_stable_id_fk'
      AND table_name = 'personnel'
  ) THEN
    ALTER TABLE "personnel" ADD CONSTRAINT "personnel_person_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("person_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'personnel_org_entity_id_entities_stable_id_fk'
      AND table_name = 'personnel'
  ) THEN
    ALTER TABLE "personnel" ADD CONSTRAINT "personnel_org_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("org_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

-- Backfill: copy existing entity IDs into the new FK columns where they
-- match a valid entity stable_id. Non-matching values go into display_name.
UPDATE personnel p SET
  person_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = p.person_id) THEN p.person_id ELSE NULL END,
  person_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = p.person_id) THEN p.person_id ELSE NULL END,
  org_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = p.organization_id) THEN p.organization_id ELSE NULL END,
  org_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = p.organization_id) THEN p.organization_id ELSE NULL END
WHERE p.person_entity_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_personnel_person_entity" ON "personnel" ("person_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_personnel_org_entity" ON "personnel" ("org_entity_id");--> statement-breakpoint

-- ============================================================
-- grants: org_entity_id, org_display_name,
--         grantee_entity_id, grantee_display_name
-- ============================================================

ALTER TABLE "grants"
  ADD COLUMN IF NOT EXISTS "org_entity_id" text,
  ADD COLUMN IF NOT EXISTS "org_display_name" text,
  ADD COLUMN IF NOT EXISTS "grantee_entity_id" text,
  ADD COLUMN IF NOT EXISTS "grantee_display_name" text;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'grants_org_entity_id_entities_stable_id_fk'
      AND table_name = 'grants'
  ) THEN
    ALTER TABLE "grants" ADD CONSTRAINT "grants_org_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("org_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'grants_grantee_entity_id_entities_stable_id_fk'
      AND table_name = 'grants'
  ) THEN
    ALTER TABLE "grants" ADD CONSTRAINT "grants_grantee_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("grantee_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

UPDATE grants g SET
  org_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = g.organization_id) THEN g.organization_id ELSE NULL END,
  org_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = g.organization_id) THEN g.organization_id ELSE NULL END,
  grantee_entity_id = CASE WHEN g.grantee_id IS NOT NULL AND EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = g.grantee_id) THEN g.grantee_id ELSE NULL END,
  grantee_display_name = CASE WHEN g.grantee_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = g.grantee_id) THEN g.grantee_id ELSE NULL END
WHERE g.org_entity_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_grants_org_entity" ON "grants" ("org_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_grants_grantee_entity" ON "grants" ("grantee_entity_id");--> statement-breakpoint

-- ============================================================
-- funding_rounds: company_entity_id, company_display_name,
--                 lead_investor_entity_id, lead_investor_display_name
-- ============================================================

ALTER TABLE "funding_rounds"
  ADD COLUMN IF NOT EXISTS "company_entity_id" text,
  ADD COLUMN IF NOT EXISTS "company_display_name" text,
  ADD COLUMN IF NOT EXISTS "lead_investor_entity_id" text,
  ADD COLUMN IF NOT EXISTS "lead_investor_display_name" text;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'funding_rounds_company_entity_id_entities_stable_id_fk'
      AND table_name = 'funding_rounds'
  ) THEN
    ALTER TABLE "funding_rounds" ADD CONSTRAINT "funding_rounds_company_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("company_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'funding_rounds_lead_investor_entity_id_entities_stable_id_fk'
      AND table_name = 'funding_rounds'
  ) THEN
    ALTER TABLE "funding_rounds" ADD CONSTRAINT "funding_rounds_lead_investor_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("lead_investor_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

UPDATE funding_rounds fr SET
  company_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = fr.company_id) THEN fr.company_id ELSE NULL END,
  company_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = fr.company_id) THEN fr.company_id ELSE NULL END,
  lead_investor_entity_id = CASE WHEN fr.lead_investor IS NOT NULL AND EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = fr.lead_investor) THEN fr.lead_investor ELSE NULL END,
  lead_investor_display_name = CASE WHEN fr.lead_investor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = fr.lead_investor) THEN fr.lead_investor ELSE NULL END
WHERE fr.company_entity_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_fr_company_entity" ON "funding_rounds" ("company_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_fr_lead_investor_entity" ON "funding_rounds" ("lead_investor_entity_id");--> statement-breakpoint

-- ============================================================
-- investments: company_entity_id, company_display_name,
--              investor_entity_id, investor_display_name
-- ============================================================

ALTER TABLE "investments"
  ADD COLUMN IF NOT EXISTS "company_entity_id" text,
  ADD COLUMN IF NOT EXISTS "company_display_name" text,
  ADD COLUMN IF NOT EXISTS "investor_entity_id" text,
  ADD COLUMN IF NOT EXISTS "investor_display_name" text;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'investments_company_entity_id_entities_stable_id_fk'
      AND table_name = 'investments'
  ) THEN
    ALTER TABLE "investments" ADD CONSTRAINT "investments_company_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("company_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'investments_investor_entity_id_entities_stable_id_fk'
      AND table_name = 'investments'
  ) THEN
    ALTER TABLE "investments" ADD CONSTRAINT "investments_investor_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("investor_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

UPDATE investments inv SET
  company_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = inv.company_id) THEN inv.company_id ELSE NULL END,
  company_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = inv.company_id) THEN inv.company_id ELSE NULL END,
  investor_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = inv.investor_id) THEN inv.investor_id ELSE NULL END,
  investor_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = inv.investor_id) THEN inv.investor_id ELSE NULL END
WHERE inv.company_entity_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_inv_company_entity" ON "investments" ("company_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_inv_investor_entity" ON "investments" ("investor_entity_id");--> statement-breakpoint

-- ============================================================
-- equity_positions: company_entity_id, company_display_name,
--                   holder_entity_id, holder_display_name
-- ============================================================

ALTER TABLE "equity_positions"
  ADD COLUMN IF NOT EXISTS "company_entity_id" text,
  ADD COLUMN IF NOT EXISTS "company_display_name" text,
  ADD COLUMN IF NOT EXISTS "holder_entity_id" text,
  ADD COLUMN IF NOT EXISTS "holder_display_name" text;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'equity_positions_company_entity_id_entities_stable_id_fk'
      AND table_name = 'equity_positions'
  ) THEN
    ALTER TABLE "equity_positions" ADD CONSTRAINT "equity_positions_company_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("company_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'equity_positions_holder_entity_id_entities_stable_id_fk'
      AND table_name = 'equity_positions'
  ) THEN
    ALTER TABLE "equity_positions" ADD CONSTRAINT "equity_positions_holder_entity_id_entities_stable_id_fk"
    FOREIGN KEY ("holder_entity_id") REFERENCES "public"."entities"("stable_id") ON DELETE set null ON UPDATE no action;
  END IF;
END $$;--> statement-breakpoint

UPDATE equity_positions ep SET
  company_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = ep.company_id) THEN ep.company_id ELSE NULL END,
  company_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = ep.company_id) THEN ep.company_id ELSE NULL END,
  holder_entity_id = CASE WHEN EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = ep.holder_id) THEN ep.holder_id ELSE NULL END,
  holder_display_name = CASE WHEN NOT EXISTS (SELECT 1 FROM entities e WHERE e.stable_id = ep.holder_id) THEN ep.holder_id ELSE NULL END
WHERE ep.company_entity_id IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_ep_company_entity" ON "equity_positions" ("company_entity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_ep_holder_entity" ON "equity_positions" ("holder_entity_id");
