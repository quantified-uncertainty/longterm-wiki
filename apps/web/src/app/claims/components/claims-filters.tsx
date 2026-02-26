"use client";

export interface ClaimFilters {
  search: string;
  entity: string;
  category: string;
  confidence: string;
  claimMode: string;
  topic: string;
  property: string;
  groupBy: string;
  multiEntity: boolean;
  numericOnly: boolean;
}

export function ClaimsFilterBar({
  entities,
  categories,
  topics,
  properties,
  filters,
  onFilterChange,
  entityNames = {},
}: {
  entities: string[];
  categories: string[];
  topics: string[];
  properties: string[];
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
    filters.topic ||
    filters.property ||
    filters.multiEntity ||
    filters.numericOnly;

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
        value={filters.topic}
        onChange={(e) => onFilterChange("topic", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All topics</option>
        {topics.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      <select
        value={filters.property}
        onChange={(e) => onFilterChange("property", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All properties</option>
        {properties.map((p) => (
          <option key={p} value={p}>
            {p}
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
      <select
        value={filters.claimMode}
        onChange={(e) => onFilterChange("claimMode", e.target.value)}
        className="text-xs border rounded px-2 py-1.5"
      >
        <option value="">All modes</option>
        <option value="endorsed">endorsed</option>
        <option value="attributed">attributed</option>
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
      <div className="flex items-center gap-1.5">
        <span className="text-xs text-muted-foreground">Group by:</span>
        <select
          value={filters.groupBy}
          onChange={(e) => onFilterChange("groupBy", e.target.value)}
          className="text-xs border rounded px-2 py-1.5"
        >
          <option value="">None</option>
          <option value="topic">Topic</option>
          <option value="property">Property</option>
        </select>
      </div>
      {hasFilters && (
        <button
          type="button"
          onClick={() => {
            onFilterChange("search", "");
            onFilterChange("entity", "");
            onFilterChange("category", "");
            onFilterChange("confidence", "");
            onFilterChange("claimMode", "");
            onFilterChange("topic", "");
            onFilterChange("property", "");
            onFilterChange("groupBy", "");
            onFilterChange("multiEntity", false);
            onFilterChange("numericOnly", false);
          }}
          className="text-xs text-blue-600 hover:underline cursor-pointer"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
