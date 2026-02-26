import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
} from "@/lib/mdx";
import {
  getPageById,
  getEntityPath,
  getBacklinksFor,
  getFactsForEntityWithFallback,
  getExternalLinks,
  getFootnoteIndex,
  getResourceById,
  getResourceCredibility,
  getEntityHref,
} from "@/data";
import type { FootnoteIndexEntry } from "@/data";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow, GetClaimsResult } from "@wiki-server/api-response-types";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
}

/** Fetch claims for a page from the wiki-server. Returns null if unavailable. */
async function fetchPageClaims(pageId: string): Promise<ClaimRow[] | null> {
  const result = await fetchFromWikiServer<GetClaimsResult>(
    `/api/claims/by-entity/${encodeURIComponent(pageId)}?includeSources=true`,
    { revalidate: 300 }
  );
  return result?.claims ?? null;
}

function Section({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="mb-4 border border-gray-200 rounded">
      <summary className="cursor-pointer px-4 py-2 bg-gray-50 select-none hover:bg-gray-100">
        <span className="font-semibold text-sm">{title}</span>
        {subtitle && (
          <span className="ml-2 text-xs text-gray-400 font-normal">{subtitle}</span>
        )}
      </summary>
      <div className="p-4 overflow-x-auto">{children}</div>
    </details>
  );
}

function JsonDump({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const val = confidence ?? "unverified";
  const colorMap: Record<string, string> = {
    verified: "bg-green-100 text-green-800",
    unverified: "bg-yellow-100 text-yellow-800",
    unsourced: "bg-red-100 text-red-800",
    unsupported: "bg-red-100 text-red-800",
  };
  const cls = colorMap[val] ?? "bg-gray-100 text-gray-800";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {val}
    </span>
  );
}

/**
 * Server-compatible verdict badge — intentionally duplicates the styling from
 * `@/app/claims/components/verdict-badge.tsx` (VerdictBadge).
 *
 * The canonical VerdictBadge is a "use client" component (uses Lucide icons
 * + shadcn Badge), but this page is a React Server Component and cannot import
 * client components without a wrapper. Since the inline version is just a tiny
 * styled <span> with no interactivity, duplicating it here avoids the overhead
 * of a client boundary for a purely visual element.
 */
function VerdictBadgeInline({ verdict, score }: { verdict: string | null; score?: number | null }) {
  if (!verdict) return <span className="text-gray-300">—</span>;
  const colorMap: Record<string, string> = {
    verified: "bg-green-100 text-green-800 border-green-200",
    unsupported: "bg-red-100 text-red-800 border-red-200",
    disputed: "bg-amber-100 text-amber-800 border-amber-200",
    unverified: "bg-gray-100 text-gray-500 border-gray-200",
  };
  const cls = colorMap[verdict] ?? "bg-gray-100 text-gray-500 border-gray-200";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {verdict}
      {score != null && <span className="ml-0.5 opacity-70">({Math.round(score * 100)}%)</span>}
    </span>
  );
}

/** Badge for claim category (factual, opinion, analytical, speculative, relational) */
function CategoryBadge({ category }: { category: string | null }) {
  if (!category) return null;
  const colorMap: Record<string, string> = {
    factual: "bg-blue-50 text-blue-700 border-blue-200",
    opinion: "bg-purple-50 text-purple-700 border-purple-200",
    analytical: "bg-amber-50 text-amber-700 border-amber-200",
    speculative: "bg-orange-50 text-orange-700 border-orange-200",
    relational: "bg-teal-50 text-teal-700 border-teal-200",
  };
  const cls = colorMap[category] ?? "bg-gray-50 text-gray-600 border-gray-200";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}>
      {category}
    </span>
  );
}

/** Render related entity badges as links */
function RelatedEntityBadges({ entities }: { entities: string[] | null }) {
  if (!entities || entities.length === 0) return null;
  return (
    <span className="inline-flex gap-1 flex-wrap">
      {entities.map(eid => (
        <Link
          key={eid}
          href={getEntityHref(eid)}
          className="inline-block px-1 py-0.5 rounded text-[10px] bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900"
          title={`Related entity: ${eid}`}
        >
          {eid}
        </Link>
      ))}
    </span>
  );
}

