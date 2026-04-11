import { z } from "zod";

/**
 * Optional sourcing data that can be submitted alongside any TableBase record.
 * When present, a sourcing_verdict is written atomically with the record.
 */
export const InlineSourcingSchema = z.object({
  verdict: z.enum([
    "confirmed",
    "contradicted",
    "outdated",
    "partial",
    "unverifiable",
  ]),
  evidence: z.string().max(5000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceContentHash: z.string().max(100).optional(),
  checkedAt: z.string().datetime().optional(),
  checkedBy: z.string().max(100).optional(),
});

export type InlineSourcing = z.infer<typeof InlineSourcingSchema>;
