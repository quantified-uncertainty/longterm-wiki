/**
 * Per-record-type coverage scoring — counts non-null optional fields
 * and maps to a 1-4 score for display as CompletionDots.
 *
 * Each function accepts a minimal interface so callers only need
 * to pass the fields they have available.
 */

/** Map a field count to a 1-4 score given the total number of scoreable fields. */
function fieldCountToScore(filled: number, total: number): number {
  if (total <= 0) return 1;
  const ratio = filled / total;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

function countPresent(...values: unknown[]): number {
  return values.filter((v) => v != null && v !== "" && v !== false).length;
}

// ── Personnel ────────────────────────────────────────────────────────

export function computePersonnelCoverage(entry: {
  title?: string | null;
  start?: string | null;
  end?: string | null;
  verificationVerdict?: string | null;
}): number {
  // Fields: role/title, start date, end date, has been source-checked
  const filled = countPresent(entry.title, entry.start, entry.end, entry.verificationVerdict);
  return fieldCountToScore(filled, 4);
}

// ── Grants ───────────────────────────────────────────────────────────

export function computeGrantCoverage(grant: {
  amount?: number | string | null;
  date?: string | null;
  source?: string | null;
  programName?: string | null;
}): number {
  const filled = countPresent(grant.amount, grant.date, grant.source, grant.programName);
  return fieldCountToScore(filled, 4);
}

// ── Divisions ────────────────────────────────────────────────────────

export function computeDivisionCoverage(div: {
  lead?: string | null;
  totalAmount?: number | null;
  status?: string | null;
  startDate?: string | null;
}): number {
  const filled = countPresent(div.lead, div.totalAmount, div.status, div.startDate);
  return fieldCountToScore(filled, 4);
}

// ── Funding Programs ─────────────────────────────────────────────────

export function computeFundingProgramCoverage(prog: {
  totalBudget?: number | string | null;
  deadline?: string | null;
  description?: string | null;
  source?: string | null;
}): number {
  const filled = countPresent(prog.totalBudget, prog.deadline, prog.description, prog.source);
  return fieldCountToScore(filled, 4);
}
