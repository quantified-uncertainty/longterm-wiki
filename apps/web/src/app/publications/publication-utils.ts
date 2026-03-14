/**
 * Formats a snake_case publication type string into Title Case.
 * e.g., "academic_journal" -> "Academic Journal"
 */
export function formatType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
