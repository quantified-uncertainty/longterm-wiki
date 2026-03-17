import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, isApproach } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { ApproachesTable, type ApproachRow } from "./approaches-table";

export const metadata: Metadata = {
  title: "Approaches",
  description:
    "Directory of AI safety approaches, techniques, and strategies tracked in the knowledge base.",
};

export default function ApproachesPage() {
  const approaches = getTypedEntities().filter(isApproach);

  const rows: ApproachRow[] = approaches.map((a) => ({
    id: a.id,
    title: a.title,
    description: a.description ?? null,
    tags: a.tags ?? [],
    wikiId: a.wikiId ?? null,
  }));

  const uniqueTagCount = new Set(rows.flatMap((r) => r.tags)).size;

  const stats = [
    { label: "Approaches", value: String(rows.length) },
    {
      label: "With Description",
      value: String(rows.filter((r) => r.description).length),
    },
    { label: "Unique Tags", value: String(uniqueTagCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Approaches
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety approaches, techniques, and strategies -- from alignment
          methods and evaluation frameworks to governance mechanisms and
          deployment safeguards.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <Suspense fallback={<div>Loading...</div>}>
        <ApproachesTable rows={rows} />
      </Suspense>
    </div>
  );
}
