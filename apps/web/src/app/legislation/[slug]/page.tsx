import { Suspense } from "react";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { CoveragePopover } from "@/components/coverage/CoveragePopover";
import { computeLegislationCoverage, getLegislationSignals } from "@/components/coverage/coverage-score";
import { ProfileTabs, type ProfileTab } from "@/components/directory/ProfileTabs";
import { RelatedPages } from "@/components/RelatedPages";
import { FBAutoFacts } from "@/components/wiki/factbase/FBAutoFacts";
import { getEntityHref } from "@/data/entity-nav";
import { getTypedEntityById } from "@/data";
import {
  getResourcesForPage,
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
} from "@/data/tablebase";
import { OrgResourcesSection } from "@/app/organizations/[slug]/resources-section";
import { resolveResourceAuthors, type OrgResourceRow } from "@/app/organizations/[slug]/org-data";

import {
  resolvePolicyBySlug,
  getPolicySlugs,
  getCustomField,
  getRelatedPolicies,
  resolveEntityHref,
  getPolicyWikiHref,
  getPolicyScope,
  deriveStatus,
} from "../legislation-utils";
import {
  STATUS_COLORS,
  SCOPE_COLORS,
  normalizeStatus,
} from "../legislation-constants";
import { formatIntroducedDate } from "@/lib/format-compact";
import { extractDomain, extractDateFromUrl } from "@/lib/resource-types";
import { UnifiedTimelineView } from "@/app/legislation/[slug]/unified-timeline";
import {
  buildUnifiedTimeline,
  type RawResource,
} from "@/app/legislation/[slug]/timeline-utils";
import { parseDisplayDateToISO } from "@/app/legislation/[slug]/date-utils";
import { getPolicyStakeholderId, getRecordVerdict } from "@data/tablebase";
import { StakeholderTable, type StakeholderRow } from "./stakeholder-table";
import { ProvisionCard } from "./provision-card";
import { getSourceDisplayName } from "../source-display-names";
import { LegislationVotes, fetchLegislationVotes } from "@/components/political";

export function generateStaticParams() {
  return getPolicySlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolvePolicyBySlug(slug);
  return {
    title: entity
      ? `${entity.title} | Legislation`
      : "Legislation Not Found",
    description: entity?.description ?? undefined,
  };
}

/** Resolve verification verdict for a stakeholder (server-side only). */
function resolveVerdict(
  policyStableId: string | undefined,
  stakeholderName: string,
): { verdict: string; confidence: number | null } | null {
  if (!policyStableId) return null;
  const stakeholderId = getPolicyStakeholderId(policyStableId, stakeholderName);
  if (!stakeholderId) return null;
  const v = getRecordVerdict("policy-stakeholder", stakeholderId);
  if (!v) return null;
  return { verdict: v.verdict, confidence: v.confidence };
}

/** Status pipeline stages for the visual timeline. */
const PIPELINE_STAGES = [
  { key: "introduced", label: "Introduced" },
  { key: "committee", label: "Committee" },
  { key: "floor", label: "Floor Vote" },
  { key: "passed", label: "Passed" },
  { key: "executive", label: "Executive" },
] as const;

function getReachedStage(timelineEvents: Array<{ label: string }>, statusKey: string | null): number {
  const labels = new Set(timelineEvents.map((e) => e.label));
  // Stage 4: Final / enacted
  if (statusKey === "vetoed" || statusKey === "enacted" || statusKey === "in-effect" || statusKey === "revoked"
    || labels.has("Signed") || labels.has("Vetoed") || labels.has("Enacted")
    || labels.has("Entry into Force") || labels.has("Enforcement")
    || labels.has("Effective") || labels.has("In Force")) return 4;
  // Stage 3: Passed legislative body
  if (labels.has("Passed Legislature") || labels.has("Passed Assembly") || labels.has("Passed Senate")
    || labels.has("Parliament Final Vote") || labels.has("Council Adoption")) return 3;
  // Stage 2: Committee / negotiation stage
  if (labels.has("Passed Committee")
    || labels.has("Parliament Committee Vote") || labels.has("Parliament Negotiating Mandate")) return 2;
  // Stage 0: Introduced / proposed
  if (labels.has("Introduced") || labels.has("Proposed")) return 0;
  return -1;
}

