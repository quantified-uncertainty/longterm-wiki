import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import { numericIdToSlug, slugToNumericId } from "@/lib/mdx";
import { getPageById, getTypedEntityById } from "@/data";
import { fetchDetailed, withApiFallback } from "@lib/wiki-server";
import { StatCard } from "@components/internal/StatCard";
import { CurrentSnapshot } from "./current-snapshot";
import { StatementsClient } from "./statements-client";
import {
  resolveEntityNames,
  computeCurrentSnapshot,
  detectConflicts,
  groupByCategory,
} from "./statement-processing";
import type { ByEntityResult } from "@lib/statement-types";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

// ISR — these pages fetch live data from wiki-server
export const dynamicParams = true;

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const slug = isNumericId(id) ? numericIdToSlug(id.toUpperCase()) : id;
  const page = slug ? getPageById(slug) : null;
  const title = page?.title ?? slug ?? id;
  return {
    title: `${title} Statements | Longterm Wiki`,
    description: `Structured and attributed statements about ${title}.`,
  };
}

export default async function EntityStatementsPage({ params }: PageProps) {
  const { id } = await params;

  let slug: string | null;
  let numericId: string | null;

  if (isNumericId(id)) {
    numericId = id.toUpperCase();
    slug = numericIdToSlug(numericId);
  } else {
    slug = id;
    numericId = slugToNumericId(id);
  }

  if (!slug) notFound();

  const pageData = getPageById(slug);
  const title = pageData?.title ?? slug;

  const { data } = await withApiFallback<ByEntityResult>(
    () =>
      fetchDetailed<ByEntityResult>(
        `/api/statements/by-entity?entityId=${encodeURIComponent(slug!)}`,
        { revalidate: 30 }
      ),
    () => ({ structured: [], attributed: [], total: 0 })
  );

  const { structured, attributed, total } = data;

  // Resolve entity names server-side
  const resolver = (id: string) => {
    const entity = getTypedEntityById(id);
    return entity ? { title: entity.title } : undefined;
  };

  const resolvedStructured = resolveEntityNames(structured, resolver);
  const resolvedAttributed = resolveEntityNames(attributed, resolver);

  // Compute snapshot and conflicts
  const snapshotMap = computeCurrentSnapshot(resolvedStructured);
  const snapshot = [...snapshotMap.values()];
  const conflictsMap = detectConflicts(resolvedStructured);
  const conflictEntries = [...conflictsMap.entries()];
  const categories = groupByCategory(resolvedStructured);

  // Stats
  const activeStructured = resolvedStructured.filter((s) => s.status === "active");
  const activeAttributed = resolvedAttributed.filter((s) => s.status === "active");
  const activeTotal = activeStructured.length + activeAttributed.length;
  const retractedCount =
    resolvedStructured.filter((s) => s.status === "retracted").length +
    resolvedAttributed.filter((s) => s.status === "retracted").length;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">{title} - Statements</h1>
        <div className="flex flex-wrap gap-4 text-sm">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Back to page
          </Link>
          <Link
            href={`/wiki/${numericId || slug}/data`}
            className="text-muted-foreground hover:underline"
          >
            Data page
          </Link>
          <Link
            href={`/wiki/${numericId || slug}/claims`}
            className="text-muted-foreground hover:underline"
          >
            Claims
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Active" value={activeTotal} />
        <StatCard label="Structured" value={activeStructured.length} color="blue" />
        <StatCard label="Attributed" value={activeAttributed.length} color="amber" />
        <StatCard label="Retracted" value={retractedCount} color={retractedCount > 0 ? "rose" : undefined} />
      </div>

      {/* Brief intro */}
      <p className="text-xs text-muted-foreground mb-6">
        Structured statements are specific data points (revenue, headcount,
        dates) with typed values. Attributed statements are notable claims
        attributed to people or organizations.
      </p>

      {total === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No statements yet</p>
          <p className="text-sm">
            Statements are created by migrating YAML facts or via the statements API.
          </p>
        </div>
      ) : (
        <>
          {/* Current Snapshot — server-rendered */}
          <CurrentSnapshot snapshot={snapshot} conflicts={conflictEntries} />

          {/* Interactive sections — client */}
          <StatementsClient
            structured={resolvedStructured}
            attributed={resolvedAttributed}
            categories={categories}
            entitySlug={slug}
          />
        </>
      )}
    </div>
  );
}