/** Parse a comma-separated footnote number string (from claim.footnoteRefs). */
function parseFootnoteNums(unit: string | null): number[] {
  if (!unit) return [];
  return unit.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

/** Render a citation badge that links to the source page or URL */
function CitationBadge({ num, fnIndex }: { num: number; fnIndex?: FootnoteIndexEntry }) {
  const entry = fnIndex?.footnotes[num];
  const href = entry?.resourceId
    ? `/source/${entry.resourceId}`
    : entry?.url ?? null;
  const label = `[^${num}]`;

  if (href) {
    return (
      <a
        href={href}
        target={entry?.resourceId ? undefined : "_blank"}
        rel={entry?.resourceId ? undefined : "noopener noreferrer"}
        className="inline-block font-mono text-blue-600 hover:underline mr-1"
        title={entry?.title ?? href}
      >
        {label}
      </a>
    );
  }
  return <span className="inline-block font-mono text-gray-500 mr-1">{label}</span>;
}

/** Credibility dot (1–5 scale) */
function CredDots({ level }: { level: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          key={i}
          className={`inline-block w-1.5 h-1.5 rounded-full ${i <= level ? "bg-green-500" : "bg-gray-200"}`}
        />
      ))}
    </span>
  );
}

type RefEntry = { title: string | null; url: string | null; resourceId?: string; domain?: string };
type SourceEntry = RefEntry & { footnoteNum: number; credibility?: number; claimCount: number };

/** Get the section name for a claim */
function getClaimSection(claim: ClaimRow): string {
  return claim.section ?? "Unknown";
}

/** Get footnote ref string for a claim */
function getClaimFootnoteRefs(claim: ClaimRow): string | null {
  return claim.footnoteRefs ?? null;
}

/** Build shared data structures from claims + footnote index */
function buildClaimsData(claims: ClaimRow[], fnIndex?: FootnoteIndexEntry) {
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    const key = c.claimVerdict ?? c.confidence ?? "unverified";
    byConfidence[key] = (byConfidence[key] ?? 0) + 1;
  }

  const byCategory: Record<string, number> = {};
  for (const c of claims) {
    const cat = c.claimCategory ?? "uncategorized";
    byCategory[cat] = (byCategory[cat] ?? 0) + 1;
  }

  const sections = [...new Set(claims.map(c => getClaimSection(c)))];

  const refMap = new Map<number, RefEntry>();
  if (fnIndex) {
    for (const [numStr, entry] of Object.entries(fnIndex.footnotes)) {
      refMap.set(parseInt(numStr, 10), {
        title: entry.title,
        url: entry.url,
        resourceId: entry.resourceId,
        domain: entry.url ? (() => { try { return new URL(entry.url!).hostname.replace(/^www\./, ""); } catch { return undefined; } })() : undefined,
      });
    }
  }

  const allFootnoteNums = new Set<number>();
  for (const claim of claims) {
    for (const n of parseFootnoteNums(getClaimFootnoteRefs(claim))) allFootnoteNums.add(n);
  }

  const seenUrls = new Set<string>();
  const uniqueSources: SourceEntry[] = [];
  for (const n of allFootnoteNums) {
    const entry = refMap.get(n);
    if (!entry) continue;
    const key = entry.url ?? `footnote-${n}`;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    const resource = entry.resourceId ? getResourceById(entry.resourceId) : undefined;
    const credibility = resource ? getResourceCredibility(resource) : undefined;
    const claimCount = claims.filter(c => parseFootnoteNums(getClaimFootnoteRefs(c)).includes(n)).length;
    uniqueSources.push({ footnoteNum: n, ...entry, credibility, claimCount });
  }
  uniqueSources.sort((a, b) => b.claimCount - a.claimCount);

  // Count multi-entity claims
  const multiEntityCount = claims.filter(c =>
    c.relatedEntities && c.relatedEntities.length > 0
  ).length;

  return { byConfidence, byCategory, sections, refMap, uniqueSources, multiEntityCount };
}

