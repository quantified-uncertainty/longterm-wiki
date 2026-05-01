/**
 * Standalone schema for policy-stakeholders sync.
 *
 * Extracted from the route file (QUA-964) so the gate validator
 * (`crux/validate/validate-policy-stakeholders-strict.ts`) can import
 * the canonical Zod schema without pulling in Hono / drizzle / db
 * transitive dependencies.
 *
 * Anything strict the route enforces at sync time MUST live here so YAML
 * gets the same enforcement at PR time. Keeping the schema source-of-truth
 * here avoids drift between "what the route accepts" and "what the gate
 * blocks at PR review".
 */

import { z } from "zod";
import { InlineSourcingSchema } from "./sourcing-schema.js";

export const VALID_POSITIONS = ["support", "oppose", "neutral", "mixed"] as const;
export const VALID_IMPORTANCE = ["high", "medium", "low"] as const;

export const SyncStakeholderItemSchema = z.object({
  id: z.string().length(10),
  policyEntityId: z.string().min(1).max(200),
  stakeholderEntityId: z.string().max(200).nullable().optional(),
  stakeholderDisplayName: z.string().min(1).max(500),
  position: z.enum(VALID_POSITIONS),
  importance: z.enum(VALID_IMPORTANCE).nullable().optional(),
  reason: z.string().max(5000).nullable().optional(),
  source: z.string().max(2000).nullable().optional(),
  context: z.array(z.string()).nullable().optional(),
  sourcing: InlineSourcingSchema.optional(),
});

export type SyncStakeholderItem = z.infer<typeof SyncStakeholderItemSchema>;
