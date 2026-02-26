"use client";

import { useState } from "react";
import { List, Table2 } from "lucide-react";
import { cn } from "@lib/utils";
import type { ClaimRow } from "@wiki-server/api-types";
import { EntityClaimsList } from "./entity-claims-list";
import { ClaimsTable } from "../../components/claims-table";

export function EntityClaimsViews({
  claims,
  entityNames,
}: {
  claims: ClaimRow[];
  entityNames: Record<string, string>;
}) {
  const [view, setView] = useState<"sections" | "table">("sections");

  return (
    <div>
      {/* View toggle */}
      <div className="flex items-center gap-1 mb-4">
        <button
          onClick={() => setView("sections")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            view === "sections"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          <List className="w-3.5 h-3.5" />
          Sections
        </button>
        <button
          onClick={() => setView("table")}
          className={cn(
            "inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            view === "table"
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          <Table2 className="w-3.5 h-3.5" />
          Table
        </button>
      </div>

      {view === "sections" ? (
        <EntityClaimsList claims={claims} />
      ) : (
        <ClaimsTable claims={claims} entityNames={entityNames} />
      )}
    </div>
  );
}
