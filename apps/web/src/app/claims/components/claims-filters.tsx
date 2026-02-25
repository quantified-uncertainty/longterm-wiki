"use client";

export interface ClaimFilters {
  search: string;
  entity: string;
  category: string;
  confidence: string;
  multiEntity: boolean;
}

export function ClaimsFilterBar({
  entities,
  categories,
  filters,
  onFilterChange,
}: {
  entities: string[];
  categories: string[];
  filters: ClaimFilters;
  onFilterChange: (key: string, value: string | boolean) => void;
}) {
  const hasFilters =
    filters.search ||
    filters.entity ||
    filters.category ||
    filters.confidence ||
    filters.multiEntity;

  return (
    <div className="flex flex-wrap gap-2 mb-4">
      <input
        type="text"
        placeholder="Search claims..."
        value={filters.search}
        onChange={(e) => onFilterChange("search", e.target.value)}
        className="text-sm border rounded px-3 py-1.5 w-48 focus:outline-none focus:ring-1 focus:ring-blue-300"
      />
      <select
        value={filters.entity}
        onChange={(e) => onFilterChange("entity", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All entities</option>
        {entities.map((eid) => (
          <option key={eid} value={eid}>
            {eid}
          </option>
        ))}
      </select>
      <select
        value={filters.category}
        onChange={(e) => onFilterChange("category", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All categories</option>
        {categories.map((cat) => (
          <option key={cat} value={cat}>
            {cat}
          </option>
        ))}
      </select>
      <select
        value={filters.confidence}
        onChange={(e) => onFilterChange("confidence", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All confidence</option>
        <option value="verified">verified</option>
        <option value="unverified">unverified</option>
        <option value="unsourced">unsourced</option>
      </select>
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={filters.multiEntity}
          onChange={(e) => onFilterChange("multiEntity", e.target.checked)}
          className="rounded"
        />
        Multi-entity only
      </label>
      {hasFilters && (
        <button
          type="button"
          onClick={() => {
            onFilterChange("search", "");
            onFilterChange("entity", "");
            onFilterChange("category", "");
            onFilterChange("confidence", "");
            onFilterChange("multiEntity", false);
          }}
          className="text-xs text-blue-600 hover:underline cursor-pointer"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
