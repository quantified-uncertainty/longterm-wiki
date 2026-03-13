/**
 * Name normalization utilities.
 *
 * Pure string helpers for normalizing person names — lowercasing, trimming,
 * and stripping diacritics. Extracted from commands/people.ts so that lib
 * modules (e.g. person-mention-detector) can use them without pulling in
 * command-layer dependencies.
 */

/**
 * Normalize a name for matching: lowercase, trim, remove accents.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim();
}
