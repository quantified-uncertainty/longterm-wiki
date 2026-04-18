/**
 * Drizzle auto-generates FK constraint names in the form
 * `<child_table>_<child_col>_<parent_table>_<parent_col>_fk`. Integration
 * tests assert on these names to verify migrations landed correctly, but
 * re-typing the string by hand for every FK migration is error-prone — the
 * 12-PR QUA-549 Phase B sweep had to touch it on every rename.
 *
 * `expectedFkName()` centralises the convention so tests express the FK
 * edge (child → parent) rather than the Drizzle string. Any future change
 * to Drizzle's naming scheme only needs to be updated here.
 *
 * See QUA-603.
 */
export function expectedFkName(
  childTable: string,
  childCol: string,
  parentTable: string,
  parentCol: string,
): string {
  return `${childTable}_${childCol}_${parentTable}_${parentCol}_fk`;
}
