// Shared formatting + behavior for directory filter chips and dropdowns (QUA-1009).

export interface FilterFacet {
  key: string;
  label: string;
  count?: number;
}

/**
 * Text content for a single facet button/option.
 *
 * Always includes a real text-node separator between the label and the count
 * (a space + parentheses), so screen readers and `textContent` produce
 * "Enacted (18)" rather than "Enacted18". Closes QUA-918 by construction —
 * any caller using this helper can't reproduce the bug.
 */
export function formatFacetTextContent(label: string, count?: number): string {
  if (count == null) return label;
  return `${label} (${count})`;
}

/**
 * Filter visible facets per the documented anti-pattern rules (QUA-919):
 *
 * - `hideTautologyFacets`: drop chips whose count equals the total — they
 *   match every row and carry no information ("Active 50/50").
 * - Always: drop chips with `count === 0` — nothing to filter to.
 *
 * `total` is the count for the "All" chip. If unset, only the count===0 rule
 * applies.
 */
export function filterVisibleFacets<T extends FilterFacet>(
  items: T[],
  opts: { total?: number; hideTautologyFacets?: boolean },
): T[] {
  return items.filter((item) => {
    if (item.count === 0) return false;
    if (
      opts.hideTautologyFacets &&
      opts.total != null &&
      item.count === opts.total
    ) {
      return false;
    }
    return true;
  });
}
