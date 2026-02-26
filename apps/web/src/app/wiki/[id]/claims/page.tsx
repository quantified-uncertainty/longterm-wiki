import { notFound } from "next/navigation";
import Link from "next/link";
import type { Metadata } from "next";
import {
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
} from "@/lib/mdx";
import { getPageById } from "@/data";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow, GetClaimsResult } from "@wiki-server/api-types";
import { StatCard } from "@/app/claims/components/stat-card";
import { DistributionBar } from "@/app/claims/components/distribution-bar";
import { ClaimsTable } from "@/app/claims/components/claims-table";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  let slug: string | null;
  if (isNumericId(id)) {
    slug = numericIdToSlug(id.toUpperCase());
  } else {
    slug = id;
  }
  const page = slug ? getPageById(slug) : null;
  const title = page?.title ?? slug ?? id;
  return {
    title: `${title} Claims | Longterm Wiki`,
    description: `Claims extracted from the ${title} wiki page.`,
  };
}

export default async function WikiClaimsPage({ params }: PageProps) {
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

  const result = await fetchFromWikiServer<GetClaimsResult>(
    `/api/claims/by-entity/${encodeURIComponent(slug)}?includeSources=true`,
    { revalidate: 300 }
  );

  const claims = result?.claims ?? [];

  const verified = claims.filter((c) => c.confidence === "verified").length;
  const multiEntity = claims.filter(
    (c) => c.relatedEntities && c.relatedEntities.length > 0
  ).length;

  const verdictVerified = claims.filter((c) => c.claimVerdict === "verified").length;
  const verdictDisputed = claims.filter((c) => c.claimVerdict === "disputed").length;
  const verdictUnsupported = claims.filter((c) => c.claimVerdict === "unsupported").length;
  const hasVerdicts = verdictVerified + verdictDisputed + verdictUnsupported > 0;

  const byCategory: Record<string, number> = {};
  for (const c of claims) {
    const cat = c.claimCategory ?? "uncategorized";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold mb-2">{title} - Claims</h1>
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
            href={`/claims/entity/${slug}`}
            className="text-muted-foreground hover:underline"
          >
            View in Claims Explorer &rarr;
          </Link>
        </div>
      </div>

      {claims.length === 0 ? (
        <div>
          {result === null ? (
            <p className="text-muted-foreground">
              Claims data unavailable (wiki-server offline or not configured).
            </p>
          ) : (
            <p className="text-muted-foreground">
              No claims extracted for this entity yet. Run:{" "}
              <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">
                pnpm crux claims extract {slug}
              </code>
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 mb-6">
            <StatCard label="Total Claims" value={claims.length} />
            {hasVerdicts ? (
              <>
                <StatCard label="Verdict: Verified" value={verdictVerified} />
                <StatCard label="Verdict: Disputed" value={verdictDisputed} />
                <StatCard label="Verdict: Unsupported" value={verdictUnsupported} />
                <StatCard
                  label="Verdict Rate"
                  value={`${Math.round(claims.length > 0 ? ((verdictVerified + verdictDisputed + verdictUnsupported) / claims.length) * 100 : 0)}%`}
                />
              </>
            ) : (
              <>
                <StatCard label="Confidence: Verified" value={verified} />
                <StatCard label="Multi-Entity" value={multiEntity} />
                <StatCard
                  label="Verification Rate"
                  value={`${Math.round(claims.length > 0 ? (verified / claims.length) * 100 : 0)}%`}
                />
              </>
            )}
          </div>

          {Object.keys(byCategory).length > 1 && (
            <div className="rounded-lg border p-4 mb-6">
              <h3 className="text-sm font-semibold mb-3">
                Category Distribution
              </h3>
              <DistributionBar data={byCategory} total={claims.length} />
            </div>
          )}

          <ClaimsTable claims={claims} />
        </>
      )}
    </div>
  );
}
