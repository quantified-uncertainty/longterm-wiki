"use client";

import { useState, useMemo } from "react";
import { Search } from "lucide-react";

interface FilterableStatement {
  id: number;
  variety: string;
  status: string;
  statementText: string | null;
  propertyId: string | null;
  attributedTo: string | null;
  property: { label: string; category: string } | null;
}

interface StatementsFilterProps {
  statements: FilterableStatement[];
  children: (filtered: FilterableStatement[]) => React.ReactNode;
}

/**
 * Client-side filter wrapper for the entity statements page.
 * Provides search and status filtering, renders children with filtered data.
 */
export function StatementsFilter({
  statements,
  children,
}: StatementsFilterProps) {
  const [query, setQuery] = useState("");
  const [showSuperseded, setShowSuperseded] = useState(true);

  const filtered = useMemo(() => {
    let result = statements;

    if (!showSuperseded) {
      result = result.filter((s) => s.status === "active");
    } else {
      result = result.filter(
        (s) => s.status === "active" || s.status === "superseded"
      );
    }

    if (query.trim()) {
      const q = query.trim().toLowerCase();
      result = result.filter((s) => {
        const text = [
          s.property?.label,
          s.property?.category,
          s.propertyId,
          s.statementText,
          s.attributedTo,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      });
    }

    return result;
  }, [statements, query, showSuperseded]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            placeholder="Filter statements..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showSuperseded}
            onChange={(e) => setShowSuperseded(e.target.checked)}
            className="rounded border-input"
          />
          Show superseded
        </label>
        <span className="text-xs text-muted-foreground tabular-nums ml-auto">
          {filtered.length} of {statements.length}
        </span>
      </div>
      {children(filtered)}
    </div>
  );
}
