"use client";

import { useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ClaimRow } from "@wiki-server/api-response-types";
import { ClaimsFilterBar } from "../components/claims-filters";
import { ClaimsTable } from "../components/claims-table";

export function ClaimsExplorer({
  claims,
  entities,
  categories,
  verdicts = [],
  entityNames = {},
}: {
  claims: ClaimRow[];
  entities: string[];
  categories: string[];
  verdicts?: string[];
  entityNames?: Record<string, string>;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = {
    search: searchParams.get("q") ?? "",
    entity: searchParams.get("entity") ?? "",
    category: searchParams.get("category") ?? "",
    confidence: searchParams.get("confidence") ?? "",
    claimMode: searchParams.get("claimMode") ?? "",
    multiEntity: searchParams.get("multiEntity") === "true",
    numericOnly: searchParams.get("numericOnly") === "true",
    structuredOnly: searchParams.get("structuredOnly") === "true",
    verifiedOnly: searchParams.get("verifiedOnly") === "true",
    sortBy: searchParams.get("sortBy") ?? "",
  };

  function onFilterChange(key: string, value: string | boolean) {
    const params = new URLSearchParams(searchParams.toString());
    const paramKey = key === "search" ? "q" : key;
    const strValue =
      typeof value === "boolean" ? (value ? "true" : "") : value;
    if (strValue) {
      params.set(paramKey, strValue);
    } else {
      params.delete(paramKey);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  const filteredClaims = useMemo(() => {
    let result = claims;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      result = result.filter((c) =>
        c.claimText.toLowerCase().includes(q)
      );
    }
    if (filters.entity) {
      result = result.filter((c) => c.entityId === filters.entity);
    }
    if (filters.category) {
      result = result.filter(
        (c) =>
          (c.claimCategory ?? "uncategorized") === filters.category
      );
    }
    if (filters.confidence) {
      result = result.filter(
        (c) =>
          (c.claimVerdict ?? c.confidence ?? "unverified") ===
          filters.confidence
      );
    }
    if (filters.claimMode) {
      result = result.filter(
        (c) => (c.claimMode ?? "endorsed") === filters.claimMode
      );
    }
    if (filters.multiEntity) {
      result = result.filter(
        (c) => c.relatedEntities && c.relatedEntities.length > 0
      );
    }
    if (filters.numericOnly) {
      result = result.filter(
        (c) =>
          c.valueNumeric != null ||
          c.valueLow != null ||
          c.valueHigh != null
      );
    }
    if (filters.structuredOnly) {
      result = result.filter((c) => c.property != null);
    }
    if (filters.verifiedOnly) {
      result = result.filter((c) => c.claimVerdict != null);
    }

    // Client-side sorting
    if (filters.sortBy) {
      result = [...result];
      switch (filters.sortBy) {
        case "verdict_score_desc":
          result.sort(
            (a, b) =>
              (b.claimVerdictScore ?? -1) -
              (a.claimVerdictScore ?? -1)
          );
          break;
        case "verdict_score_asc":
          result.sort(
            (a, b) =>
              (a.claimVerdictScore ?? 2) -
              (b.claimVerdictScore ?? 2)
          );
          break;
        case "verdict":
          result.sort((a, b) =>
            (a.claimVerdict ?? "zzz").localeCompare(
              b.claimVerdict ?? "zzz"
            )
          );
          break;
        case "newest":
          result.sort((a, b) => b.id - a.id);
          break;
        case "entity":
          result.sort((a, b) =>
            a.entityId.localeCompare(b.entityId)
          );
          break;
      }
    }

    return result;
  }, [claims, filters]);

  return (
    <div>
      <ClaimsFilterBar
        entities={entities}
        categories={categories}
        verdicts={verdicts}
        filters={filters}
        onFilterChange={onFilterChange}
        entityNames={entityNames}
      />
      <div className="text-xs text-muted-foreground mb-2">
        {filteredClaims.length} of {claims.length} claims
      </div>
      <ClaimsTable claims={filteredClaims} entityNames={entityNames} />
    </div>
  );
}
