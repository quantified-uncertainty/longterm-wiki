/**
 * Cost-effectiveness (leverage) parsing utilities.
 * Shared between server page (computing leverage) and client table (types).
 */

function applyMultiplier(num: number, suffix: string): number | null {
  if (isNaN(num)) return null;
  const mult: Record<string, number> = { K: 1e3, M: 1e6, B: 1e9 };
  return num * (mult[suffix.toUpperCase()] || 1);
}

/** Parse dollar-denominated range strings like "$300K-1M", "$1-5M", "$0-50K" into a midpoint. */
export function parseDollarRange(str: string): number | null {
  // Strip trailing descriptors
  const cleaned = str
    .replace(/\s*\(.*?\)/g, "")
    .replace(/\s*\/year/gi, "")
    .replace(
      /\s*(company|capital|annually|over|R&D|dev|servers|required|legal fees|infrastructure|proposed|for|FY\d+).*$/gi,
      ""
    )
    .trim();

  // Match "$X[K|M|B]-$Y[K|M|B]" or "$X[K|M|B]-Y[K|M|B]"
  const rangeMatch = cleaned.match(
    /\$([0-9,.]+)\s*([KMB]?)[\s\-\u2013]+(?:\$)?([0-9,.]+)\s*([KMB]?)/i
  );
  if (rangeMatch) {
    const suffix1 = rangeMatch[2].toUpperCase();
    const suffix2 = rangeMatch[4].toUpperCase();
    // If first number has no suffix, inherit from second (e.g., "$1-5M" means "$1M-$5M")
    const effectiveSuffix1 = suffix1 || suffix2;
    const low = applyMultiplier(
      parseFloat(rangeMatch[1].replace(/,/g, "")),
      effectiveSuffix1
    );
    const high = applyMultiplier(
      parseFloat(rangeMatch[3].replace(/,/g, "")),
      suffix2
    );
    if (low !== null && high !== null) return (low + high) / 2;
  }

  // Single value: "$50M"
  const singleMatch = cleaned.match(/\$([0-9,.]+)\s*([KMB]?)/i);
  if (singleMatch) {
    return applyMultiplier(
      parseFloat(singleMatch[1].replace(/,/g, "")),
      singleMatch[2].toUpperCase()
    );
  }

  return null;
}

/** Compute leverage ratio (EV / cost) with formatted label. */
export function computeLeverage(
  costStr: string,
  evStr: string
): { ratio: number | null; label: string } {
  const cost = parseDollarRange(costStr);
  const ev = parseDollarRange(evStr);
  if (cost === null || ev === null || cost === 0)
    return { ratio: null, label: "\u2014" };
  const ratio = ev / cost;
  if (ratio >= 1000)
    return { ratio, label: `${Math.round(ratio / 1000)}Kx` };
  if (ratio >= 1) return { ratio, label: `${Math.round(ratio)}x` };
  return { ratio, label: `${ratio.toFixed(1)}x` };
}
