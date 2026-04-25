/**
 * Shared evaluator → ingester dispatch (QUA-705).
 *
 * Used by both `crux tb third-party-evals ingest` and `crux tb third-party-evals
 * backfill`. Adding a 5th evaluator requires touching one place.
 */
import { ingestUkAisi } from "./uk-aisi-sitemap.ts";
import { ingestMetr } from "./metr-rss.ts";
import { ingestApollo } from "./apollo-research.ts";
import { ingestCaisi } from "./caisi-blog.ts";
import type { IngestResult } from "./types.ts";

export const VALID_EVALUATORS = [
  "uk-aisi",
  "us-aisi",
  "metr",
  "apollo",
] as const;

export type EvaluatorKey = (typeof VALID_EVALUATORS)[number];

export interface DispatchOptions {
  since?: string;
}

export async function dispatchIngest(
  evaluator: string,
  options: DispatchOptions = {},
): Promise<IngestResult> {
  const key = evaluator.trim().toLowerCase();
  if (key === "uk-aisi" || key === "ukaisi") {
    return ingestUkAisi({ sinceDate: options.since });
  }
  if (key === "us-aisi" || key === "caisi" || key === "usaisi") {
    return ingestCaisi();
  }
  if (key === "metr") return ingestMetr();
  if (key === "apollo" || key === "apollo-research") return ingestApollo();
  throw new Error(
    `Unknown evaluator '${evaluator}'. Valid: ${VALID_EVALUATORS.join(", ")}`,
  );
}
