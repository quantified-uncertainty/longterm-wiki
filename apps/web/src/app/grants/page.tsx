import type { Metadata } from "next";
import { getKBEntities, getKBRecords, getKBEntitySlug } from "@/data/kb";
import { formatCompactCurrency } from "@/lib/format-compact";
import { ProfileStatCard } from "@/components/directory";
import { GrantsTable, type GrantRow } from "./grants-table";

export const metadata: Metadata = {
  title: "Grants",
  description:
    "Directory of individual grant disbursements tracked in the knowledge base.",
};

export default function GrantsPage() {
  const allEntities = getKBEntities();
  const orgs = allEntities.filter(
    (e) => e.type === "organization" || e.type === "funder",
  );

  // Collect all grant records across organization entities
  const rows: GrantRow[] = [];

  for (const entity of orgs) {
    const grants = getKBRecords(entity.id, "grants");
    if (grants.length === 0) continue;

    const slug = getKBEntitySlug(entity.id) ?? null;

    // Build program name lookup from funding-programs on the same entity
    const programs = getKBRecords(entity.id, "funding-programs");
    const programNames = new Map<string, string>();
    for (const p of programs) {
      const pFields = p.fields as Record<string, unknown>;
      programNames.set(p.key, (pFields.name as string) ?? p.key);
    }

    for (const grant of grants) {
      const fields = grant.fields as Record<string, unknown>;
      const programKey = (fields.program as string) ?? null;
      rows.push({
        compositeKey: `${entity.id}-${grant.key}`,
        name: (fields.name as string) ?? grant.key,
        organizationId: entity.id,
        organizationName: entity.name,
        organizationSlug: slug,
        organizationWikiPageId: entity.wikiPageId ?? entity.numericId ?? null,
        recipient: (fields.recipient as string) ?? null,
        program: programKey ? (programNames.get(programKey) ?? programKey) : null,
        amount: typeof fields.amount === "number" ? fields.amount : null,
        period: (fields.period as string) ?? null,
        date: (fields.date as string) ?? null,
        status: (fields.status as string) ?? null,
        source: (fields.source as string) ?? null,
      });
    }
  }

  // Compute summary stats
  const totalAmount = rows.reduce((s, r) => s + (r.amount ?? 0), 0);
  const withAmount = rows.filter((r) => r.amount != null).length;
  const uniqueOrgs = new Set(rows.map((r) => r.organizationId)).size;
  const activeCount = rows.filter((r) => r.status === "active").length;

  const stats = [
    { label: "Total Grants", value: String(rows.length) },
    { label: "Total Amount", value: totalAmount > 0 ? formatCompactCurrency(totalAmount) : "\u2014" },
    { label: "With Amount Data", value: String(withAmount) },
    { label: "Organizations", value: String(uniqueOrgs) },
    { label: "Active", value: String(activeCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Grants
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of individual grant disbursements tracked in the knowledge
          base. Programs and initiatives are tracked separately.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <GrantsTable rows={rows} />
    </div>
  );
}
