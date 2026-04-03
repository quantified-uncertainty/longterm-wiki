/**
 * Shared formatting utilities for dates, frequencies, and relative time.
 */

const MONTH_ABBR = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * Format an ISO date string deterministically (no locale/timezone variance).
 *
 * Parses the date string directly instead of using `new Date().toLocaleDateString()`
 * which produces different results depending on server vs client timezone/locale.
 * This prevents React hydration mismatches (error #418) in client components that
 * render dates during the initial server-side and client-side render passes.
 *
 * Use this instead of `toLocaleDateString` in any "use client" component that
 * renders a date during initial render (not just inside useEffect).
 *
 * @example
 * formatDateDeterministic("2025-12-15T10:30:00Z") // "Dec 15, 2025"
 * formatDateDeterministic("2025-12")               // "Dec 2025"
 * formatDateDeterministic("2025")                  // "2025"
 */
export function formatDateDeterministic(iso: string): string {
  try {
    const parts = iso.split(/[-T]/);
    const year = parts[0];
    const month = parts[1] ? parseInt(parts[1], 10) : 0;
    const day = parts[2] ? parseInt(parts[2], 10) : 0;
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${MONTH_ABBR[month - 1]} ${day}, ${year}`;
    }
    if (month >= 1 && month <= 12) {
      return `${MONTH_ABBR[month - 1]} ${year}`;
    }
    return year || iso;
  } catch {
    return iso;
  }
}

/**
 * Format a date string as relative time (e.g., "3 days ago", "2 weeks ago").
 * Uses a compact style suitable for tables and metadata displays.
 */
export function formatAge(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Format an update frequency (in days) as a human-readable label.
 */
export function formatFrequency(days: number): string {
  if (days <= 3) return "every 3 days";
  if (days <= 7) return "weekly";
  if (days <= 14) return "biweekly";
  if (days <= 21) return "every 3 weeks";
  if (days <= 30) return "monthly";
  if (days <= 45) return "every 6 weeks";
  if (days <= 60) return "bimonthly";
  if (days <= 90) return "quarterly";
  return `every ${Math.round(days / 30)} months`;
}

/**
 * Format an update frequency as a short label for table columns.
 */
export function formatFrequencyShort(days: number): string {
  if (days <= 7) return "Weekly";
  if (days <= 14) return "Biweekly";
  if (days <= 21) return "3 weeks";
  if (days <= 30) return "Monthly";
  if (days <= 45) return "6 weeks";
  if (days <= 60) return "Bimonthly";
  if (days <= 90) return "Quarterly";
  return `${Math.round(days / 30)}mo`;
}

/**
 * Extract a short directory label from a full worktree path.
 *
 * Examples:
 *   "/Users/oz/Documents/GitHub.nosync/longterm-wiki-agent1/.claude/worktrees/thirsty-feistel"
 *     → "longterm-wiki-agent1/thirsty-feistel"
 *   "/Users/oz/Documents/GitHub.nosync/longterm-wiki-agent3"
 *     → "longterm-wiki-agent3"
 */
export function shortenDirectory(dir: string): string {
  const match = dir.match(/longterm-wiki[^/]*/);
  if (!match) return dir.split("/").pop() ?? dir;
  const base = match[0];
  const worktreeMatch = dir.match(/worktrees\/([^/]+)/);
  return worktreeMatch ? `${base}/${worktreeMatch[1]}` : base;
}