function ClaimsTable({ claims, fnIndex }: { claims: ClaimRow[]; fnIndex?: FootnoteIndexEntry }) {
  const { byConfidence, byCategory, sections, refMap, multiEntityCount } = buildClaimsData(claims, fnIndex);

  return (
    <div>
      {/* Verdict/confidence distribution (prefers claimVerdict, falls back to confidence) */}
      <div className="flex gap-3 mb-3 flex-wrap">
        {Object.entries(byConfidence).map(([v, cnt]) => (
          <div key={v} className="flex items-center gap-1">
            <VerdictBadgeInline verdict={v} />
            <span className="text-xs text-gray-600">{cnt}</span>
          </div>
        ))}
        <span className="text-xs text-gray-500 ml-auto">{claims.length} total claims</span>
      </div>

      {/* Category distribution bar */}
      {Object.keys(byCategory).length > 1 && (
        <div className="flex gap-3 mb-3 flex-wrap">
          {Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([cat, cnt]) => (
            <div key={cat} className="flex items-center gap-1">
              <CategoryBadge category={cat} />
              <span className="text-xs text-gray-600">{cnt}</span>
            </div>
          ))}
          {multiEntityCount > 0 && (
            <span className="text-xs text-gray-500 ml-auto">
              {multiEntityCount} multi-entity
            </span>
          )}
        </div>
      )}

      {/* Section heatmap */}
      {sections.length > 1 && (
        <div className="mb-4">
          <p className="text-xs font-medium text-gray-600 mb-2">Section breakdown:</p>
          <div className="flex flex-wrap gap-2">
            {sections.map(section => {
              const sectionClaims = claims.filter(c => getClaimSection(c) === section);
              const verifiedCount = sectionClaims.filter(c => (c.claimVerdict ?? c.confidence) === "verified").length;
              const pct = sectionClaims.length > 0 ? Math.round((verifiedCount / sectionClaims.length) * 100) : 0;
              const heatColor = pct >= 70 ? "bg-green-100 border-green-300"
                : pct >= 40 ? "bg-yellow-100 border-yellow-300"
                : "bg-red-100 border-red-300";
              return (
                <span key={section} className={`text-xs px-2 py-1 rounded border ${heatColor}`}>
                  {section.slice(0, 30)} ({verifiedCount}/{sectionClaims.length})
                </span>
              );
            })}
          </div>
        </div>
      )}

      <table className="text-xs w-full border-collapse">
        <thead>
          <tr className="border-b text-left bg-gray-50">
            <th className="p-2 w-[24%]">Claim</th>
            <th className="p-2 w-[16%]">Source Quote</th>
            <th className="p-2">Type</th>
            <th className="p-2">Category</th>
            <th className="p-2">Verdict</th>
            <th className="p-2">Section</th>
            <th className="p-2">Sources</th>
            <th className="p-2">Related</th>
            <th className="p-2">Citations</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const footnoteNums = parseFootnoteNums(getClaimFootnoteRefs(claim));
            const firstRef = footnoteNums.length > 0 ? refMap.get(footnoteNums[0]) : null;
            const sectionName = getClaimSection(claim);
            return (
              <tr key={claim.id} className="border-b hover:bg-gray-50 align-top">
                <td className="p-2">
                  {claim.claimText}
                  {claim.factId && (
                    <span className="block mt-0.5 text-[10px] text-gray-400 font-mono" title="Linked to fact system">
                      fact: {claim.factId}
                    </span>
                  )}
                </td>
                <td className="p-2 text-gray-500 italic">
                  {claim.sourceQuote
                    ? <span title={claim.sourceQuote}>&ldquo;{claim.sourceQuote.slice(0, 100)}{claim.sourceQuote.length > 100 ? "…" : ""}&rdquo;</span>
                    : <span className="text-gray-300 not-italic">—</span>}
                </td>
                <td className="p-2 font-mono whitespace-nowrap text-[10px]">{claim.claimType}</td>
                <td className="p-2 whitespace-nowrap">
                  <CategoryBadge category={claim.claimCategory} />
                </td>
                <td className="p-2 whitespace-nowrap">
                  <VerdictBadgeInline verdict={claim.claimVerdict ?? claim.confidence ?? "unverified"} score={claim.claimVerdictScore} />
                </td>
                <td className="p-2 text-gray-600 max-w-[100px] truncate" title={sectionName}>
                  {sectionName}
                </td>
                <td className="p-2 text-[10px]">
                  {claim.sources && claim.sources.length > 0 ? (
                    <div className="space-y-0.5">
                      {claim.sources.slice(0, 2).map(s => (
                        <div key={s.id} className="flex items-center gap-1">
                          {s.isPrimary && (
                            <span className="bg-blue-100 text-blue-700 px-0.5 rounded text-[9px]">P</span>
                          )}
                          {s.resourceId ? (
                            <Link href={`/source/${s.resourceId}`} className="text-blue-600 hover:underline truncate max-w-[80px] block">
                              {s.resourceId}
                            </Link>
                          ) : s.url ? (
                            <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate max-w-[80px] block">
                              {(() => { try { return new URL(s.url).hostname.replace(/^www\./, ""); } catch { return "link"; } })()}
                            </a>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </div>
                      ))}
                      {claim.sources.length > 2 && (
                        <span className="text-gray-400">+{claim.sources.length - 2}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="p-2 max-w-[120px]">
                  <RelatedEntityBadges entities={claim.relatedEntities} />
                  {(!claim.relatedEntities || claim.relatedEntities.length === 0) && (
                    firstRef ? (
                      firstRef.resourceId ? (
                        <Link href={`/source/${firstRef.resourceId}`} className="text-blue-600 hover:underline truncate block text-[10px]" title={firstRef.title ?? ""}>
                          {firstRef.domain ?? firstRef.title?.slice(0, 20) ?? "—"}
                        </Link>
                      ) : firstRef.url ? (
                        <a href={firstRef.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate block text-[10px]" title={firstRef.title ?? ""}>
                          {firstRef.domain ?? "link"}
                        </a>
                      ) : <span className="text-gray-400 text-[10px]">—</span>
                    ) : <span className="text-gray-400 text-[10px]">—</span>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {footnoteNums.length > 0
                    ? footnoteNums.slice(0, 3).map(n => <CitationBadge key={n} num={n} fnIndex={fnIndex} />)
                    : "—"}
                  {footnoteNums.length > 3 && (
                    <span className="text-gray-400 text-[10px]">+{footnoteNums.length - 3}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReferencesTable({ claims, fnIndex }: { claims: ClaimRow[]; fnIndex?: FootnoteIndexEntry }) {
  const { uniqueSources } = buildClaimsData(claims, fnIndex);

  if (uniqueSources.length === 0) {
    return <p className="text-sm text-gray-500">No references found. Citations may not be indexed yet.</p>;
  }

  return (
    <table className="text-xs w-full border-collapse">
      <thead>
        <tr className="border-b text-left bg-gray-50">
          <th className="p-2">Source</th>
          <th className="p-2">Domain</th>
          <th className="p-2">Claims</th>
          <th className="p-2">Credibility</th>
          <th className="p-2">Links</th>
        </tr>
      </thead>
      <tbody>
        {uniqueSources.map(src => (
          <tr key={src.footnoteNum} className="border-b hover:bg-gray-50">
            <td className="p-2 max-w-[280px]">
              {src.url ? (
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={src.url}>
                  {(src.title ?? src.url).slice(0, 70)}{(src.title ?? src.url).length > 70 ? "…" : ""}
                </a>
              ) : (
                <span>{src.title ?? "—"}</span>
              )}
            </td>
            <td className="p-2 text-gray-500">{src.domain ?? "—"}</td>
            <td className="p-2 text-center">{src.claimCount}</td>
            <td className="p-2">
              {src.credibility != null ? <CredDots level={src.credibility} /> : <span className="text-gray-400">—</span>}
            </td>
            <td className="p-2 whitespace-nowrap">
              {src.resourceId && (
                <Link href={`/source/${src.resourceId}`} className="text-blue-600 hover:underline mr-2">
                  source page
                </Link>
              )}
              {src.url && (
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:underline text-[10px]">
                  ↗ original
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default async function WikiInfoPage({ params }: PageProps) {
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
  const entityPath = getEntityPath(slug);
  const backlinks = getBacklinksFor(slug);
  const facts = (await getFactsForEntityWithFallback(slug)).data;
  const externalLinks = getExternalLinks(slug);
  const fnIndex = getFootnoteIndex(slug);
  const claims = await fetchPageClaims(slug);

  const title = pageData?.title || slug;
  const entityType = pageData?.entityType || null;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-3 mb-2">
          <div className="flex-1">
            <h1 className="text-2xl font-bold mb-1">{title}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              <span className="font-mono text-gray-500">{slug}</span>
              {entityType && (
                <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">{entityType}</span>
              )}
              {entityPath && (
                <span className="text-gray-400 text-xs">Path: {entityPath}</span>
              )}
            </div>
          </div>
          {/* EID — the canonical numeric entity identifier used in URLs and EntityLink refs */}
          {numericId && (
            <div className="shrink-0 flex flex-col items-end gap-1">
              <span className="font-mono text-2xl font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-1 rounded-lg select-all">
                {numericId}
              </span>
              <span className="text-[10px] text-gray-400 uppercase tracking-wide">Entity ID (EID)</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-4 text-sm mt-3">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Back to page
          </Link>
          <span className="text-gray-400">
            {Object.keys(facts).length} facts
            {" · "}
            {backlinks.length} backlinks
            {claims !== null && ` · ${claims.length} claims`}
          </span>
          {pageData?.quality != null && (
            <span className="text-gray-500">
              Quality: <span className="font-medium">{pageData.quality}</span>
            </span>
          )}
          {pageData?.lastUpdated && (
            <span className="text-gray-500">
              Updated: <span className="font-medium">{pageData.lastUpdated}</span>
            </span>
          )}
        </div>
      </div>

      <Section
        title="Page Record"
        subtitle="database.json — merged from MDX frontmatter + Entity YAML + computed metrics at build time"
        defaultOpen
      >
        {pageData
          ? <JsonDump data={pageData} />
          : <p className="text-sm text-gray-500">No compiled record found for &quot;{slug}&quot;</p>}
      </Section>

      <Section title={`Claims ${claims && claims.length > 0 ? `(${claims.length})` : ""}`}>
        {claims === null ? (
          <p className="text-sm text-gray-500">
            Claims data unavailable (wiki-server offline or not configured).{" "}
            <span className="font-mono text-xs">Set LONGTERMWIKI_SERVER_URL to enable.</span>
          </p>
        ) : claims.length === 0 ? (
          <p className="text-sm text-gray-500">
            No claims extracted yet. Run:{" "}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">pnpm crux claims extract {slug}</code>
          </p>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-3 text-sm">
              <Link
                href={`/wiki/${numericId || slug}/claims`}
                className="text-blue-600 hover:underline font-medium"
              >
                View full claims tab &rarr;
              </Link>
              <Link
                href={`/claims/entity/${slug}`}
                className="text-muted-foreground hover:underline"
              >
                Claims Explorer
              </Link>
            </div>
            <ClaimsTable claims={claims} fnIndex={fnIndex} />
          </div>
        )}
      </Section>

      <Section title={`References ${claims && claims.length > 0 ? `(${buildClaimsData(claims, fnIndex).uniqueSources.length})` : ""}`}>
        {claims === null ? (
          <p className="text-sm text-gray-500">
            Claims data unavailable (wiki-server offline or not configured).
          </p>
        ) : claims.length === 0 ? (
          <p className="text-sm text-gray-500">No claims extracted yet — run claims extract first.</p>
        ) : (
          <div>
            <div className="flex items-center gap-3 mb-3 text-sm">
              <Link
                href={`/wiki/${numericId || slug}/claims`}
                className="text-blue-600 hover:underline font-medium"
              >
                View full claims tab &rarr;
              </Link>
              <Link
                href={`/claims/entity/${slug}`}
                className="text-muted-foreground hover:underline"
              >
                Claims Explorer
              </Link>
            </div>
            <ReferencesTable claims={claims} fnIndex={fnIndex} />
          </div>
        )}
      </Section>

      <Section title={`Canonical Facts (${Object.keys(facts).length})`}>
        {Object.keys(facts).length > 0 ? (
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">factId</th>
                <th className="p-2">value</th>
                <th className="p-2">numeric</th>
                <th className="p-2">asOf</th>
                <th className="p-2">source</th>
                <th className="p-2">note</th>
                <th className="p-2">computed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(facts).map(([factId, fact]) => (
                <tr key={factId} className="border-b">
                  <td className="p-2 font-mono">{factId}</td>
                  <td className="p-2">{fact.value ?? "—"}</td>
                  <td className="p-2">{fact.numeric ?? "—"}</td>
                  <td className="p-2">{fact.asOf ?? "—"}</td>
                  <td className="p-2 max-w-[200px] truncate">{fact.source ?? "—"}</td>
                  <td className="p-2 max-w-[200px] truncate">{fact.note ?? "—"}</td>
                  <td className="p-2">{fact.computed ? "yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No facts for this entity</p>
        )}
      </Section>

      <Section title="External Links">
        {externalLinks
          ? <JsonDump data={externalLinks} />
          : <p className="text-sm text-gray-500">No external links</p>}
      </Section>

      <Section title={`Backlinks (${backlinks.length})`}>
        {backlinks.length > 0 ? (
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">id</th>
                <th className="p-2">title</th>
                <th className="p-2">type</th>
                <th className="p-2">relationship</th>
              </tr>
            </thead>
            <tbody>
              {backlinks.map((bl) => (
                <tr key={bl.id} className="border-b">
                  <td className="p-2 font-mono">{bl.id}</td>
                  <td className="p-2">
                    <Link href={bl.href} className="text-blue-600 hover:underline">
                      {bl.title}
                    </Link>
                  </td>
                  <td className="p-2">{bl.type}</td>
                  <td className="p-2">{bl.relationship ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No backlinks</p>
        )}
      </Section>

    </div>
  );
}
