-- Epic #4017 Phase B4: Tighten onDelete policy on critical FKs.
--
-- Four FKs changed from SET NULL to RESTRICT. When the parent row is deleted,
-- these child records lose essential meaning — silently nulling the FK hides
-- data corruption. RESTRICT forces the operator to explicitly handle the
-- children (reassign, archive, or delete) before deleting the parent.
--
-- Two FKs kept as SET NULL (citation_quotes.resourceId, pageCitations.resourceId)
-- because the child record (claim text, citation) is still meaningful without
-- the resource link.
--
-- NOTE: statements.propertyId and statements.valueEntityId were originally
-- planned for tightening, but the statements table was archived (renamed to
-- _archived_statements) in migration 0065. Those FKs are skipped here.
--
-- PostgreSQL doesn't support ALTER CONSTRAINT ... SET ... directly.
-- We must DROP the old constraint and ADD a new one.

-- ============================================================================
-- 1. personnel.personEntityId → entities.stable_id: SET NULL → RESTRICT
-- ============================================================================
-- Personnel record is a role assignment — meaningless without the person entity.
ALTER TABLE "personnel" DROP CONSTRAINT IF EXISTS "personnel_person_entity_id_entities_stable_id_fk";
ALTER TABLE "personnel"
  ADD CONSTRAINT "personnel_person_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("person_entity_id") REFERENCES "entities"("stable_id")
  ON DELETE RESTRICT;

-- ============================================================================
-- 2. personnel.orgEntityId → entities.stable_id: SET NULL → RESTRICT
-- ============================================================================
-- Personnel record links a person to an org — deleting the org should be blocked.
ALTER TABLE "personnel" DROP CONSTRAINT IF EXISTS "personnel_org_entity_id_entities_stable_id_fk";
ALTER TABLE "personnel"
  ADD CONSTRAINT "personnel_org_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("org_entity_id") REFERENCES "entities"("stable_id")
  ON DELETE RESTRICT;

-- ============================================================================
-- 3. grants.orgEntityId → entities.stable_id: SET NULL → RESTRICT
-- ============================================================================
-- Grants are permanent financial records — grantor org must not be silently removed.
ALTER TABLE "grants" DROP CONSTRAINT IF EXISTS "grants_org_entity_id_entities_stable_id_fk";
ALTER TABLE "grants"
  ADD CONSTRAINT "grants_org_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("org_entity_id") REFERENCES "entities"("stable_id")
  ON DELETE RESTRICT;

-- ============================================================================
-- 4. grants.granteeEntityId → entities.stable_id: SET NULL → RESTRICT
-- ============================================================================
-- Grant requires grantee identification — deletion should be blocked.
ALTER TABLE "grants" DROP CONSTRAINT IF EXISTS "grants_grantee_entity_id_entities_stable_id_fk";
ALTER TABLE "grants"
  ADD CONSTRAINT "grants_grantee_entity_id_entities_stable_id_fk"
  FOREIGN KEY ("grantee_entity_id") REFERENCES "entities"("stable_id")
  ON DELETE RESTRICT;
