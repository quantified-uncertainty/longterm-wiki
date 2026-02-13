/**
 * Shared formatting utilities for dates, frequencies, and relative time.
 */

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