/** Async child component so vote fetching doesn't block page render. */
async function LegislationVotesSection({ entityId }: { entityId: string }) {
  const votes = await fetchLegislationVotes(entityId);
  return <LegislationVotes votes={votes} />;
}

export default async function LegislationDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolvePolicyBySlug(slug);
  if (!entity) return notFound();

  const introduced = entity.introduced ?? null;
  const author = entity.author ?? null;
  const rawStatus = deriveStatus(entity);
  const statusKey = normalizeStatus(rawStatus);
  const scope = getPolicyScope(entity);
  const billNumber = entity.billNumber ?? null;
  const jurisdiction = entity.jurisdiction ?? null;

  const TIMELINE_LABELS = new Set([
    // US legislative process
    "Introduced", "Passed Legislature", "Passed Committee", "Passed Senate",
    "Passed Assembly", "Signed", "Vetoed", "Enacted", "Effective", "Amended", "In Force",
    // EU legislative process
    "Proposed", "Parliament Committee Vote", "Parliament Negotiating Mandate",
    "Parliament Final Vote", "Council Adoption", "Entry into Force", "Enforcement",
  ]);
  const timelineEvents = entity.customFields
    .filter((f) => TIMELINE_LABELS.has(f.label))
    .map((f) => ({ label: f.label, value: f.value }));

  const relatedPolicies = getRelatedPolicies(entity);
  const relatedEntities = entity.relatedEntries
    .filter((r) => r.type !== "policy")
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), relationship: r.relationship, type: ent.entityType };
    })
    .filter(Boolean) as Array<{ name: string; href: string; relationship?: string; type?: string }>;

  const wikiHref = getPolicyWikiHref(entity);

  const importanceOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const byImportance = <T extends { importance?: string }>(a: T, b: T) =>
    (importanceOrder[a.importance ?? ""] ?? 3) - (importanceOrder[b.importance ?? ""] ?? 3);

  // Convert raw stakeholders to StakeholderRow with resolved hrefs, source names, and verdicts
  const toRow = (s: (typeof entity.stakeholders)[number]): StakeholderRow => ({
    name: s.name,
    entityId: s.entityId,
    position: s.position,
    role: s.role,
    importance: s.importance,
    reason: s.reason,
    source: s.source,
    sourceName: s.source ? getSourceDisplayName(s.source) : undefined,
    context: s.context,
    href: resolveEntityHref(s.entityId),
    verdict: resolveVerdict(entity.stableId, s.name),
  });

  const supporters = entity.stakeholders.filter((s) => s.position === "support").sort(byImportance).map(toRow);
  const opponents = entity.stakeholders.filter((s) => s.position === "oppose").sort(byImportance).map(toRow);
  const mixed = entity.stakeholders.filter((s) => s.position === "mixed" || s.position === "neutral").sort(byImportance).map(toRow);

  const provisionsByCategory = new Map<string, typeof entity.provisions>();
  for (const p of entity.provisions) {
    const cat = p.category ?? "General";
    if (!provisionsByCategory.has(cat)) provisionsByCategory.set(cat, []);
    provisionsByCategory.get(cat)!.push(p);
  }

  const reachedStage = getReachedStage(timelineEvents, statusKey);

  // Only show the pipeline bar if the entity has actual legislative process data.
  // The pipeline stages (Introduced -> Committee -> Floor Vote -> Passed -> Executive)
  // only apply to bills/acts that went through a legislature. Diplomatic declarations
  // (e.g., Bletchley Declaration) may have "votes" (signings) and executive agency
  // actions (e.g., export controls) may have "amendments" (revisions), but these are
  // not legislative processes. We require either:
  // 1. Timeline events from customFields (e.g., "Introduced", "Passed Committee"), OR
  // 2. A billNumber (which indicates formal legislation/regulation with a tracked process)
  // This prevents showing the pipeline for declarations, agency actions, and frameworks
  // while preserving it for bills that have votes but no customField timeline labels.
  const hasLegislativeProcessData =
    timelineEvents.length > 0 || !!billNumber;
  const showPipelineBar = reachedStage >= 0 && hasLegislativeProcessData;

  // ── Build tabs ────────────────────────────────────────────
  const tabs: ProfileTab[] = [];

  // ── Sidebar content (only rendered inside Overview tab) ──────
  const sidebarContent = (
    <div className="space-y-6">
      <section className="rounded-xl border border-border p-4 space-y-3">
        <h3 className="text-sm font-bold">Quick Facts</h3>
        <dl className="space-y-2 text-sm">
          {billNumber && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Bill Number</dt><dd className="font-semibold">{billNumber}</dd></div>}
          {jurisdiction && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Jurisdiction</dt><dd>{jurisdiction}</dd></div>}
          {entity.session && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Session</dt><dd>{entity.session}</dd></div>}
          {author && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Author / Sponsor</dt><dd>{author}</dd></div>}
          {introduced && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Introduced</dt><dd>{formatIntroducedDate(introduced)}</dd></div>}
          {statusKey && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Status</dt><dd className="capitalize">{statusKey}</dd></div>}
          {scope && <div><dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Scope</dt><dd>{scope}</dd></div>}
        </dl>
      </section>
      {entity.stakeholders.length > 0 && (
        <section className="rounded-xl border border-border p-4">
          <h3 className="text-sm font-bold mb-3">Position Summary</h3>
          <div className="space-y-2">
            {supporters.length > 0 && <div className="flex items-center justify-between text-sm"><span className="text-green-700 dark:text-green-400 font-medium">Support</span><span className="tabular-nums font-semibold">{supporters.length}</span></div>}
            {opponents.length > 0 && <div className="flex items-center justify-between text-sm"><span className="text-red-700 dark:text-red-400 font-medium">Oppose</span><span className="tabular-nums font-semibold">{opponents.length}</span></div>}
            {mixed.length > 0 && <div className="flex items-center justify-between text-sm"><span className="text-amber-700 dark:text-amber-400 font-medium">Mixed</span><span className="tabular-nums font-semibold">{mixed.length}</span></div>}
            <div className="flex rounded-full overflow-hidden h-2 mt-1">
              {supporters.length > 0 && <div className="bg-green-500" style={{ width: `${(supporters.length / entity.stakeholders.length) * 100}%` }} />}
              {mixed.length > 0 && <div className="bg-amber-500" style={{ width: `${(mixed.length / entity.stakeholders.length) * 100}%` }} />}
              {opponents.length > 0 && <div className="bg-red-500" style={{ width: `${(opponents.length / entity.stakeholders.length) * 100}%` }} />}
            </div>
          </div>
        </section>
      )}
      {entity.tags.length > 0 && (
        <section className="rounded-xl border border-border p-4">
          <h3 className="text-sm font-bold mb-3">Tags</h3>
          <div className="flex flex-wrap gap-1.5">
            {entity.tags.map((tag) => (
              <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">{tag}</span>
            ))}
          </div>
        </section>
      )}
    </div>
  );

  // Overview tab (always present)
  const overviewContent = (
    <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-8">
      <div className="space-y-6">
        {/* Description */}
        {entity.description && (
          <p className="text-sm text-muted-foreground leading-relaxed max-w-prose">{entity.description}</p>
        )}
        {/* Status pipeline */}
        {showPipelineBar && (
        <div className="flex items-center gap-1 overflow-x-auto pb-2">
          {PIPELINE_STAGES.map((stage, i) => {
            const reached = i <= reachedStage;
            const isFinal = i === 4;
            const isVetoed = isFinal && statusKey === "vetoed";
            const isRevoked = isFinal && statusKey === "revoked";
            const isEnacted = isFinal && (statusKey === "enacted" || statusKey === "in-effect");
            return (
              <div key={stage.key} className="flex items-center gap-1 flex-1 min-w-0">
                <div className={`flex-1 rounded-lg px-3 py-2 text-center text-xs font-semibold transition-colors ${
                  isVetoed ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                    : isRevoked ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                    : isEnacted ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                    : reached ? "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300"
                    : "bg-muted/50 text-muted-foreground/50"
                }`}>
                  {isFinal && isVetoed ? "Vetoed" : isFinal && isRevoked ? "Revoked" : isFinal && isEnacted ? "Enacted" : stage.label}
                </div>
                {i < PIPELINE_STAGES.length - 1 && (
                  <div className={`w-4 h-0.5 shrink-0 ${i < reachedStage ? "bg-violet-300 dark:bg-violet-700" : "bg-border"}`} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Veto Reason */}
      {entity.vetoReason && (
        <section>
          <h2 className="text-lg font-bold mb-3">Veto Rationale</h2>
          <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-4">
            <p className="text-sm leading-relaxed">{entity.vetoReason}</p>
          </div>
        </section>
      )}

      {/* Related Legislation */}
      {relatedPolicies.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-3">Related Legislation</h2>
          <div className="rounded-xl border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-left py-2 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {relatedPolicies.map(({ entity: rel }) => {
                  const relStatus = normalizeStatus(deriveStatus(rel));
                  return (
                    <tr key={rel.id} className="hover:bg-muted/20">
                      <td className="py-2 px-3">
                        <Link href={getEntityHref(rel.id)} className="text-primary hover:underline font-medium">
                          {rel.title}
                        </Link>
                      </td>
                      <td className="py-2 px-3">
                        {relStatus ? (
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${STATUS_COLORS[relStatus] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"}`}>
                            {relStatus}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40">&mdash;</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Related Topics + Wiki Pages */}
      {relatedEntities.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-3">Related Topics</h2>
          <div className="flex flex-wrap gap-2">
            {relatedEntities.map((ref) => (
              <Link key={ref.href} href={ref.href} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-sm transition-colors">
                {ref.type && <span className="text-[9px] uppercase tracking-wider text-muted-foreground/60 font-semibold">{ref.type === "organization" ? "org" : ref.type}</span>}
                <span className="font-medium">{ref.name}</span>
              </Link>
            ))}
          </div>
        </section>
      )}

      {/* Key Politicians */}
      {entity.keyPoliticians.length > 0 && (
        <section>
          <h2 className="text-lg font-bold mb-4">Key Politicians</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {entity.keyPoliticians.map((politician, i) => {
              const href = resolveEntityHref(politician.entityId);
              return (
                <div key={i} className="rounded-lg border border-border/60 bg-card p-3 flex items-center gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-violet-500/20 to-violet-500/5 flex items-center justify-center text-sm font-bold text-violet-600 dark:text-violet-400">
                    {politician.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                  </div>
                  <div>
                    {href ? (
                      <Link href={href} className="font-medium text-sm text-primary hover:underline">{politician.name}</Link>
                    ) : (
                      <span className="font-medium text-sm">{politician.name}</span>
                    )}
                    <div className="text-xs text-muted-foreground">{politician.role}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <Suspense fallback={<div className="text-sm text-muted-foreground">Loading votes...</div>}>
        <LegislationVotesSection entityId={entity.stableId ?? entity.id} />
      </Suspense>

      <FBAutoFacts entityId={entity.id} />

      <RelatedPages entityId={entity.id} entity={{ entityType: "policy" }} />
      </div>
      {sidebarContent}
    </div>
  );
  tabs.push({ id: "overview", label: "Overview", content: overviewContent });

  // Provisions tab
  if (entity.provisions.length > 0) {
    tabs.push({
      id: "provisions",
      label: "Provisions",
      count: entity.provisions.length,
      content: (
        <div className="space-y-6">
          {[...provisionsByCategory.entries()].map(([category, provisions]) => (
            <div key={category}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60 mb-1 px-4">
                {category}
              </h3>
              <div className="space-y-0">
                {provisions.map((provision, i) => (
                  <ProvisionCard
                    key={i}
                    title={provision.title}
                    description={provision.description}
                    billSection={provision.billSection}
                    details={provision.details}
                    billQuote={provision.billQuote}
                    amendmentNotes={provision.amendmentNotes}
                    fullTextUrl={entity.fullTextUrl}
                  />
                ))}
              </div>
            </div>
          ))}
          {entity.fullTextUrl && (
            <div className="px-4 pt-2 border-t border-border/30">
              <a
                href={entity.fullTextUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground/40 hover:text-primary transition-colors"
              >
                Full enrolled bill text &rarr;
              </a>
            </div>
          )}
        </div>
      ),
    });
  }

  // Stakeholders tab
  if (entity.stakeholders.length > 0) {
    tabs.push({
      id: "stakeholders",
      label: "Stakeholders",
      count: entity.stakeholders.length,
      content: (
        <div className="space-y-6">
          {/* Position summary bar */}
          <div className="flex items-center gap-4 text-sm">
            {supporters.length > 0 && <span className="text-green-700 dark:text-green-400 font-medium">{supporters.length} support</span>}
            {opponents.length > 0 && <span className="text-red-700 dark:text-red-400 font-medium">{opponents.length} oppose</span>}
            {mixed.length > 0 && <span className="text-amber-700 dark:text-amber-400 font-medium">{mixed.length} mixed</span>}
            <div className="flex rounded-full overflow-hidden h-2 flex-1 max-w-48">
              {supporters.length > 0 && <div className="bg-green-500" style={{ width: `${(supporters.length / entity.stakeholders.length) * 100}%` }} />}
              {mixed.length > 0 && <div className="bg-amber-500" style={{ width: `${(mixed.length / entity.stakeholders.length) * 100}%` }} />}
              {opponents.length > 0 && <div className="bg-red-500" style={{ width: `${(opponents.length / entity.stakeholders.length) * 100}%` }} />}
            </div>
          </div>
          <StakeholderTable
            stakeholders={[...supporters, ...mixed, ...opponents]}
          />
        </div>
      ),
    });
  }

  // History tab (amendments + key figures)
  const historyItemCount = entity.amendments.length + entity.keyPoliticians.length + entity.keyFigures.length;
  if (historyItemCount > 0) {
    tabs.push({
      id: "history",
      label: "History",
      count: historyItemCount,
      content: (
        <div className="space-y-8">
          {/* Key Politicians */}
          {entity.keyPoliticians.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-3">Key Politicians</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {entity.keyPoliticians.map((politician, i) => {
                  const href = resolveEntityHref(politician.entityId);
                  return (
                    <div key={i} className="rounded-lg border border-border/60 bg-card px-3 py-2 flex items-center gap-2.5">
                      <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-violet-500/20 to-violet-500/5 flex items-center justify-center text-xs font-bold text-violet-600 dark:text-violet-400">
                        {politician.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                      </div>
                      <div className="min-w-0">
                        {href ? (
                          <Link href={href} className="font-medium text-sm text-primary hover:underline truncate block">{politician.name}</Link>
                        ) : (
                          <span className="font-medium text-sm truncate block">{politician.name}</span>
                        )}
                        <div className="text-[11px] text-muted-foreground truncate">{politician.role}</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Key Figures (non-political) */}
          {entity.keyFigures.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-3">Key Figures</h2>
              <div className="space-y-2">
                {entity.keyFigures.map((figure, i) => {
                  const href = resolveEntityHref(figure.entityId);
                  return (
                    <div key={i} className="rounded-lg border border-border/60 bg-card px-3 py-2.5 flex items-start gap-2.5">
                      <div className="shrink-0 w-7 h-7 rounded-full bg-gradient-to-br from-blue-500/20 to-blue-500/5 flex items-center justify-center text-xs font-bold text-blue-600 dark:text-blue-400 mt-0.5">
                        {figure.name.split(" ").map((w) => w[0]).slice(0, 2).join("")}
                      </div>
                      <div className="min-w-0">
                        {href ? (
                          <Link href={href} className="font-medium text-sm text-primary hover:underline">{figure.name}</Link>
                        ) : (
                          <span className="font-medium text-sm">{figure.name}</span>
                        )}
                        <div className="text-[11px] text-muted-foreground">{figure.role}</div>
                        {figure.description && (
                          <p className="text-xs text-foreground/60 leading-relaxed mt-1">{figure.description}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {entity.amendments.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-3">Amendment History</h2>
              <div className="divide-y divide-border/40">
                {entity.amendments.map((amendment, i) => (
                  <div key={i} className="py-2 first:pt-0">
                    <div className="flex items-baseline gap-2">
                      <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-amber-500 mt-1.5" />
                      {amendment.url ? (
                        <a href={amendment.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-sm text-primary hover:underline">{amendment.date}</a>
                      ) : (
                        <span className="font-semibold text-sm">{amendment.date}</span>
                      )}
                      {amendment.author && <span className="text-xs text-muted-foreground">by {amendment.author}</span>}
                    </div>
                    <p className="text-xs text-muted-foreground ml-3.5 mt-0.5 leading-relaxed">{amendment.description}</p>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
      ),
    });
  }

  // ── Unified Timeline tab ────────────────────────────────────────────

  // ── Press / Documents tab ──────────────────────────────────
  const resourceIds = getResourcesForPage(entity.id);
  const pressResources: OrgResourceRow[] = [];
  /** Map resource id → publication type (e.g. "government", "think_tank", "news") for categorization. */
  const pubTypeByResourceId = new Map<string, string>();
  for (const rid of resourceIds) {
    const r = getResourceById(rid);
    if (!r) continue;
    const publication = getResourcePublication(r);
    const domain = extractDomain(r.url);
    const credibility = getResourceCredibility(r) ?? null;
    const citingPages = getPagesForResource(rid);
    if (publication?.type) {
      pubTypeByResourceId.set(rid, publication.type);
    }
    pressResources.push({
      id: rid,
      title: r.title ?? r.url,
      url: r.url,
      type: r.type ?? "web",
      domain,
      publicationName: publication?.name ?? null,
      credibility,
      citingPageCount: citingPages.length,
      publishedDate: r.published_date ?? extractDateFromUrl(r.url) ?? null,
      authors: resolveResourceAuthors(r),
      summary: r.summary ?? null,
      abstract: r.abstract ?? null,
      keyPoints: r.key_points?.length ? r.key_points : null,
      fetchStatus: r.fetch_status ?? null,
      archiveUrl: r.archive_url ?? null,
      stance: r.stance ?? null,
    });
  }

  // Categorize resources into Official Documents, Analysis & Research, and Press Coverage
  type ResourceCategory = "official" | "analysis" | "press";

  const GOV_DOMAIN_PATTERNS = [
    /\.gov$/,
    /\.gov\./,          // e.g. gov.uk, gov.au
    /legislature\./,
    /congress\./,
    /parliament\./,
  ];

  const ACADEMIC_DOMAIN_PATTERNS = [
    /\.edu$/,
    /\.edu\./,          // e.g. .edu.au
    /\.ac\./,           // e.g. .ac.uk
  ];

  const OFFICIAL_TITLE_PATTERNS = [
    /bill text/i,
    /committee report/i,
    /executive order/i,
    /federal register/i,
    /public law/i,
    /enrolled bill/i,
    /congressional record/i,
  ];

  const ANALYSIS_TITLE_PATTERNS = [
    /\banalysis\b/i,
    /\bassessment\b/i,
    /\blegal review\b/i,
    /\bpolicy review\b/i,
    /\bliterature review\b/i,
    /\bworking paper\b/i,
    /\bwhite paper\b/i,
    /\bpolicy brief\b/i,
  ];

  function categorizeResource(r: OrgResourceRow): ResourceCategory {
    const pubType = pubTypeByResourceId.get(r.id) ?? null;
    const domain = r.domain ?? "";

    // ── Official Documents ──
    if (r.type === "government" || pubType === "government") return "official";
    if (GOV_DOMAIN_PATTERNS.some((p) => p.test(domain))) return "official";
    if (OFFICIAL_TITLE_PATTERNS.some((p) => p.test(r.title))) return "official";

    // ── Analysis & Research ──
    if (r.type === "paper" || r.type === "report" || r.type === "book") return "analysis";
    if (
      pubType === "think_tank" ||
      pubType === "academic_journal" ||
      pubType === "preprint_server" ||
      pubType === "academic" ||
      pubType === "academic_search"
    ) {
      return "analysis";
    }
    if (ACADEMIC_DOMAIN_PATTERNS.some((p) => p.test(domain))) return "analysis";
    if (ANALYSIS_TITLE_PATTERNS.some((p) => p.test(r.title))) return "analysis";

    // ── Press Coverage (default) ──
    return "press";
  }

  const officialDocs = pressResources.filter((r) => categorizeResource(r) === "official");
  const analysisResources = pressResources.filter((r) => categorizeResource(r) === "analysis");
  const pressCoverage = pressResources.filter((r) => categorizeResource(r) === "press");

  // Build unified timeline data
  const timelineResources: RawResource[] = pressResources.map((r) => ({
    id: r.id,
    title: r.title,
    url: r.url,
    domain: r.domain,
    publishedDate: r.publishedDate,
    category: categorizeResource(r),
  }));

  const unifiedTimeline = buildUnifiedTimeline(
    timelineEvents,
    entity.votes,
    entity.amendments,
    timelineResources
  );

  // Show Timeline tab if there's any dated timeline content.
  // Exclude undatedResources — they don't render in the timeline view,
  // so including them inflates the count and causes the tab to appear empty.
  const timelineItemCount =
    unifiedTimeline.milestones.length +
    unifiedTimeline.milestones.reduce(
      (sum, m) => sum + m.children.length,
      0
    ) +
    unifiedTimeline.earlyCoverage.length;

  if (timelineItemCount > 0) {
    tabs.push({
      id: "timeline",
      label: "Timeline",
      count: timelineItemCount,
      content: <UnifiedTimelineView timeline={unifiedTimeline} />,
    });
  }

  // Documents & Press tab (resource table only — timeline view is in the Timeline tab)
  if (pressResources.length > 0) {
    tabs.push({
      id: "press",
      label: "Documents & Press",
      count: pressResources.length,
      content: (
        <div className="space-y-8">
          {officialDocs.length > 0 && (
            <OrgResourcesSection
              resources={officialDocs}
              title="Official Documents"
              emptyMessage=""
              alwaysShowColumns={{ date: true }}
            />
          )}
          {analysisResources.length > 0 && (
            <OrgResourcesSection
              resources={analysisResources}
              title="Analysis & Research"
              emptyMessage=""
              alwaysShowColumns={{ date: true, publication: true }}
            />
          )}
          {pressCoverage.length > 0 && (
            <OrgResourcesSection
              resources={pressCoverage}
              title="Press Coverage"
              emptyMessage=""
              alwaysShowColumns={{ date: true, publication: true }}
            />
          )}
        </div>
      ),
    });
  }

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Legislation", href: "/legislation" },
          { label: billNumber ?? entity.title },
        ]}
      />

      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-5">
          <div className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/5 flex items-center justify-center" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-violet-600 dark:text-violet-400">
              <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
              <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
              <path d="M7 21h10" />
              <path d="M12 3v18" />
              <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
            </svg>
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight">
                {billNumber ? `${billNumber}: ` : ""}{entity.title}
              </h1>
              {statusKey && (
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider capitalize ${STATUS_COLORS[statusKey] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                  {statusKey}
                </span>
              )}
              {scope && (
                <span className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${SCOPE_COLORS[scope.toLowerCase()] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"}`}>
                  {scope}
                </span>
              )}
              {(() => {
                const covInput = {
                  introduced,
                  policyStatus: statusKey,
                  author,
                  jurisdiction,
                  billNumber,
                  fullTextUrl: entity.fullTextUrl,
                  description: entity.description,
                  tags: entity.tags,
                  wikiId: entity.stableId,
                };
                return (
                  <CoveragePopover
                    score={computeLegislationCoverage(covInput)}
                    signals={getLegislationSignals(covInput)}
                    size="md"
                  />
                );
              })()}
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-1">
              {jurisdiction && <span>{jurisdiction}</span>}
              {author && (() => {
                // Try to resolve author to a clickable entity link
                const authorPolitician = entity.keyPoliticians.find((p) => author.includes(p.name) || p.role?.toLowerCase().includes("author"));
                const authorHref = authorPolitician ? resolveEntityHref(authorPolitician.entityId) : null;
                return authorHref ? (
                  <span>by <Link href={authorHref} className="text-primary hover:underline">{author}</Link></span>
                ) : (
                  <span>by {author}</span>
                );
              })()}
              {introduced && <span>Introduced {formatIntroducedDate(introduced)}</span>}
              {entity.fullTextUrl && (
                <a href={entity.fullTextUrl} target="_blank" rel="noopener noreferrer" className="text-primary hover:text-primary/80 font-medium transition-colors">
                  Full text &#8599;
                </a>
              )}
              {wikiHref && (
                <Link href={wikiHref} className="text-primary hover:text-primary/80 font-medium transition-colors">
                  Wiki article &rarr;
                </Link>
              )}
              <Link href={`/legislation/${slug}/data`} className="text-primary hover:text-primary/80 font-medium transition-colors">
                Data &rarr;
              </Link>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs — full width; sidebar is inside Overview tab only */}
      <ProfileTabs tabs={tabs} ariaLabel="Legislation sections" />
    </div>
  );
}
