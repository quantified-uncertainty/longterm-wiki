import type { Metadata } from "next";
import { ProfileStatCard } from "@/components/directory";
import { GrantsTable, type GrantRow } from "./grants-table";

export const metadata: Metadata = {
  title: "Grants",
  description:
    "Directory of individual grant disbursements tracked in the knowledge base.",
};

export default function GrantsPage() {
  // Records infrastructure removed — grants data previously came from KB records.
  // This page now shows an empty state until grants are migrated to PostgreSQL.
  const rows: GrantRow[] = [];

  const stats = [
    { label: "Total Grants", value: "0" },
    { label: "Total Amount", value: "\u2014" },
    { label: "With Amount Data", value: "0" },
    { label: "Organizations", value: "0" },
    { label: "Active", value: "0" },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Grants
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Directory of individual grant disbursements tracked in the knowledge
          base. Grant records are being migrated to PostgreSQL.
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
