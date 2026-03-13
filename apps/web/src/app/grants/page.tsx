import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords, getKBEntity, getKBEntitySlug } from "@/data/kb";
import { getEntityHref } from "@/data/entity-nav";
import { getTypedEntityById } from "@/data/database";
import { ProfileStatCard } from "@/components/directory";
import { formatCompactCurrency } from "@/lib/format-compact";
import { GrantsTable, type GrantRow } from "./grants-table";

export const metadata: Metadata = {
  title: "Grants",
  description:
    "Directory of grant disbursements tracked in the knowledge base, including funding from major AI safety and EA organizations.",
};

export default function GrantsPage() {
  const allGrants = getAllKBRecords("grants");

  // Build rows with resolved entity names and links
  const rows: GrantRow[] = allGrants.map((record) => {
    const orgEntity = getKBEntity(record.ownerEntityId);
    const orgName = orgEntity?.name ?? record.ownerEntityId;
    const orgSlug = getKBEntitySlug(record.ownerEntityId) ?? null;
    const orgTypedEntity = getTypedEntityById(record.ownerEntityId);
    const orgWikiPageId = orgTypedEntity?.numericId ?? null;

    const recipientId =
      typeof record.fields.recipient === "string"
        ? record.fields.recipient
        : null;

    return {
      compositeKey: `${record.ownerEntityId}-${record.key}`,
      recordKey: record.key,
      name: (record.fields.name as string) ?? record.key,
      organizationId: record.ownerEntityId,
      organizationName: orgName,
      organizationSlug: orgSlug,
      organizationWikiPageId: orgWikiPageId,
      recipient: recipientId,
      program:
        typeof record.fields.program === "string"
          ? record.fields.program
          : null,
      amount:
        typeof record.fields.amount === "number"
          ? record.fields.amount
          : null,
      period:
        typeof record.fields.period === "string"
          ? record.fields.period
          : null,
      date:
        typeof record.fields.date === "string" ? record.fields.date : null,
      status:
        typeof record.fields.status === "string"
          ? record.fields.status
          : null,
      source:
        typeof record.fields.source === "string"
          ? record.fields.source
          : null,
    };
  });

  // Compute summary stats
  const totalGrants = rows.length;
  const totalAmount = rows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const uniqueOrgs = new Set(rows.map((r) => r.organizationId)).size;
  const uniqueRecipients = new Set(
    rows.filter((r) => r.recipient).map((r) => r.recipient),
  ).size;

  // Build top funders summary (sorted by total amount desc)
  const funderTotals = new Map<
    string,
    { id: string; name: string; count: number; total: number; href: string | null }
  >();
  for (const r of rows) {
    const existing = funderTotals.get(r.organizationId);
    const href = getEntityHref(r.organizationId);
    if (existing) {
      existing.count += 1;
      existing.total += r.amount ?? 0;
    } else {
      funderTotals.set(r.organizationId, {
        id: r.organizationId,
        name: r.organizationName,
        count: 1,
        total: r.amount ?? 0,
        href: href !== `/wiki/${r.organizationId}` ? href : null,
      });
    }
  }
  const topFunders = [...funderTotals.values()].sort(
    (a, b) => b.total - a.total,
  );

  const stats = [
    { label: "Total Grants", value: totalGrants.toLocaleString() },
    { label: "Total Funding", value: formatCompactCurrency(totalAmount) },
    { label: "Funding Orgs", value: String(uniqueOrgs) },
    { label: "Unique Recipients", value: String(uniqueRecipients) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Grants</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of individual grant disbursements tracked in the knowledge
          base, including funding from AI safety, effective altruism, and
          philanthropic organizations.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      {/* Top funders summary */}
      {topFunders.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">By Funder</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {topFunders.map((funder) => (
              <div
                key={funder.id}
                className="flex items-center justify-between rounded-lg border border-border/60 px-4 py-3"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">
                    {funder.href ? (
                      <Link href={funder.href} className="hover:underline">
                        {funder.name}
                      </Link>
                    ) : (
                      funder.name
                    )}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {funder.count} grant{funder.count !== 1 ? "s" : ""}
                  </p>
                </div>
                <p className="text-sm font-semibold tabular-nums">
                  {formatCompactCurrency(funder.total)}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Grants table */}
      {totalGrants > 0 ? (
        <GrantsTable rows={rows} />
      ) : (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No grants data available</p>
          <p className="text-sm">
            Grant records are populated from the knowledge base during the build
            process.
          </p>
        </div>
      )}
    </div>
  );
}
