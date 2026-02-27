-- Add isPinned boolean to claims table.
-- A pinned claim is the canonical value for display in <F> components.
-- Only one claim should be pinned per entity+property+asOf triple.
ALTER TABLE "claims" ADD COLUMN "is_pinned" boolean NOT NULL DEFAULT false;

-- Index for quickly finding pinned claims by entity
CREATE INDEX "idx_cl_is_pinned" ON "claims" ("is_pinned") WHERE "is_pinned" = true;

-- Composite index for looking up the canonical value for a given entity+property
CREATE INDEX "idx_cl_pinned_lookup" ON "claims" ("subject_entity", "property") WHERE "is_pinned" = true;
