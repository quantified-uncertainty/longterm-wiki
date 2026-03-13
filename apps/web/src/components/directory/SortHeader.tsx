"use client";

/**
 * Sortable table header cell for directory tables (/people, /organizations).
 * Shows a sort direction indicator when active, with aria-sort for accessibility.
 */
export function SortHeader<K extends string>({
  label,
  sortKey,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  sortKey: K;
  currentSort: K;
  currentDir: "asc" | "desc";
  onSort: (key: K) => void;
  className?: string;
}) {
  const isActive = currentSort === sortKey;
  const ariaSort = isActive
    ? currentDir === "asc"
      ? ("ascending" as const)
      : ("descending" as const)
    : ("none" as const);

  return (
    <th
      className={`py-2.5 px-3 font-medium ${className ?? ""}`}
      aria-sort={ariaSort}
    >
      <button
        type="button"
        className={`inline-flex items-center gap-1 cursor-pointer select-none hover:text-foreground transition-colors ${
          isActive ? "text-foreground" : ""
        }`}
        onClick={() => onSort(sortKey)}
      >
        {label}
        {isActive && (
          <span className="text-[10px]">
            {currentDir === "asc" ? "\u25B2" : "\u25BC"}
          </span>
        )}
      </button>
    </th>
  );
}
