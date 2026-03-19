/**
 * Parse a display date string into a sortable ISO-ish string.
 * Handles formats like:
 *   "May 21, 2024" -> "2024-05-21"
 *   "2024-05"      -> "2024-05-01"
 *   "2024-05-21"   -> "2024-05-21"
 *   "May 2024"     -> "2024-05-01"
 */
const MONTH_TO_NUM: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08",
  sep: "09", oct: "10", nov: "11", dec: "12",
};

export function parseDisplayDateToISO(display: string): string | null {
  if (!display) return null;

  // Already ISO: "2024-05-21" or "2024-05"
  const isoFull = display.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoFull) return display;
  const isoPartial = display.match(/^(\d{4})-(\d{2})$/);
  if (isoPartial) return `${display}-01`;

  // "May 21, 2024" or "May 21 2024"
  const mdyMatch = display.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/
  );
  if (mdyMatch) {
    const month = MONTH_TO_NUM[mdyMatch[1].toLowerCase()];
    if (month) {
      const day = mdyMatch[2].padStart(2, "0");
      return `${mdyMatch[3]}-${month}-${day}`;
    }
  }

  // "May 2024"
  const myMatch = display.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (myMatch) {
    const month = MONTH_TO_NUM[myMatch[1].toLowerCase()];
    if (month) return `${myMatch[2]}-${month}-01`;
  }

  return null;
}
