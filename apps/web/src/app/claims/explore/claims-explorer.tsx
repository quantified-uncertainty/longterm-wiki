"use client";

import { useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ClaimRow } from "@wiki-server/api-types";
import { ClaimsFilterBar } from "../components/claims-filters";
import { ClaimsTable } from "../components/claims-table";

export function ClaimsExplorer({
  claims,
  entities,
  categories,
}: {
  claims: ClaimRow[];
  entities: string[];
  categories: string[];
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
        (c) => (c.claimCategory ?? "uncategorized") === filters.category
      );
    }
    if (filters.confidence) {
      result = result.filter(
        (c) => (c.confidence ?? "unverified") === filters.confidence
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
        (c) => c.valueNumeric != null || c.valueLow != null || c.valueHigh != null
      );
    }
    return result;
  }, [claims, filters]);

  return (
    <div>
      <ClaimsFilterBar
        entities={entities}
        categories={categories}
        filters={filters}
        onFilterChange={onFilterChange}
      />
      <div className="text-xs text-muted-foreground mb-2">
        {filteredClaims.length} of {claims.length} claims
      </div>
      <ClaimsTable claims={filteredClaims} />
    </div>
  );
}
