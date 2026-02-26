"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ClaimRow } from "@wiki-server/api-types";
import { ClaimsTable } from "../components/claims-table";
import { TopicBadge } from "../components/topic-badge";
import { PropertyBadge } from "../components/property-badge";

interface ClaimGroup {
  key: string;
  claims: ClaimRow[];
}

function groupClaims(
  claims: ClaimRow[],
  groupBy: "topic" | "property"
): ClaimGroup[] {
  const map = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const key =
      groupBy === "topic"
        ? claim.topic ?? "uncategorized"
        : claim.property ?? "none";
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(claim);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([key, claims]) => ({ key, claims }));
}

function GroupBadge({
  groupBy,
  groupKey,
}: {
  groupBy: "topic" | "property";
  groupKey: string;
}) {
  if (groupBy === "topic") return <TopicBadge topic={groupKey === "uncategorized" ? null : groupKey} />;
  return <PropertyBadge property={groupKey === "none" ? null : groupKey} />;
}

export function ClaimsGroupedView({
  claims,
  groupBy,
  entityNames = {},
}: {
  claims: ClaimRow[];
  groupBy: "topic" | "property";
  entityNames?: Record<string, string>;
}) {
  const groups = groupClaims(claims, groupBy);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  function toggleGroup(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      {groups.map((group) => {
        const isCollapsed = collapsed.has(group.key);
        return (
          <div key={group.key} className="border rounded-lg">
            <button
              type="button"
              onClick={() => toggleGroup(group.key)}
              className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer"
            >
              {isCollapsed ? (
                <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
              )}
              <GroupBadge groupBy={groupBy} groupKey={group.key} />
              <span className="text-xs text-muted-foreground">
                {group.claims.length} claim{group.claims.length !== 1 ? "s" : ""}
              </span>
            </button>
            {!isCollapsed && (
              <div className="border-t">
                <ClaimsTable
                  claims={group.claims}
                  entityNames={entityNames}
                  pageSize={20}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
