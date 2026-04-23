/**
 * Drizzle auto-generates FK constraint names as
 * `<child_table>_<child_col>_<parent_table>_<parent_col>_fk`.
 * This helper lets tests express the FK edge rather than the string.
 */
export function expectedFkName(
  childTable: string,
  childCol: string,
  parentTable: string,
  parentCol: string,
): string {
  return `${childTable}_${childCol}_${parentTable}_${parentCol}_fk`;
}
