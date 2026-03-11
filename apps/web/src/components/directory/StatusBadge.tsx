/**
 * Small status badges used on profile pages (Current, Founder, etc.).
 */
export function CurrentBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
      Current
    </span>
  );
}

export function FounderBadge() {
  return (
    <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
      Founder
    </span>
  );
}
