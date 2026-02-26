import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById, getEntityHref } from "@data";
import type { ClaimRow, SimilarClaimsResult } from "@wiki-server/api-types";
import { buildEntityNameMap } from "../../components/claims-data";
import { CategoryBadge } from "../../components/category-badge";
import { ConfidenceBadge } from "../../components/confidence-badge";
import { ClaimModeBadge } from "../../components/claim-mode-badge";
import { NumericValueDisplay } from "../../components/numeric-value-display";
import { ClaimSourcesList } from "../../components/claim-sources-list";
import { VerdictBadge } from "../../components/verdict-badge";
import {
  ClaimPageReferences,
  type PageReference,
} from "../../components/claim-page-references";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const claim = await fetchFromWikiServer<ClaimRow>(`/api/claims/${id}`, {
    revalidate: 300,
  });
  if (!claim) return { title: "Claim Not Found" };
  return {
    title: `Claim #${claim.id}`,
    description: claim.claimText.slice(0, 160),
  };
}

export default async function ClaimDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [claim, pageRefsResult, similarResult] = await Promise.all([
    fetchFromWikiServer<ClaimRow>(`/api/claims/${id}?includeSources=true`, {
      revalidate: 300,
    }),
    fetchFromWikiServer<{ references: PageReference[] }>(
      `/api/claims/${id}/page-references`,
      { revalidate: 300 }
    ),
    fetchFromWikiServer<SimilarClaimsResult>(`/api/claims/${id}/similar?limit=5`, {
      revalidate: 300,
    }),
  ]);

  if (!claim) notFound();

  const pageReferences = pageRefsResult?.references ?? [];
  const similarClaims = similarResult?.claims ?? [];
  const entity = getEntityById(claim.entityId);
  const entityDisplayName = entity?.title ?? claim.entityId;
  const allSlugs = [claim.entityId, ...(claim.relatedEntities ?? []).map(s => s.toLowerCase())];
  const entityNames = buildEntityNameMap(allSlugs);

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <div className="flex items-center gap-2 text-xs text-muted-foreground mb-2">
          <Link href="/claims/explore" className="hover:underline">
            Claims
          </Link>
          <span>/</span>
          <Link
            href={`/claims/entity/${claim.entityId}`}
            className="hover:underline"
          >
            {entityDisplayName}
          </Link>
          <span>/</span>
          <span>#{claim.id}</span>
        </div>
        <h1 className="text-xl font-bold mb-3">Claim #{claim.id}</h1>
      </div>

      {/* Claim text */}
      <div className="rounded-lg border p-4 mb-4">
        <p className="text-sm leading-relaxed">{claim.claimText}</p>
      </div>

      {/* Verdict — show if claimVerdict populated, or fallback to legacy confidence+sourceQuote */}
      {(claim.claimVerdict || (claim.confidence && claim.confidence !== 'unverified')) && (
        <div className="rounded-lg border p-4 mb-4 space-y-2">
          <h3 className="text-sm font-medium text-muted-foreground">Verification</h3>
          <div className="flex items-center gap-2">
            {claim.claimVerdict ? (
              <VerdictBadge
                verdict={claim.claimVerdict}
                score={claim.claimVerdictScore}
              />
            ) : (
              <ConfidenceBadge confidence={claim.confidence ?? "unverified"} />
            )}
            {claim.claimVerdictDifficulty && (
              <span className="text-xs text-muted-foreground">
                Difficulty: {claim.claimVerdictDifficulty}
              </span>
            )}
          </div>
          {claim.claimVerdictIssues && (
            <p className="text-sm text-muted-foreground">
              {claim.claimVerdictIssues}
            </p>
          )}
          {/* Show source quote from verdict fields or legacy field */}
          {(claim.claimVerdictQuotes || claim.sourceQuote) && (
            <div className="rounded border border-amber-200 bg-amber-50/50 p-3">
              <span className="text-xs font-medium text-amber-700 block mb-1">
                Source Quote
              </span>
              <p className="text-sm italic text-amber-900">
                &ldquo;{claim.claimVerdictQuotes || claim.sourceQuote}&rdquo;
              </p>
            </div>
          )}
          <div className="flex gap-4 text-xs text-muted-foreground">
            {claim.claimVerdictModel && (
              <span>Model: {claim.claimVerdictModel}</span>
            )}
            {claim.claimVerifiedAt && (
              <span>
                Verified:{" "}
                {new Date(claim.claimVerifiedAt).toLocaleDateString("en-US", {
                  year: "numeric",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </div>
        </div>
      )}

      {/* Epistemic mode banner (attributed only) */}
      {claim.claimMode === "attributed" && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-3 mb-4 flex items-center gap-3">
          <ClaimModeBadge mode={claim.claimMode} attributedTo={claim.attributedTo} />
          {claim.attributedTo && (
            <span className="text-sm text-amber-800">
              This claim is attributed to{" "}
              <Link
                href={`/claims/entity/${claim.attributedTo}`}
                className="font-medium hover:underline"
              >
                {claim.attributedTo}
              </Link>
              , not asserted by the wiki.
            </span>
          )}
        </div>
      )}

      {/* Source quote (legacy field — only shown when no claim_sources entries exist) */}
      {/* @deprecated Prefer claim.sources[] (from claim_sources table) over claim.sourceQuote */}
      {claim.sourceQuote && (!claim.sources || claim.sources.length === 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 mb-4">
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs font-medium text-amber-700">
              Source Quote
            </span>
            <Link
              href={getEntityHref(claim.entityId)}
              className="text-xs text-amber-600 hover:underline"
            >
              From wiki page &rarr;
            </Link>
          </div>
          <p className="text-sm italic text-amber-900">
            &ldquo;{claim.sourceQuote}&rdquo;
          </p>
        </div>
      )}

      {/* claim_sources */}
      {claim.sources && claim.sources.length > 0 && (
        <div className="mb-6">
          <span className="text-xs font-medium text-muted-foreground block mb-2">
            Sources ({claim.sources.length})
          </span>
          <ClaimSourcesList sources={claim.sources} />
        </div>
      )}

      {/* Numeric value — show if any numeric field is present (central, low, or high) */}
      {(claim.valueNumeric != null || claim.valueLow != null || claim.valueHigh != null) && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50/30 p-4 mb-4">
          <span className="text-xs font-medium text-emerald-700 block mb-1">
            Numeric Value
          </span>
          <NumericValueDisplay
            value={claim.valueNumeric}
            low={claim.valueLow}
            high={claim.valueHigh}
            measure={claim.measure}
          />
        </div>
      )}

      {/* Structured data */}
      {claim.property && (
        <div className="rounded-lg border border-violet-200 bg-violet-50/30 p-4 mb-4">
          <span className="text-xs font-medium text-violet-700 block mb-2">
            Structured Data
          </span>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {claim.subjectEntity && (
              <div>
                <span className="text-xs text-muted-foreground block">Subject</span>
                <Link
                  href={`/claims/entity/${claim.subjectEntity}`}
                  className="font-mono text-blue-600 hover:underline"
                >
                  {claim.subjectEntity}
                </Link>
              </div>
            )}
            <div>
              <span className="text-xs text-muted-foreground block">Property</span>
              <span className="font-mono">{claim.property}</span>
            </div>
            {claim.structuredValue && (
              <div>
                <span className="text-xs text-muted-foreground block">Value</span>
                <span className="font-mono">{claim.structuredValue}</span>
                {claim.valueUnit && (
                  <span className="text-xs text-muted-foreground ml-1">
                    ({claim.valueUnit})
                  </span>
                )}
              </div>
            )}
            {claim.valueDate && (
              <div>
                <span className="text-xs text-muted-foreground block">Date</span>
                <span className="font-mono">{claim.valueDate}</span>
              </div>
            )}
            {claim.qualifiers && Object.keys(claim.qualifiers).length > 0 && (
              <div className="col-span-2 md:col-span-3">
                <span className="text-xs text-muted-foreground block">Qualifiers</span>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(claim.qualifiers).map(([k, v]) => (
                    <span key={k} className="font-mono text-xs px-1.5 py-0.5 rounded bg-violet-100 text-violet-700">
                      {k}={v}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Metadata grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
        <div>
          <span className="text-xs text-muted-foreground block mb-1">
            Entity
          </span>
          <Link
            href={`/claims/entity/${claim.entityId}`}
            className="text-sm text-blue-600 hover:underline"
          >
            {entityDisplayName}
          </Link>
          <span className="text-xs text-muted-foreground ml-2">
            ({claim.entityType})
          </span>
        </div>
        <div>
          <span className="text-xs text-muted-foreground block mb-1">
            Epistemic Status
          </span>
          {(!claim.claimMode || claim.claimMode === "endorsed") ? (
            <span className="text-xs text-muted-foreground">Stated as fact</span>
          ) : (
            <ClaimModeBadge mode={claim.claimMode} attributedTo={claim.attributedTo} />
          )}
        </div>
        <div>
          <span className="text-xs text-muted-foreground block mb-1">
            Category
          </span>
          <CategoryBadge
            category={claim.claimCategory ?? "uncategorized"}
          />
        </div>
        <div>
          <span className="text-xs text-muted-foreground block mb-1">
            Confidence
          </span>
          <ConfidenceBadge
            confidence={claim.confidence ?? "unverified"}
          />
        </div>
        <div>
          <span className="text-xs text-muted-foreground block mb-1">
            Claim Type
          </span>
          <span className="font-mono text-sm">{claim.claimType}</span>
        </div>
        {claim.asOf && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">
              As Of
            </span>
            <span className="text-sm font-mono">{claim.asOf}</span>
          </div>
        )}
        {claim.measure && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">
              Measure
            </span>
            <span className="text-sm font-mono">{claim.measure}</span>
          </div>
        )}
        {claim.section && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">
              Section
            </span>
            <span className="text-sm">{claim.section}</span>
          </div>
        )}
        {claim.factId && (
          <div>
            <span className="text-xs text-muted-foreground block mb-1">
              Linked Fact
            </span>
            <span className="font-mono text-sm">{claim.factId}</span>
          </div>
        )}
      </div>

      {/* Related entities */}
      {claim.relatedEntities && claim.relatedEntities.length > 0 && (
        <div className="mb-6">
          <span className="text-xs text-muted-foreground block mb-2">
            Related Entities
          </span>
          <div className="flex flex-wrap gap-2">
            {claim.relatedEntities.map((eid) => (
              <Link
                key={eid}
                href={`/claims/entity/${eid.toLowerCase()}`}
                className="inline-block px-2 py-1 rounded text-xs bg-gray-100 text-gray-700 hover:bg-gray-200"
              >
                {entityNames[eid.toLowerCase()] ?? eid}
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Page references */}
      {pageReferences.length > 0 && (
        <div className="mb-6">
          <span className="text-xs text-muted-foreground block mb-2">
            Page References ({pageReferences.length})
          </span>
          <ClaimPageReferences references={pageReferences} />
        </div>
      )}

      {/* Footnote refs (legacy — hidden when page references exist) */}
      {claim.footnoteRefs && pageReferences.length === 0 && (
        <div className="mb-6">
          <span className="text-xs text-muted-foreground block mb-1">
            Wiki Page Citations
          </span>
          <div className="flex flex-wrap gap-1">
            {claim.footnoteRefs.split(",").map((ref) => {
              const num = ref.trim();
              return (
                <Link
                  key={num}
                  href={`${getEntityHref(claim.entityId)}#fn-${num}`}
                  className="font-mono text-xs px-1.5 py-0.5 rounded bg-gray-100 text-blue-600 hover:bg-gray-200 hover:underline"
                >
                  [{num}]
                </Link>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Footnote numbers from the source wiki page (legacy)
          </p>
        </div>
      )}

      {/* Similar Claims */}
      {similarClaims.length > 0 && (
        <div className="mb-6">
          <span className="text-xs font-medium text-muted-foreground block mb-2">
            Similar Claims
          </span>
          <div className="space-y-2">
            {similarClaims.map((sc) => (
              <Link
                key={sc.id}
                href={`/claims/claim/${sc.id}`}
                className="block rounded-lg border p-3 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-mono text-xs text-muted-foreground">
                    #{sc.id}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {Math.round(sc.similarityScore * 100)}% match
                  </span>
                  {sc.claimCategory && (
                    <CategoryBadge category={sc.claimCategory} />
                  )}
                  <span className="text-xs text-muted-foreground ml-auto">
                    {sc.entityId}
                  </span>
                </div>
                <p className="text-sm text-foreground line-clamp-2">
                  {sc.claimText}
                </p>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* Timestamps */}
      <div className="border-t pt-4 text-xs text-muted-foreground">
        <span>
          Created: {claim.createdAt ? new Date(claim.createdAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }) : "-"}
        </span>
        {claim.updatedAt && (
          <span className="ml-4">
            Updated: {new Date(claim.updatedAt).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" })}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex gap-3">
        <Link
          href={getEntityHref(claim.entityId)}
          className="text-xs text-blue-600 hover:underline"
        >
          View wiki page &rarr;
        </Link>
        <Link
          href={`${getEntityHref(claim.entityId)}/data`}
          className="text-xs text-muted-foreground hover:underline"
        >
          View data page
        </Link>
      </div>
    </div>
  );
}
