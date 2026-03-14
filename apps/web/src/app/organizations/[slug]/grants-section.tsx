/**
 * Unified Grants section for organization profile pages.
 *
 * Supports two directions:
 * - **given**: grants made by this org (funder view)
 * - **received**: grants received by this org (grantee view)
 *
 * Supports two modes:
 * - **Static mode** (small datasets): Serializes all grants into the RSC payload
 *   and does client-side search/sort/paginate.
 * - **Server mode** (large datasets, 200+ grants): Passes only the entity ID
 *   to the client component, which fetches paginated data from the wiki-server
 *   via /api/grants/by-entity/:entityId. Only available for "given" direction.
 */
import { formatCompactCurrency } from "@/lib/format-compact";
import { SectionHeader } from "./org-shared";
import type { ParsedGrantRecord, ReceivedGrant } from "./org-data";
import { formatAmount, numericValue } from "./org-data";
import { InteractiveGrantsTable, type GrantRow } from "./interactive-grants-table";

/** Grants above this threshold use server-side pagination. */
const SERVER_MODE_THRESHOLD = 200;

/** Cap for static mode. Only applies when server mode is not used. */
const MAX_RENDERED_ROWS = 5000;

/** Convert a ParsedGrantRecord to a serializable GrantRow for the client. */
function toGrantRow(g: ParsedGrantRecord): GrantRow {
  return {
    key: g.key,
    name: g.name,
    recipientName: g.recipientName,
    recipientHref: g.recipientHref,
    amount: numericValue(g.amount) || null,
    amountDisplay: g.amount != null ? formatAmount(g.amount) : null,
    date: g.date,
    status: g.status,
    source: g.source,
    // These fields exist on GrantRow (populated by server mode) but are not
    // part of ParsedGrantRecord (KB-sourced static data). Set to null so the
    // table gracefully omits them.
    programName: null,
    divisionName: null,
    notes: null,
  };
}

/** Unified grants section — handles both "given" (funder) and "received" (grantee) directions. */
export function GrantsSection({
  grants,
  direction,
  entityId,
}: {
  grants: ParsedGrantRecord[] | ReceivedGrant[];
  direction: "given" | "received";
  /** Entity stable ID (e.g. "ULjDXpSLCI") — enables server-side pagination for large "given" datasets. */
  entityId?: string;
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + numericValue(g.amount),
    0,
  );

  const title = direction === "given" ? "Grants Given" : "Grants Received";

  // Server mode is only applicable for "given" direction.
  // Grants received are aggregated from multiple orgs' KB data,
  // so wiki-server (which tracks by grantor, not grantee) can't serve them.
  const useServerMode =
    direction === "given" && entityId && grants.length >= SERVER_MODE_THRESHOLD;

  // Build rows — received grants include funder info
  const rows: GrantRow[] =
    direction === "received"
      ? (grants as ReceivedGrant[]).slice(0, MAX_RENDERED_ROWS).map((g) => ({
          ...toGrantRow(g),
          funderName: g.funderName,
          funderHref: g.funderHref,
        }))
      : grants.slice(0, MAX_RENDERED_ROWS).map(toGrantRow);

  return (
    <section>
      <SectionHeader title={title} count={grants.length} />
      <div className="text-sm text-muted-foreground mb-3">
        {grants.length} grant{grants.length !== 1 ? "s" : ""} totaling{" "}
        <span className="font-semibold text-foreground">
          {formatCompactCurrency(totalAmount)}
        </span>
      </div>
      {useServerMode ? (
        <InteractiveGrantsTable
          entityId={entityId}
          mode={direction}
        />
      ) : (
        <InteractiveGrantsTable
          grants={rows}
          totalCount={grants.length}
          mode={direction}
        />
      )}
    </section>
  );
}
