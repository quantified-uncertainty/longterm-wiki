import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { RelatedPages } from "@/components/RelatedPages";
import { getEntityHref } from "@/data/entity-nav";
import { getTypedEntityById } from "@/data";
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

// ── Position colors for stakeholder badges ──
const POSITION_COLORS: Record<string, string> = {
  support:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  oppose: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutral:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  mixed:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

export default async function LegislationDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolvePolicyBySlug(slug);
  if (!entity) return notFound();

  // Extract structured data (typed fields are promoted by entity-transform at build time)
  const introduced = entity.introduced ?? null;
  const author = entity.author ?? null;
  const rawStatus = deriveStatus(entity);
  const statusKey = normalizeStatus(rawStatus);
  const scope = getPolicyScope(entity);
  const billNumber = entity.billNumber ?? null;
  const jurisdiction = entity.jurisdiction ?? null;

  // Timeline events from customFields
  const TIMELINE_LABELS = new Set([
    "Introduced", "Passed Legislature", "Passed Committee", "Passed Senate",
    "Passed Assembly", "Signed", "Vetoed", "Enacted", "Effective", "Amended", "In Force",
  ]);
  const timelineEvents = entity.customFields
    .filter((f) => TIMELINE_LABELS.has(f.label))
    .map((f) => ({ label: f.label, value: f.value }));

  // Related policies
  const relatedPolicies = getRelatedPolicies(entity);

  // Related entities (non-policy)
  const relatedEntities = entity.relatedEntries
    .filter((r) => r.type !== "policy")
    .map((r) => {
      const ent = getTypedEntityById(r.id);
      if (!ent) return null;
      return { name: ent.title, href: getEntityHref(r.id), relationship: r.relationship };
    })
    .filter(Boolean) as Array<{
    name: string;
    href: string;
    relationship?: string;
  }>;

  // Wiki page link
  const wikiHref = getPolicyWikiHref(entity);

  // Stakeholder counts
  const supporters = entity.stakeholders.filter((s) => s.position === "support");
  const opponents = entity.stakeholders.filter((s) => s.position === "oppose");
  const mixed = entity.stakeholders.filter((s) => s.position === "mixed" || s.position === "neutral");


  // Group provisions by category
  const provisionsByCategory = new Map<string, typeof entity.provisions>();
  for (const p of entity.provisions) {
    const cat = p.category ?? "General";
    if (!provisionsByCategory.has(cat)) provisionsByCategory.set(cat, []);
    provisionsByCategory.get(cat)!.push(p);
  }

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Legislation", href: "/legislation" },
          { label: billNumber ?? entity.title },
        ]}
      />

      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="mb-8">
        <div className="flex items-start gap-5">
          <div
            className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-violet-500/20 to-violet-500/5 flex items-center justify-center"
            aria-hidden="true"
          >
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
            </div>

            <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-1">
              {jurisdiction && <span>{jurisdiction}</span>}
              {author && <span>by {author}</span>}
              {introduced && <span>Introduced {introduced}</span>}
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
            </div>

            {entity.description && (
              <p className="text-sm text-muted-foreground leading-relaxed mt-2 max-w-prose">
                {entity.description}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ── Main content grid ──────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">

          {/* ── Legislative Timeline ────────────────────────────── */}
          {timelineEvents.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Legislative Timeline</h2>
              <div className="relative pl-6 border-l-2 border-border space-y-4">
                {timelineEvents.map((event, i) => (
                  <div key={i} className="relative">
                    <div className={`absolute -left-[25px] w-3 h-3 rounded-full border-2 border-background ${
                      event.label === "Vetoed" ? "bg-red-500"
                        : event.label === "Enacted" || event.label === "Signed" ? "bg-green-500"
                        : event.label === "Introduced" ? "bg-blue-500"
                        : "bg-violet-500"
                    }`} />
                    <div className="flex items-baseline gap-2">
                      <span className="font-semibold text-sm">{event.label}</span>
                      <span className="text-sm text-muted-foreground">{event.value}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Votes ───────────────────────────────────────────── */}
          {entity.votes.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Voting Record</h2>
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
                      <th className="text-left py-2 px-3 font-medium">Chamber</th>
                      <th className="text-left py-2 px-3 font-medium">Date</th>
                      <th className="text-left py-2 px-3 font-medium">Result</th>
                      <th className="text-right py-2 px-3 font-medium">Ayes</th>
                      <th className="text-right py-2 px-3 font-medium">Noes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {entity.votes.map((vote, i) => (
                      <tr key={i} className="hover:bg-muted/20">
                        <td className="py-2 px-3 font-medium">{vote.chamber}</td>
                        <td className="py-2 px-3 text-muted-foreground">{vote.date ?? <span className="text-muted-foreground/40">&mdash;</span>}</td>
                        <td className="py-2 px-3">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
                            vote.result.toLowerCase().includes("pass")
                              ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
                              : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
                          }`}>
                            {vote.result}
                          </span>
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums font-semibold text-green-700 dark:text-green-400">
                          {vote.ayes ?? <span className="text-muted-foreground/40">&mdash;</span>}
                        </td>
                        <td className="py-2 px-3 text-right tabular-nums font-semibold text-red-700 dark:text-red-400">
                          {vote.noes ?? <span className="text-muted-foreground/40">&mdash;</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {/* ── Key Provisions ───────────────────────────────────── */}
          {entity.provisions.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Key Provisions</h2>
              <div className="space-y-3">
                {[...provisionsByCategory.entries()].map(([category, provisions]) => (
                  <div key={category}>
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">
                      {category}
                    </h3>
                    <div className="space-y-2">
                      {provisions.map((provision, i) => (
                        <div key={i} className="rounded-lg border border-border/60 bg-card p-3">
                          <div className="font-semibold text-sm mb-1">{provision.title}</div>
                          <p className="text-sm text-muted-foreground leading-relaxed">
                            {provision.description}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Veto Reason ──────────────────────────────────────── */}
          {entity.vetoReason && (
            <section>
              <h2 className="text-lg font-bold mb-4">Veto Rationale</h2>
              <div className="rounded-xl border border-red-200 dark:border-red-900/40 bg-red-50/50 dark:bg-red-950/20 p-4">
                <p className="text-sm leading-relaxed">{entity.vetoReason}</p>
              </div>
            </section>
          )}

          {/* ── Stakeholders: Supporters & Opponents ─────────────── */}
          {entity.stakeholders.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">
                Stakeholders
                <span className="text-sm font-normal text-muted-foreground ml-2">
                  {supporters.length} support, {opponents.length} oppose{mixed.length > 0 ? `, ${mixed.length} mixed/neutral` : ""}
                </span>
              </h2>

              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                      <th className="text-left py-2 px-3 font-medium">Position</th>
                      <th className="text-left py-2 px-3 font-medium">Reason</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {/* Supporters first, then mixed, then opponents */}
                    {[...supporters, ...mixed, ...opponents].map((stakeholder, i) => {
                      const href = resolveEntityHref(stakeholder.entityId);
                      return (
                        <tr key={i} className="hover:bg-muted/20">
                          <td className="py-2 px-3">
                            {href ? (
                              <Link href={href} className="text-primary hover:underline font-medium">
                                {stakeholder.name}
                              </Link>
                            ) : (
                              <span className="font-medium">{stakeholder.name}</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${POSITION_COLORS[stakeholder.position] ?? "bg-gray-100 text-gray-600"}`}>
                              {stakeholder.position}
                            </span>
                          </td>
                          <td className="py-2 px-3 text-muted-foreground text-xs max-w-sm">
                            {stakeholder.reason ? (
                              <>
                                {stakeholder.reason}
                                {stakeholder.source && (
                                  <a href={stakeholder.source} target="_blank" rel="noopener noreferrer" className="ml-1 text-primary hover:underline">[source]</a>
                                )}
                              </>
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

          {/* ── Amendments ────────────────────────────────────────── */}
          {entity.amendments.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Amendment History</h2>
              <div className="relative pl-6 border-l-2 border-border/60 space-y-4">
                {entity.amendments.map((amendment, i) => (
                  <div key={i} className="relative">
                    <div className="absolute -left-[25px] w-3 h-3 rounded-full border-2 border-background bg-amber-500" />
                    <div>
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <span className="font-semibold text-sm">{amendment.date}</span>
                        {amendment.author && (
                          <span className="text-xs text-muted-foreground">by {amendment.author}</span>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">{amendment.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── Key Politicians ───────────────────────────────────── */}
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
                          <Link href={href} className="font-medium text-sm text-primary hover:underline">
                            {politician.name}
                          </Link>
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

          {/* ── Related Legislation ──────────────────────────────── */}
          {relatedPolicies.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Related Legislation</h2>
              <div className="rounded-xl border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
                      <th className="text-left py-2 px-3 font-medium">Name</th>
                      <th className="text-left py-2 px-3 font-medium">Relationship</th>
                      <th className="text-left py-2 px-3 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {relatedPolicies.map(({ entity: rel, relationship }) => {
                      const relStatus = normalizeStatus(rel.policyStatus ?? getCustomField(rel, "Status") ?? (getCustomField(rel, "Vetoed") ? "Vetoed" : null));
                      return (
                        <tr key={rel.id} className="hover:bg-muted/20">
                          <td className="py-2 px-3">
                            <Link href={`/legislation/${rel.id}`} className="text-primary hover:underline font-medium">
                              {rel.title}
                            </Link>
                          </td>
                          <td className="py-2 px-3 text-muted-foreground capitalize">{relationship ?? "related"}</td>
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

          {/* ── Related Topics ───────────────────────────────────── */}
          {relatedEntities.length > 0 && (
            <section>
              <h2 className="text-lg font-bold mb-4">Related Topics</h2>
              <div className="flex flex-wrap gap-2">
                {relatedEntities.map((ref) => (
                  <Link key={ref.href} href={ref.href} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border/60 bg-card hover:bg-muted/50 text-sm transition-colors">
                    <span className="font-medium">{ref.name}</span>
                    {ref.relationship && (
                      <span className="text-xs text-muted-foreground/70">({ref.relationship})</span>
                    )}
                  </Link>
                ))}
              </div>
            </section>
          )}

          {/* ── Related Wiki Pages ───────────────────────────────── */}
          <RelatedPages entityId={entity.id} entity={{ type: "policy" }} />
        </div>

        {/* ── Right sidebar ──────────────────────────────────────── */}
        <div className="space-y-6">
          {/* Quick facts card */}
          <section className="rounded-xl border border-border p-4 space-y-3">
            <h3 className="text-sm font-bold">Quick Facts</h3>
            <dl className="space-y-2 text-sm">
              {billNumber && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Bill Number</dt>
                  <dd className="font-semibold">{billNumber}</dd>
                </div>
              )}
              {jurisdiction && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Jurisdiction</dt>
                  <dd>{jurisdiction}</dd>
                </div>
              )}
              {entity.session && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Session</dt>
                  <dd>{entity.session}</dd>
                </div>
              )}
              {author && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Author / Sponsor</dt>
                  <dd>{author}</dd>
                </div>
              )}
              {introduced && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Introduced</dt>
                  <dd>{introduced}</dd>
                </div>
              )}
              {rawStatus && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Status</dt>
                  <dd>{rawStatus}</dd>
                </div>
              )}
              {scope && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Scope</dt>
                  <dd>{scope}</dd>
                </div>
              )}
              {entity.numericId && (
                <div>
                  <dt className="text-xs text-muted-foreground/70 uppercase tracking-wider">Entity ID</dt>
                  <dd className="font-mono text-xs">{entity.numericId}</dd>
                </div>
              )}
            </dl>
          </section>

          {/* Stakeholder summary (sidebar) */}
          {entity.stakeholders.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Position Summary</h3>
              <div className="space-y-2">
                {supporters.length > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-green-700 dark:text-green-400 font-medium">Support</span>
                    <span className="tabular-nums font-semibold">{supporters.length}</span>
                  </div>
                )}
                {opponents.length > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-red-700 dark:text-red-400 font-medium">Oppose</span>
                    <span className="tabular-nums font-semibold">{opponents.length}</span>
                  </div>
                )}
                {mixed.length > 0 && (
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-amber-700 dark:text-amber-400 font-medium">Mixed / Neutral</span>
                    <span className="tabular-nums font-semibold">{mixed.length}</span>
                  </div>
                )}
                {/* Visual bar */}
                <div className="flex rounded-full overflow-hidden h-2 mt-1">
                  {supporters.length > 0 && (
                    <div className="bg-green-500" style={{ width: `${(supporters.length / entity.stakeholders.length) * 100}%` }} />
                  )}
                  {mixed.length > 0 && (
                    <div className="bg-amber-500" style={{ width: `${(mixed.length / entity.stakeholders.length) * 100}%` }} />
                  )}
                  {opponents.length > 0 && (
                    <div className="bg-red-500" style={{ width: `${(opponents.length / entity.stakeholders.length) * 100}%` }} />
                  )}
                </div>
              </div>
            </section>
          )}

          {/* Sources */}
          {entity.sources.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Sources</h3>
              <ul className="space-y-2.5">
                {entity.sources.map((source, i) => (
                  <li key={i} className="text-sm">
                    {source.url ? (
                      <a href={source.url} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                        {source.title}
                      </a>
                    ) : (
                      <span>{source.title}</span>
                    )}
                    {(source.author || source.date) && (
                      <span className="text-xs text-muted-foreground ml-1">
                        {[source.author, source.date].filter(Boolean).join(", ")}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {/* Tags */}
          {entity.tags.length > 0 && (
            <section className="rounded-xl border border-border p-4">
              <h3 className="text-sm font-bold mb-3">Tags</h3>
              <div className="flex flex-wrap gap-1.5">
                {entity.tags.map((tag) => (
                  <span key={tag} className="px-2 py-0.5 rounded-full text-[10px] font-medium bg-muted text-muted-foreground">
                    {tag}
                  </span>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

