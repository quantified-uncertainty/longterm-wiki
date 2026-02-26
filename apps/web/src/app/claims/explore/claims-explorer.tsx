"use client";

import { useMemo } from "react";
import { useSearchParams, useRouter, usePathname } from "next/navigation";
import type { ClaimRow } from "@wiki-server/api-types";
import { ClaimsFilterBar } from "../components/claims-filters";
import { ClaimsTable } from "../components/claims-table";
import { ClaimsGroupedView } from "./claims-grouped-view";

export function ClaimsExplorer({
  claims,
  entities,
  categories,
  topics,
  properties,
  entityNames = {},
}: {
  claims: ClaimRow[];
  entities: string[];
  categories: string[];
  topics: string[];
  properties: string[];
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
    topic: searchParams.get("topic") ?? "",
    property: searchParams.get("property") ?? "",
    groupBy: searchParams.get("groupBy") ?? "",
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
    if (filters.topic) {
      result = result.filter(
        (c) => (c.topic ?? "uncategorized") === filters.topic
      );
    }
    if (filters.property) {
      result = result.filter(
        (c) => (c.property ?? "none") === filters.property
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

  const isGrouped = filters.groupBy === "topic" || filters.groupBy === "property";

  return (
    <div>
      <ClaimsFilterBar
        entities={entities}
        categories={categories}
        topics={topics}
        properties={properties}
        filters={filters}
        onFilterChange={onFilterChange}
        entityNames={entityNames}
      />
      <div className="text-xs text-muted-foreground mb-2">
        {filteredClaims.length} of {claims.length} claims
      </div>
      {isGrouped ? (
        <ClaimsGroupedView
          claims={filteredClaims}
          groupBy={filters.groupBy as "topic" | "property"}
          entityNames={entityNames}
        />
      ) : (
        <ClaimsTable claims={filteredClaims} entityNames={entityNames} />
      )}
    </div>
  );
}
