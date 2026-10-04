/** Month the site stopped being actively maintained. */
export const MAINTENANCE_ENDED = "May 2026";

/** Site-wide notice that Longterm Wiki is no longer actively maintained. */
export function MaintenanceBanner() {
  return (
    <div
      role="note"
      className="border-b border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
    >
      Longterm Wiki has not been actively maintained since {MAINTENANCE_ENDED}.
      Some data is still updated occasionally, but please don&apos;t rely on
      this site being current or accurate.
    </div>
  );
}
