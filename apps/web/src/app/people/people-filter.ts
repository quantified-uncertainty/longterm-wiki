import type { PersonRow } from "./people-table";

/**
 * Determines whether a person entry has enough meaningful data to display
 * by default in the people directory.
 *
 * A person is considered "meaningful" (not a publication-only stub) if they have
 * at least one of:
 * - A role recorded
 * - An employer/affiliation recorded
 * - A wiki page
 * - Career history entries
 * - Expert positions
 *
 * People who only have publications (or nothing at all) are considered stubs
 * and hidden by default, with a toggle to show them.
 */
export function isPersonMeaningful(row: PersonRow): boolean {
  if (row.role != null) return true;
  if (row.employerId != null || row.employerName != null) return true;
  if (row.wikiPageId != null) return true;
  if (row.careerHistoryCount > 0) return true;
  if (row.positionCount > 0) return true;
  return false;
}

/**
 * Partitions person rows into meaningful entries and stubs.
 */
export function partitionPersonRows(rows: PersonRow[]): {
  meaningful: PersonRow[];
  stubs: PersonRow[];
} {
  const meaningful: PersonRow[] = [];
  const stubs: PersonRow[] = [];
  for (const row of rows) {
    if (isPersonMeaningful(row)) {
      meaningful.push(row);
    } else {
      stubs.push(row);
    }
  }
  return { meaningful, stubs };
}
