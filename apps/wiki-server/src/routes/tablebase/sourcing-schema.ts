import { z } from "zod";

/** Verdict enum shared between row-level and field-level verdicts. */
export const VerdictEnum = z.enum([
  "confirmed",
  "contradicted",
  "outdated",
  "partial",
  "unverifiable",
]);

/** Per-field verdict (e.g., for "amount", "start_date", "grantee_id"). */
export const FieldVerdictSchema = z.object({
  verdict: VerdictEnum,
  confidence: z.number().min(0).max(1).optional(),
});

export type FieldVerdict = z.infer<typeof FieldVerdictSchema>;

/**
 * Optional source-check data that can be submitted alongside any TableBase record.
 * When present, a source_check_verdict is written atomically with the record.
 */
export const InlineSourcingSchema = z.object({
  verdict: VerdictEnum,
  evidence: z.string().max(5000).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceContentHash: z.string().max(100).optional(),
  checkedAt: z.string().datetime().optional(),
  checkedBy: z.string().max(100).optional(),
  /**
   * Per-field verdicts keyed by snake_case column name (e.g., "amount", "start_date").
   * When present, additional source_check_verdicts rows are written with field_name set.
   * The row-level verdict (field_name = NULL) is always written regardless.
   */
  fieldVerdicts: z
    .record(
      z.string().regex(/^[a-z_][a-z0-9_]*$/).max(63),
      FieldVerdictSchema,
    )
    .optional(),
});

export type InlineSourcing = z.infer<typeof InlineSourcingSchema>;
