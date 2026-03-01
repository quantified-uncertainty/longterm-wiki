"use client";

export interface ClaimFilters {
  search: string;
  entity: string;
  category: string;
  confidence: string;
  claimMode: string;
  multiEntity: boolean;
  numericOnly: boolean;
  structuredOnly: boolean;
  verifiedOnly: boolean;
  sortBy: string;
}

export function ClaimsFilterBar({
  entities,
  categories,
  verdicts,
  filters,
  onFilterChange,
  entityNames = {},
}: {
  entities: string[];
  categories: string[];
  verdicts?: string[];
  filters: ClaimFilters;
  onFilterChange: (key: string, value: string | boolean) => void;
  entityNames?: Record<string, string>;
}) {
  const hasFilters =
    filters.search ||
    filters.entity ||
    filters.category ||
    filters.confidence ||
    filters.claimMode ||
    filters.multiEntity ||
    filters.numericOnly ||
    filters.structuredOnly ||
    filters.verifiedOnly ||
    filters.sortBy;

  // Use verdicts from props if provided, otherwise fall back to known values
  const verdictOptions =
    verdicts && verdicts.length > 0
      ? verdicts
      : ["verified", "disputed", "unsupported", "not_verifiable"];

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
            {entityNames[eid] ?? eid}
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
        <option value="">All verdicts</option>
        {verdictOptions.map((v) => (
          <option key={v} value={v}>
            {v.replace(/_/g, " ")}
          </option>
        ))}
      </select>
      <select
        value={filters.claimMode}
        onChange={(e) => onFilterChange("claimMode", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All modes</option>
        <option value="endorsed">endorsed</option>
        <option value="attributed">attributed</option>
      </select>
      <select
        value={filters.sortBy}
        onChange={(e) => onFilterChange("sortBy", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">Default sort</option>
        <option value="verdict_score_desc">Score: high to low</option>
        <option value="verdict_score_asc">Score: low to high</option>
        <option value="verdict">Verdict</option>
        <option value="newest">Newest first</option>
        <option value="entity">Entity</option>
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
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={filters.numericOnly}
          onChange={(e) => onFilterChange("numericOnly", e.target.checked)}
          className="rounded"
        />
        Numeric only
      </label>
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={filters.structuredOnly}
          onChange={(e) =>
            onFilterChange("structuredOnly", e.target.checked)
          }
          className="rounded"
        />
        Structured only
      </label>
      <label className="flex items-center gap-1.5 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={filters.verifiedOnly}
          onChange={(e) =>
            onFilterChange("verifiedOnly", e.target.checked)
          }
          className="rounded"
        />
        Verified only
      </label>
      {hasFilters && (
        <button
          type="button"
          onClick={() => {
            onFilterChange("search", "");
            onFilterChange("entity", "");
            onFilterChange("category", "");
            onFilterChange("confidence", "");
            onFilterChange("claimMode", "");
            onFilterChange("sortBy", "");
            onFilterChange("multiEntity", false);
            onFilterChange("numericOnly", false);
            onFilterChange("structuredOnly", false);
            onFilterChange("verifiedOnly", false);
          }}
          className="text-xs text-blue-600 hover:underline cursor-pointer"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
