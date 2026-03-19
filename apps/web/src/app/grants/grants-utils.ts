/**
 * Utility functions for the grants directory page.
 *
 * Resolves funding program IDs to human-readable display names.
 * The build pipeline stores grant programId as an opaque key (e.g. "navigating-transformative-ai")
 * while YAML-sourced grants use a human-readable `program` field. This module normalizes both
 * paths to a display-friendly name.
 */
import { getAllKBRecords } from "@/data/factbase";

/**
 * Build a lookup map from funding program record key to display name.
 * The funding-programs collection stores records keyed by their ID (e.g. "navigating-transformative-ai")
 * with a `name` field containing the display name (e.g. "Navigating Transformative AI").
 */
export function buildProgramNameMap(): Map<string, string> {
  const map = new Map<string, string>();
  const allPrograms = getAllKBRecords("funding-programs");
  for (const program of allPrograms) {
    const name =
      typeof program.fields.name === "string" ? program.fields.name : null;
    if (name) {
      map.set(program.key, name);
    }
  }
  return map;
}

/**
 * Resolve a grant's program to a display name.
 *
 * PG-sourced grants store the program as `fields.programId` (an opaque key),
 * while YAML-sourced grants use `fields.program` (either a key or a display name).
 * This function checks both fields and resolves keys to display names via the lookup map.
 */
export function resolveProgramName(
  fields: Record<string, unknown>,
  programNameMap: Map<string, string>,
): string | null {
  // Check programId first (PG-sourced grants)
  if (typeof fields.programId === "string" && fields.programId) {
    return programNameMap.get(fields.programId) ?? titleCaseFromSlug(fields.programId);
  }
  // Fall back to program field (YAML-sourced grants)
  if (typeof fields.program === "string" && fields.program) {
    return programNameMap.get(fields.program) ?? titleCaseFromSlug(fields.program);
  }
  return null;
}

/**
 * Convert a kebab-case slug to title case as a last-resort fallback.
 * e.g. "navigating-transformative-ai" -> "Navigating Transformative Ai"
 */
function titleCaseFromSlug(slug: string): string {
  return slug
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
