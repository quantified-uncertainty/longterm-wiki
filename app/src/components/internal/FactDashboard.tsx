"use client";

import { useState } from "react";
import Link from "next/link";

interface FactEntry {
  key: string;
  entity: string;
  factId: string;
  value?: string;
  numeric?: number;
  asOf?: string;
  source?: string;
  note?: string;
  computed?: boolean;
  compute?: string;
}

export function FactDashboard({
  facts,
  entityHrefs,
}: {
  facts: FactEntry[];
  entityHrefs: Record<string, string>;
}) {
  const [filter, setFilter] = useState("");
  const [showComputed, setShowComputed] = useState(true);

  const filtered = facts.filter((f) => {
    if (!showComputed && f.computed) return false;
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (
      f.entity.toLowerCase().includes(q) ||
      f.factId.toLowerCase().includes(q) ||
      (f.value || "").toLowerCase().includes(q)
    );
  });

  // Group by entity
  const grouped = new Map<string, FactEntry[]>();
  for (const fact of filtered) {
    const group = grouped.get(fact.entity) || [];
    group.push(fact);
    grouped.set(fact.entity, group);
  }

  const sortedEntities = [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <input
          type="text"
          placeholder="Filter by entity or fact ID..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="flex-1 px-3 py-2 text-sm border border-border rounded-md bg-background"
        />
        <label className="flex items-center gap-2 text-sm text-muted-foreground whitespace-nowrap">
          <input
            type="checkbox"
            checked={showComputed}
            onChange={(e) => setShowComputed(e.target.checked)}
            className="rounded"
          />
          Show computed
        </label>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {filtered.length} facts across {grouped.size} entities
        </span>
      </div>

      <div className="space-y-6">
        {sortedEntities.map(([entity, entityFacts]) => (
          <div key={entity}>
            <h3 className="text-base font-semibold mb-2 text-foreground">
              <Link href={entityHrefs[entity] || `/wiki/${entity}`} className="hover:underline">
                {entity}
              </Link>
            </h3>
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th className="pb-1 pr-4 font-medium">Fact ID</th>
                  <th className="pb-1 pr-4 font-medium">Value</th>
                  <th className="pb-1 pr-4 font-medium">As Of</th>
                  <th className="pb-1 pr-4 font-medium">Source</th>
                  <th className="pb-1 font-medium">Type</th>
                </tr>
              </thead>
              <tbody>
                {entityFacts.map((fact) => (
                  <tr key={fact.key} className="border-t border-border">
                    <td className="py-1.5 pr-4 font-mono text-xs">{fact.factId}</td>
                    <td className="py-1.5 pr-4">
                      {fact.value || (fact.numeric !== undefined ? String(fact.numeric) : "—")}
                    </td>
                    <td className="py-1.5 pr-4 text-muted-foreground">{fact.asOf || "—"}</td>
                    <td className="py-1.5 pr-4 text-muted-foreground text-xs max-w-[200px] truncate">
                      {fact.source || "—"}
                    </td>
                    <td className="py-1.5">
                      {fact.computed ? (
                        <span className="text-xs px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded dark:bg-blue-900 dark:text-blue-300">
                          computed
                        </span>
                      ) : (
                        <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded dark:bg-green-900 dark:text-green-300">
                          manual
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
