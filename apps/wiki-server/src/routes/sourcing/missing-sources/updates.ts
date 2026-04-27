/**
 * update-source — write back a discovered URL to exactly one record.
 *
 * Lives outside the regular /sync endpoints because those validate the full
 * record shape (Zod min(1) on required fields) and use `excluded.*` on
 * conflict — both of which make partial updates impossible without data loss.
 * This handler touches exactly one column per table and nothing else.
 *
 * The set of writable tables is kept as an explicit dispatch (rather than
 * dynamic Drizzle building) so the types stay narrow and adding a new table
 * is a deliberate change.
 */

import { eq } from "drizzle-orm";
import {
  facts,
  personnel,
  investments,
  equityPositions,
  policyStakeholders,
  divisions,
  fundingRounds,
  fundingPrograms,
  publications,
  pageCitations,
} from "../../../schema.js";
import type { Db } from "./queries.js";

type UpdateFn = (db: Db, recordId: string, url: string) => Promise<number>;

export const UPDATE_TABLE_KEYS = [
  "facts",
  "personnel",
  "investments",
  "policy_stakeholders",
  "equity_positions",
  "divisions",
  "funding_rounds",
  "funding_programs",
  "publications",
  "page_citations",
] as const;

async function updateRows(
  fn: () => Promise<{ rowCount?: number } | unknown[]>,
): Promise<number> {
  const res = (await fn()) as { rowCount?: number | null } | unknown[];
  if (Array.isArray(res)) return res.length;
  return res.rowCount ?? 0;
}

export const UPDATE_BY_TABLE: Record<(typeof UPDATE_TABLE_KEYS)[number], UpdateFn> = {
  facts: (db, id, url) =>
    updateRows(() =>
      db
        .update(facts)
        .set({ source: url })
        .where(eq(facts.id, Number(id)))
        .returning({ id: facts.id }),
    ),
  personnel: (db, id, url) =>
    updateRows(() =>
      db
        .update(personnel)
        .set({ source: url })
        .where(eq(personnel.id, id))
        .returning({ id: personnel.id }),
    ),
  investments: (db, id, url) =>
    updateRows(() =>
      db
        .update(investments)
        .set({ source: url })
        .where(eq(investments.id, id))
        .returning({ id: investments.id }),
    ),
  policy_stakeholders: (db, id, url) =>
    updateRows(() =>
      db
        .update(policyStakeholders)
        .set({ source: url })
        .where(eq(policyStakeholders.id, id))
        .returning({ id: policyStakeholders.id }),
    ),
  equity_positions: (db, id, url) =>
    updateRows(() =>
      db
        .update(equityPositions)
        .set({ source: url })
        .where(eq(equityPositions.id, id))
        .returning({ id: equityPositions.id }),
    ),
  divisions: (db, id, url) =>
    updateRows(() =>
      db
        .update(divisions)
        .set({ source: url })
        .where(eq(divisions.id, id))
        .returning({ id: divisions.id }),
    ),
  funding_rounds: (db, id, url) =>
    updateRows(() =>
      db
        .update(fundingRounds)
        .set({ source: url })
        .where(eq(fundingRounds.id, id))
        .returning({ id: fundingRounds.id }),
    ),
  funding_programs: (db, id, url) =>
    updateRows(() =>
      db
        .update(fundingPrograms)
        .set({ source: url })
        .where(eq(fundingPrograms.id, id))
        .returning({ id: fundingPrograms.id }),
    ),
  // publications + page_citations store the source URL in the `url` column,
  // not `source`. Writing to `source` would leave `url` NULL so the record
  // keeps showing up as "missing source" on every backfill run.
  publications: (db, id, url) =>
    updateRows(() =>
      db
        .update(publications)
        .set({ url })
        .where(eq(publications.id, id))
        .returning({ id: publications.id }),
    ),
  page_citations: (db, id, url) =>
    updateRows(() =>
      db
        .update(pageCitations)
        .set({ url })
        .where(eq(pageCitations.id, Number(id)))
        .returning({ id: pageCitations.id }),
    ),
};
