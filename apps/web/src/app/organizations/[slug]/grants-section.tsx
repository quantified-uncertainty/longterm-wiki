/**
 * Grants Given / Grants Received sections for organization profile pages.
 *
 * Supports two modes:
 * - **Static mode** (small datasets): Serializes all grants into the RSC payload
 *   and does client-side search/sort/paginate.
 * - **Server mode** (large datasets, 200+ grants): Passes only the entity ID
 *   to the client component, which fetches paginated data from the wiki-server
 *   via /api/grants/by-entity/:entityId.
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
    programName: g.programName,
    divisionName: g.divisionName,
    notes: g.notes,
  };
}

/** Grants Given section — for orgs that are funders. */
export function GrantsGivenSection({
  grants,
  orgName,
  entityId,
}: {
  grants: ParsedGrantRecord[];
  orgName: string;
  /** Entity slug — enables server-side pagination for large datasets. */
  entityId?: string;
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + numericValue(g.amount),
    0,
  );

  const useServerMode = entityId && grants.length >= SERVER_MODE_THRESHOLD;

  return (
    <section>
      <SectionHeader title="Grants Given" count={grants.length} />
      <div className="text-sm text-muted-foreground mb-3">
        {grants.length} grant{grants.length !== 1 ? "s" : ""} totaling{" "}
        <span className="font-semibold text-foreground">
          {formatCompactCurrency(totalAmount)}
        </span>
      </div>
      {useServerMode ? (
        <InteractiveGrantsTable
          entityId={entityId}
          mode="given"
        />
      ) : (
        <InteractiveGrantsTable
          grants={grants.slice(0, MAX_RENDERED_ROWS).map(toGrantRow)}
          totalCount={grants.length}
          mode="given"
        />
      )}
    </section>
  );
}

/** Grants Received section — for orgs that are grantees. */
export function GrantsReceivedSection({
  grants,
}: {
  grants: ReceivedGrant[];
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce(
    (sum, g) => sum + numericValue(g.amount),
    0,
  );

  // Grants received are aggregated from multiple orgs' KB data,
  // so server mode is not applicable (wiki-server tracks by grantor, not grantee).
  const renderedGrants = grants.slice(0, MAX_RENDERED_ROWS);
  const rows: GrantRow[] = renderedGrants.map((g) => ({
    ...toGrantRow(g),
    funderName: g.funderName,
    funderHref: g.funderHref,
  }));

  return (
    <section>
      <SectionHeader title="Grants Received" count={grants.length} />
      <div className="text-sm text-muted-foreground mb-3">
        {grants.length} grant{grants.length !== 1 ? "s" : ""} totaling{" "}
        <span className="font-semibold text-foreground">
          {formatCompactCurrency(totalAmount)}
        </span>
      </div>
      <InteractiveGrantsTable
        grants={rows}
        totalCount={grants.length}
        mode="received"
      />
    </section>
  );
}
