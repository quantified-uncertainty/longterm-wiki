import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { getEntityById } from "@data";
import type { ClaimRow } from "@wiki-server/api-types";
import { buildEntityNameMap } from "../../components/claims-data";
import { CategoryBadge } from "../../components/category-badge";
import { ConfidenceBadge } from "../../components/confidence-badge";
import { ClaimModeBadge } from "../../components/claim-mode-badge";
import { NumericValueDisplay } from "../../components/numeric-value-display";
import { ClaimSourcesList } from "../../components/claim-sources-list";

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
  const claim = await fetchFromWikiServer<ClaimRow>(`/api/claims/${id}`, {
    revalidate: 300,
  });

  if (!claim) notFound();

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

      {/* Source quote (legacy field) */}
      {claim.sourceQuote && (!claim.sources || claim.sources.length === 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50/50 p-4 mb-4">
          <span className="text-xs font-medium text-amber-700 block mb-1">
            Source Quote
          </span>
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
            Mode
          </span>
          <ClaimModeBadge mode={claim.claimMode} attributedTo={claim.attributedTo} />
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

      {/* Footnote refs */}
      {claim.footnoteRefs && (
        <div className="mb-6">
          <span className="text-xs text-muted-foreground block mb-1">
            Footnote References
          </span>
          <span className="font-mono text-xs">{claim.footnoteRefs}</span>
        </div>
      )}

      {/* Timestamps */}
      <div className="border-t pt-4 text-xs text-muted-foreground">
        <span>
          Created: {claim.createdAt ? new Date(claim.createdAt).toLocaleString() : "-"}
        </span>
        {claim.updatedAt && (
          <span className="ml-4">
            Updated: {new Date(claim.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="mt-4 flex gap-3">
        <Link
          href={`/wiki/${claim.entityId}`}
          className="text-xs text-blue-600 hover:underline"
        >
          View wiki page &rarr;
        </Link>
        <Link
          href={`/wiki/${claim.entityId}/data`}
          className="text-xs text-muted-foreground hover:underline"
        >
          View data page
        </Link>
      </div>
    </div>
  );
}
