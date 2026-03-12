"use client";

/**
 * Sortable table header cell for directory tables (/people, /organizations).
 * Shows a sort direction indicator when active.
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
  return (
    <th
      className={`py-2.5 px-3 font-medium cursor-pointer select-none hover:text-foreground transition-colors ${
        isActive ? "text-foreground" : ""
      } ${className ?? ""}`}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive && (
          <span className="text-[10px]">
            {currentDir === "asc" ? "\u25B2" : "\u25BC"}
          </span>
        )}
      </span>
    </th>
  );
}
