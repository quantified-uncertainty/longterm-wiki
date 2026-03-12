import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBLatest,
  getKBFacts,
  getKBProperty,
  getKBEntity,
  getKBAllRecordCollections,
  resolveKBSlug,
  getKBEntitySlug,
  getKBRecords,
  getAllKBRecordsByCollection,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById, getTypedEntities, isOrganization, isAiModel } from "@/data";
import { getEntityHref } from "@/data/entity-nav";
import {
  formatKBDate,
  formatKBNumber,
  titleCase,
  sortKBRecords,
  shortDomain,
  isUrl,
} from "@/components/wiki/kb/format";
import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";
import { KBRecordCollection } from "@/components/wiki/kb/KBRecordCollection";
import type { Fact, Property, RecordEntry } from "@longterm-wiki/kb";
import Link from "next/link";
import {
  Breadcrumbs,
  FactValueDisplay,
  FactsPanel,
} from "@/components/directory";

export function generateStaticParams() {
  return getOrgSlugs().map((slug) => ({ slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  return {
    title: entity ? `${entity.name} | Organizations` : "Organization Not Found",
    description: entity
      ? `Profile and key metrics for ${entity.name}.`
      : undefined,
  };
}

// ── Curated collection names ──────────────────────────────────────────
const CURATED_COLLECTIONS = new Set([
  "funding-rounds",
  "investments",
  "key-persons",
  "products",
  "model-releases",
  "safety-milestones",
  "strategic-partnerships",
]);

// ── Formatting helpers ────────────────────────────────────────────────

function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  return formatKBNumber(num, "USD");
}

/** Safely get a string field from a record, or undefined. */
function field(item: RecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

// ── Subcomponents ─────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
}) {
  return (
    <div className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4">
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {label}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-muted-foreground/50 mt-1">{sub}</div>
      )}
    </div>
  );
}

/** Section header with optional count badge and divider. */
function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}

/** Source link for a record entry. */
function SourceLink({ source }: { source: string | undefined }) {
  if (!source) return null;
  if (isUrl(source)) {
    return (
      <a
        href={source}
        target="_blank"
        rel="noopener noreferrer"
        className="text-[10px] text-primary/50 hover:text-primary hover:underline transition-colors"
      >
        {shortDomain(source)}
      </a>
    );
  }
  return <span className="text-[10px] text-muted-foreground">{source}</span>;
}

function PersonRow({
  name,
  title,
  slug,
  entityType,
  isFounder,
  start,
  end,
  notes,
}: {
  name: string;
  title?: string;
  slug?: string;
  entityType?: string;
  isFounder?: boolean;
  start?: string;
  end?: string;
  notes?: string;
}) {
  const href = slug
    ? entityType === "organization"
      ? `/organizations/${slug}`
      : `/people/${slug}`
    : undefined;

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/40 last:border-b-0">
      <div className="shrink-0 w-8 h-8 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs font-semibold text-primary/70 mt-0.5">
        {name
          .split(/\s+/)
          .map((w) => w[0])
          .filter(Boolean)
          .slice(0, 2)
          .join("")
          .toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          {href ? (
            <Link
              href={href}
              className="font-semibold text-sm hover:text-primary transition-colors"
            >
              {name}
            </Link>
          ) : (
            <span className="font-semibold text-sm">{name}</span>
          )}
          {isFounder && (
            <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
              Founder
            </span>
          )}
        </div>
        {title && (
          <div className="text-xs text-muted-foreground">{title}</div>
        )}
        <div className="text-[10px] text-muted-foreground/50 mt-0.5">
          {start && formatKBDate(start)}
          {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
        </div>
        {notes && (
          <div className="text-[10px] text-muted-foreground/50 mt-0.5 line-clamp-2">
            {notes}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Badge helper ──────────────────────────────────────────────────────

function Badge({ children, color }: { children: React.ReactNode; color?: string }) {
  const colorClass =
    color ?? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${colorClass}`}
    >
      {children}
    </span>
  );
}

const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-2": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-3": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "ASL-4": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

const MILESTONE_TYPE_COLORS: Record<string, string> = {
  "research-paper":
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "policy-update":
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "safety-eval":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "red-team":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
};

// ── Entity ref resolver helper ────────────────────────────────────────

function resolveRefName(
  slug: string | undefined,
  displayName: string | undefined,
): { name: string; href: string | null } {
  if (!slug && !displayName) return { name: "Unknown", href: null };

  if (slug) {
    const entityId = resolveKBSlug(slug);
    const entity = entityId ? getKBEntity(entityId) : null;
    if (entity) {
      const prefix = entity.type === "organization" ? "/organizations"
        : entity.type === "person" ? "/people"
        : null;
      return { name: entity.name, href: prefix ? `${prefix}/${slug}` : `/kb/entity/${entityId}` };
    }
  }

  // Fall back to display name or humanized slug
  const fallbackName = displayName ?? (slug ? titleCase(slug) : "Unknown");
  return { name: fallbackName, href: null };
}

// ── Fact sidebar helpers ──────────────────────────────────────────────

const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

/** Group facts by property, taking only the latest per property. */
function getLatestFactsByProperty(
  facts: Fact[],
): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    if (!latest.has(fact.propertyId)) {
      latest.set(fact.propertyId, fact);
    }
  }
  return latest;
}

/** Group property IDs by category, returning sorted categories. */
function groupByCategory(
  propertyIds: string[],
): Array<{ category: string; label: string; props: string[] }> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }

  const catMap = new Map(FACT_CATEGORIES.map((c) => [c.id, c]));
  return [...groups.entries()]
    .map(([catId, props]) => ({
      category: catId,
      label: catMap.get(catId)?.label ?? titleCase(catId),
      order: catMap.get(catId)?.order ?? 99,
      props,
    }))
    .sort((a, b) => a.order - b.order);
}


// ── Hero stat properties for org pages ────────────────────────────────
const HERO_STATS = ["revenue", "valuation", "headcount", "total-funding", "founded-date"];

// ── Org type labels / colors ──────────────────────────────────────────

const ORG_TYPE_LABELS: Record<string, string> = {
  "frontier-lab": "Frontier Lab",
  "safety-org": "Safety Org",
  academic: "Academic",
  startup: "Startup",
  generic: "Lab",
  funder: "Funder",
  government: "Government",
};

const ORG_TYPE_COLORS: Record<string, string> = {
  "frontier-lab": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  "safety-org":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  academic:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  startup:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  generic:
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  funder:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  government:
    "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
};

function SectionHeader({ title, count }: { title: string; count?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}

// ── Grant helpers ─────────────────────────────────────────────────────

const MAX_GRANTS_SHOWN = 10;

/** Resolve a recipient slug/ID to a display name and optional href. */
function resolveRecipient(recipientId: string): { name: string; href: string | null } {
  const entity = getKBEntity(recipientId);
  if (entity) {
    const slug = getKBEntitySlug(recipientId);
    const href = slug && entity.type === "organization" ? `/organizations/${slug}`
      : slug && entity.type === "person" ? `/people/${slug}`
      : `/kb/entity/${recipientId}`;
    return { name: entity.name, href };
  }
  // Fall back: titleCase the slug
  return { name: titleCase(recipientId.replace(/-/g, " ")), href: null };
}

/** Parse grant record fields into a structured object for display. */
function parseGrantRecord(record: RecordEntry): {
  key: string;
  name: string;
  recipient: string | null;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null;
  date: string | null;
  status: string | null;
  source: string | null;
} {
  const f = record.fields;
  const recipientId = (f.recipient as string) ?? null;
  const resolved = recipientId ? resolveRecipient(recipientId) : { name: "", href: null };
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    recipient: recipientId,
    recipientName: resolved.name,
    recipientHref: resolved.href,
    amount: typeof f.amount === "number" ? f.amount : null,
    date: (f.date as string) ?? (f.period as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

/** Grants Made section for funder org pages. */
function GrantsMadeSection({
  grants,
  orgName,
  totalCount,
}: {
  grants: ReturnType<typeof parseGrantRecord>[];
  orgName: string;
  totalCount: number;
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce((sum, g) => sum + (g.amount ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Grants Made" count={totalCount} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">Recipient</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.slice(0, MAX_GRANTS_SHOWN).map((g) => (
              <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{g.name}</span>
                  {g.source && (
                    <a
                      href={g.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {g.recipientHref ? (
                    <Link href={g.recipientHref} className="text-primary hover:underline">
                      {g.recipientName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{g.recipientName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {g.amount != null && (
                    <span className="font-semibold">{formatCompactCurrency(g.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalCount > MAX_GRANTS_SHOWN && (
        <Link
          href={`/grants?org=${encodeURIComponent(orgName)}`}
          className="block mt-2 text-xs text-primary hover:underline text-center"
        >
          View all {totalCount} grants &rarr;
        </Link>
      )}
    </section>
  );
}

/** Enriched grant with funder info for received grants. */
type ReceivedGrant = ReturnType<typeof parseGrantRecord> & {
  funderName: string;
  funderHref: string | null;
};

/** Funding Received section for org pages where org is a grant recipient. */
function FundingReceivedSection({
  grants,
}: {
  grants: ReceivedGrant[];
}) {
  if (grants.length === 0) return null;

  const totalAmount = grants.reduce((sum, g) => sum + (g.amount ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Funding Received" count={grants.length} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">Funder</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => (
              <tr key={`received-${g.key}`} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{g.name}</span>
                  {g.source && (
                    <a
                      href={g.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {g.funderHref ? (
                    <Link href={g.funderHref} className="text-primary hover:underline">
                      {g.funderName}
                    </Link>
                  ) : (
                    <span className="text-muted-foreground">{g.funderName}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {g.amount != null && (
                    <span className="font-semibold">{formatCompactCurrency(g.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Division helpers ──────────────────────────────────────────────────

const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Department",
  lab: "Lab",
  "program-area": "Program Area",
};

const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

function parseDivisionRecord(record: RecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    divisionType: (f.divisionType as string) ?? "team",
    lead: (f.lead as string) ?? null,
    status: (f.status as string) ?? null,
    startDate: (f.startDate as string) ?? null,
    endDate: (f.endDate as string) ?? null,
    website: (f.website as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

/** Divisions section for org pages. */
function DivisionsSection({
  divisions,
}: {
  divisions: ReturnType<typeof parseDivisionRecord>[];
}) {
  if (divisions.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Divisions" count={divisions.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Name</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-left py-2 px-3 font-medium">Lead</th>
              <th className="text-center py-2 px-3 font-medium">Status</th>
              <th className="text-center py-2 px-3 font-medium">Dates</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {divisions.map((d) => (
              <tr key={d.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {d.website ? (
                      <a
                        href={d.website}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {d.name}
                      </a>
                    ) : (
                      d.name
                    )}
                  </span>
                  {d.source && (
                    <a
                      href={d.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      DIVISION_TYPE_COLORS[d.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {DIVISION_TYPE_LABELS[d.divisionType] ?? d.divisionType}
                  </span>
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {d.lead ?? ""}
                </td>
                <td className="py-2 px-3 text-center text-xs">
                  {d.status && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        d.status === "active"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : d.status === "inactive"
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {titleCase(d.status)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {d.startDate && (
                    <span>
                      {d.startDate}
                      {d.endDate ? ` - ${d.endDate}` : " - present"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Funding program helpers ──────────────────────────────────────────

const PROGRAM_TYPE_LABELS: Record<string, string> = {
  rfp: "RFP",
  "grant-round": "Grant Round",
  fellowship: "Fellowship",
  prize: "Prize",
  solicitation: "Solicitation",
  call: "Call",
};

const PROGRAM_TYPE_COLORS: Record<string, string> = {
  rfp: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "grant-round": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  fellowship: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  prize: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  solicitation: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  call: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
};

function parseFundingProgramRecord(record: RecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    programType: (f.programType as string) ?? "grant-round",
    description: (f.description as string) ?? null,
    totalBudget: typeof f.totalBudget === "number" ? f.totalBudget : null,
    currency: (f.currency as string) ?? "USD",
    applicationUrl: (f.applicationUrl as string) ?? null,
    openDate: (f.openDate as string) ?? null,
    deadline: (f.deadline as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

/** Funding Programs section for org pages. */
function FundingProgramsSection({
  programs,
}: {
  programs: ReturnType<typeof parseFundingProgramRecord>[];
}) {
  if (programs.length === 0) return null;

  const totalBudget = programs.reduce((sum, p) => sum + (p.totalBudget ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Funding Programs" count={programs.length} />
      {totalBudget > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total budget tracked: {formatCompactCurrency(totalBudget)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Program</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-right py-2 px-3 font-medium">Budget</th>
              <th className="text-center py-2 px-3 font-medium">Status</th>
              <th className="text-center py-2 px-3 font-medium">Deadline</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {programs.map((p) => (
              <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {p.applicationUrl ? (
                      <a
                        href={p.applicationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {p.name}
                      </a>
                    ) : (
                      p.name
                    )}
                  </span>
                  {p.source && (
                    <a
                      href={p.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                  {p.description && (
                    <div className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">
                      {p.description}
                    </div>
                  )}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      PROGRAM_TYPE_COLORS[p.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {PROGRAM_TYPE_LABELS[p.programType] ?? p.programType}
                  </span>
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {p.totalBudget != null && (
                    <span className="font-semibold">{formatCompactCurrency(p.totalBudget)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-xs">
                  {p.status && (
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                        p.status === "open"
                          ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                          : p.status === "awarded"
                            ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                            : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                      }`}
                    >
                      {titleCase(p.status)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {p.deadline ?? p.openDate ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Personnel helpers ────────────────────────────────────────────────

const ROLE_TYPE_LABELS: Record<string, string> = {
  "key-person": "Key Person",
  board: "Board",
  career: "Career",
};

const ROLE_TYPE_COLORS: Record<string, string> = {
  "key-person": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  board: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  career: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

function parsePersonnelRecord(record: RecordEntry) {
  const f = record.fields;
  const schema = record.schema;

  // Extract person ID — key-person and board use different field names
  const personId =
    (f.person as string) ?? (f.member as string) ?? null;

  // Extract role/title
  const role = (f.title as string) ?? (f.role as string) ?? null;

  // Extract dates — key-person uses start/end, board uses appointed/departed
  const startDate =
    (f.start as string) ?? (f.appointed as string) ?? null;
  const endDate =
    (f.end as string) ?? (f.departed as string) ?? null;

  const isFounder = (f.is_founder as boolean) ?? false;

  // Determine display role type from schema
  const roleType =
    schema === "key-person"
      ? "key-person"
      : schema === "board-seat"
        ? "board"
        : "career";

  return {
    key: record.key,
    personId,
    role,
    roleType,
    startDate,
    endDate,
    isFounder,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

/** Key Personnel section for org pages. */
function KeyPersonnelSection({
  personnel,
}: {
  personnel: (ReturnType<typeof parsePersonnelRecord> & {
    personName: string;
    personHref: string | null;
  })[];
}) {
  if (personnel.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Key Personnel" count={personnel.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Name</th>
              <th className="text-left py-2 px-3 font-medium">Role</th>
              <th className="text-left py-2 px-3 font-medium">Type</th>
              <th className="text-center py-2 px-3 font-medium">Period</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {personnel.map((p) => (
              <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {p.personHref ? (
                      <Link href={p.personHref} className="text-primary hover:underline">
                        {p.personName}
                      </Link>
                    ) : (
                      p.personName
                    )}
                  </span>
                  {p.isFounder && (
                    <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold uppercase bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                      Founder
                    </span>
                  )}
                  {p.source && (
                    <a
                      href={p.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {p.role ?? ""}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                      ROLE_TYPE_COLORS[p.roleType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {ROLE_TYPE_LABELS[p.roleType] ?? p.roleType}
                  </span>
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {p.startDate && (
                    <span>
                      {p.startDate}
                      {p.endDate ? ` - ${p.endDate}` : " - present"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Funding Round helpers ────────────────────────────────────────────

function parseFundingRoundRecord(record: RecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    date: (f.date as string) ?? null,
    raised: typeof f.raised === "number" ? f.raised : null,
    valuation: typeof f.valuation === "number" ? f.valuation : null,
    instrument: (f.instrument as string) ?? null,
    leadInvestor: (f.lead_investor as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

/** Funding Rounds section for org pages. */
function FundingRoundsSection({
  rounds,
}: {
  rounds: (ReturnType<typeof parseFundingRoundRecord> & {
    leadInvestorName: string;
    leadInvestorHref: string | null;
  })[];
}) {
  if (rounds.length === 0) return null;

  const totalRaised = rounds.reduce((sum, r) => sum + (r.raised ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Funding Rounds" count={rounds.length} />
      {totalRaised > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total raised: {formatCompactCurrency(totalRaised)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Round</th>
              <th className="text-right py-2 px-3 font-medium">Raised</th>
              <th className="text-right py-2 px-3 font-medium">Valuation</th>
              <th className="text-left py-2 px-3 font-medium">Lead Investor</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rounds.map((r) => (
              <tr key={r.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">{r.name}</span>
                  {r.instrument && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                      ({r.instrument})
                    </span>
                  )}
                  {r.source && (
                    <a
                      href={r.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {r.raised != null && (
                    <span className="font-semibold">{formatCompactCurrency(r.raised)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {r.valuation != null && (
                    <span className="text-muted-foreground">{formatCompactCurrency(r.valuation)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-xs">
                  {r.leadInvestorHref ? (
                    <Link href={r.leadInvestorHref} className="text-primary hover:underline">
                      {r.leadInvestorName}
                    </Link>
                  ) : r.leadInvestorName ? (
                    <span className="text-muted-foreground">{r.leadInvestorName}</span>
                  ) : null}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {r.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Investment helpers ───────────────────────────────────────────────

function parseInvestmentRecord(record: RecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    investorId: (f.investor as string) ?? null,
    roundName: (f.round_name as string) ?? null,
    date: (f.date as string) ?? null,
    amount: typeof f.amount === "number" ? f.amount : null,
    stakeAcquired: typeof f.stake_acquired === "number" ? f.stake_acquired : null,
    instrument: (f.instrument as string) ?? null,
    role: (f.role as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

/** Investments Received section for org pages. */
function InvestmentsReceivedSection({
  investments,
}: {
  investments: (ReturnType<typeof parseInvestmentRecord> & {
    investorName: string;
    investorHref: string | null;
  })[];
}) {
  if (investments.length === 0) return null;

  const totalAmount = investments.reduce((sum, inv) => sum + (inv.amount ?? 0), 0);

  return (
    <section>
      <SectionHeader title="Investments Received" count={investments.length} />
      {totalAmount > 0 && (
        <div className="text-xs text-muted-foreground mb-3">
          Total tracked: {formatCompactCurrency(totalAmount)}
        </div>
      )}
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Investor</th>
              <th className="text-left py-2 px-3 font-medium">Round</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {investments.map((inv) => (
              <tr key={inv.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {inv.investorHref ? (
                      <Link href={inv.investorHref} className="text-primary hover:underline">
                        {inv.investorName}
                      </Link>
                    ) : (
                      inv.investorName
                    )}
                  </span>
                  {inv.role && (
                    <span className="ml-1.5 text-[10px] text-muted-foreground/60">
                      ({inv.role})
                    </span>
                  )}
                  {inv.source && (
                    <a
                      href={inv.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {inv.roundName ?? ""}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {inv.amount != null && (
                    <span className="font-semibold">{formatCompactCurrency(inv.amount)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {inv.date ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Equity Position helpers ─────────────────────────────────────────

function parseEquityPositionRecord(record: RecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    holderId: (f.holder as string) ?? null,
    stake: typeof f.stake === "number" ? f.stake : null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
    asOf: "asOf" in record ? (record as { asOf?: string }).asOf : undefined,
  };
}

/** Format a stake percentage for display (e.g., 0.15 → "15%"). */
function formatStake(stake: number): string {
  if (stake <= 1) {
    return `${(stake * 100).toFixed(1).replace(/\.0$/, "")}%`;
  }
  // Already a percentage
  return `${stake.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Equity Positions section for org pages. */
function EquityPositionsSection({
  positions,
}: {
  positions: (ReturnType<typeof parseEquityPositionRecord> & {
    holderName: string;
    holderHref: string | null;
  })[];
}) {
  if (positions.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Equity Positions" count={positions.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Holder</th>
              <th className="text-right py-2 px-3 font-medium">Stake</th>
              <th className="text-center py-2 px-3 font-medium">As Of</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {positions.map((pos) => (
              <tr key={pos.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {pos.holderHref ? (
                      <Link href={pos.holderHref} className="text-primary hover:underline">
                        {pos.holderName}
                      </Link>
                    ) : (
                      pos.holderName
                    )}
                  </span>
                  {pos.source && (
                    <a
                      href={pos.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                  {pos.stake != null && (
                    <span className="font-semibold">{formatStake(pos.stake)}</span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {pos.asOf ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ── Main page ─────────────────────────────────────────────────────────

export default async function OrgProfilePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const entity = resolveOrgBySlug(slug);
  if (!entity) return notFound();

  // Use URL slug directly — typed entities are keyed by slug, not KB internal IDs
  const typedEntity = getTypedEntityById(slug);
  const orgData = typedEntity && isOrganization(typedEntity) ? typedEntity : null;
  const orgType = orgData?.orgType ?? null;

  // Header facts (description/website come from entity YAML, not KB facts)
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All record collections
  const allCollections = getKBAllRecordCollections(entity.id);

  // Curated collections
  const fundingRounds = allCollections["funding-rounds"] ?? [];
  const keyPersons = allCollections["key-persons"] ?? [];
  const investments = allCollections["investments"] ?? [];
  const products = allCollections["products"] ?? [];
  const modelReleases = allCollections["model-releases"] ?? [];
  const safetyMilestones = allCollections["safety-milestones"] ?? [];
  const strategicPartnerships = allCollections["strategic-partnerships"] ?? [];

  // Other (non-curated) collections with entries
  const otherCollections = Object.entries(allCollections)
    .filter(([name, entries]) => !CURATED_COLLECTIONS.has(name) && entries.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  // All facts for the panel
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Sort collections by date (most recent first)
  const sortedRounds = sortKBRecords(fundingRounds, "date", false);
  const sortedModels = sortKBRecords(modelReleases, "released", false);
  const sortedMilestones = sortKBRecords(safetyMilestones, "date", false);
  const sortedPartnerships = sortKBRecords(strategicPartnerships, "date", false);

  // Sort key persons: current first, then by start date descending
  const sortedPersons = [...keyPersons].sort((a, b) => {
    const endA = a.fields.end ? 1 : 0;
    const endB = b.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const startA = a.fields.start ? String(a.fields.start) : "";
    const startB = b.fields.start ? String(b.fields.start) : "";
    return startB.localeCompare(startA);
  });

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Description and website come from typed entity YAML data
  const descriptionText = orgData?.description ?? null;
  const websiteUrl = orgData?.website ?? null;

  // AI models developed by this org
  const orgModels = getTypedEntities()
    .filter(isAiModel)
    .filter((m) => m.developer === slug && m.releaseDate)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""));

  // Headquarters text
  const hqText =
    hqFact?.value.type === "text" ? hqFact.value.value : null;

  // ── Grants Made (this org is the funder) ──
  const grantRecords = getKBRecords(entity.id, "grants");
  const grantsMade = grantRecords
    .map(parseGrantRecord)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  // ── Funding Received (this org is a recipient in other orgs' grants) ──
  // Recipients in PG grants are stored as display names (not entity IDs),
  // so we match against entity name, aliases, and slug.
  const allGrantRecords = getAllKBRecordsByCollection("grants");
  const recipientMatchNames = new Set<string>([
    entity.name.toLowerCase(),
    slug.toLowerCase(),
    entity.id.toLowerCase(),
    ...(entity.aliases?.map((a: string) => a.toLowerCase()) ?? []),
  ]);
  const grantsReceived = allGrantRecords
    .filter((r) => {
      const recipientRaw = r.fields.recipient as string | undefined;
      if (!recipientRaw) return false;
      return recipientMatchNames.has(recipientRaw.toLowerCase());
    })
    .map((r) => {
      const parsed = parseGrantRecord(r);
      // For received grants, show the funder instead of recipient
      const funderEntity = getKBEntity(r.ownerEntityId);
      const funderSlug = funderEntity ? getKBEntitySlug(r.ownerEntityId) : null;
      return {
        ...parsed,
        funderName: funderEntity?.name ?? r.ownerEntityId,
        funderHref: funderSlug ? `/organizations/${funderSlug}` : null,
      };
    })
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  // ── Divisions (org subdivisions) ──
  const divisionRecords = getKBRecords(entity.id, "divisions");
  const divisions = divisionRecords
    .map(parseDivisionRecord)
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Funding Programs (RFPs, grant rounds, fellowships, etc.) ──
  const fundingProgramRecords = getKBRecords(entity.id, "funding-programs");
  const fundingPrograms = fundingProgramRecords
    .map(parseFundingProgramRecord)
    .sort((a, b) => (b.totalBudget ?? 0) - (a.totalBudget ?? 0));

  // ── Key Personnel (key-person, board, career records owned by this org) ──
  const personnelRecords = getKBRecords(entity.id, "personnel");
  const personnel = personnelRecords
    .map((r) => {
      const parsed = parsePersonnelRecord(r);
      const resolved = parsed.personId
        ? resolveRecipient(parsed.personId)
        : { name: titleCase(r.key.replace(/-/g, " ")), href: null };
      return {
        ...parsed,
        personName: resolved.name,
        personHref: resolved.href,
      };
    })
    .sort((a, b) => {
      // Founders first, then key-person, then board, then career
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1;
      const typeOrder: Record<string, number> = { "key-person": 0, board: 1, career: 2 };
      const aOrder = typeOrder[a.roleType] ?? 3;
      const bOrder = typeOrder[b.roleType] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.personName.localeCompare(b.personName);
    });

  // ── Funding Rounds ──
  const fundingRoundRecords = getKBRecords(entity.id, "funding-rounds");
  const fundingRounds = fundingRoundRecords
    .map((r) => {
      const parsed = parseFundingRoundRecord(r);
      const resolved = parsed.leadInvestor
        ? resolveRecipient(parsed.leadInvestor)
        : { name: "", href: null };
      return {
        ...parsed,
        leadInvestorName: resolved.name,
        leadInvestorHref: resolved.href,
      };
    })
    .sort((a, b) => {
      // Sort by date descending (most recent first)
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return (b.raised ?? 0) - (a.raised ?? 0);
    });

  // ── Investments Received ──
  const investmentRecords = getKBRecords(entity.id, "investments");
  const investmentsReceived = investmentRecords
    .map((r) => {
      const parsed = parseInvestmentRecord(r);
      const resolved = parsed.investorId
        ? resolveRecipient(parsed.investorId)
        : { name: "", href: null };
      return {
        ...parsed,
        investorName: resolved.name,
        investorHref: resolved.href,
      };
    })
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  // ── Equity Positions ──
  const equityPositionRecords = getKBRecords(entity.id, "equity-positions");
  const equityPositions = equityPositionRecords
    .map((r) => {
      const parsed = parseEquityPositionRecord(r);
      const resolved = parsed.holderId
        ? resolveRecipient(parsed.holderId)
        : { name: "", href: null };
      return {
        ...parsed,
        holderName: resolved.name,
        holderHref: resolved.href,
      };
    })
    .sort((a, b) => (b.stake ?? 0) - (a.stake ?? 0));

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          { label: entity.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <h1 className="text-3xl font-extrabold tracking-tight">
            {entity.name}
          </h1>
          {orgType && (
            <span
              className={`px-2.5 py-1 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                ORG_TYPE_COLORS[orgType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {ORG_TYPE_LABELS[orgType] ?? orgType}
            </span>
          )}
        </div>
        {entity.aliases && entity.aliases.length > 0 && (
          <p className="text-sm text-muted-foreground/70 mb-2">
            Also known as: {entity.aliases.join(", ")}
          </p>
        )}

        {/* Description */}
        {descriptionText && (
          <p className="text-sm text-muted-foreground leading-relaxed mb-3 max-w-prose">
            {descriptionText}
          </p>
        )}

        {/* Metadata row: website, headquarters, links */}
        <div className="flex items-center gap-4 text-sm flex-wrap">
          {websiteUrl && (
            <a
              href={websiteUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              {shortDomain(websiteUrl)}{" "}
              &#8599;
            </a>
          )}
          {hqText && (
            <span className="text-muted-foreground">
              HQ: {hqText}
            </span>
          )}
          {wikiHref && (
            <Link
              href={wikiHref}
              className="text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
          <Link
            href={`/kb/entity/${entity.id}`}
            className="text-primary hover:text-primary/80 font-medium transition-colors"
          >
            KB data &rarr;
          </Link>
        </div>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {HERO_STATS.map((propId) => {
          const fact = getKBLatest(entity.id, propId);
          if (!fact) return null;
          const prop = getKBProperty(propId);
          return (
            <StatCard
              key={propId}
              label={prop?.name ?? titleCase(propId)}
              value={<FactValueDisplay fact={fact} property={prop} />}
              sub={fact.asOf ? `as of ${formatKBDate(fact.asOf)}` : undefined}
            />
          );
        })}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Main content */}
        <div className="lg:col-span-2 space-y-8">
          {/* Funding rounds (timeline style like KB page) */}
          {sortedRounds.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <SectionHeader title="Funding History" count={sortedRounds.length} />
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="text-xs text-primary hover:underline shrink-0"
                >
                  View all &rarr;
                </Link>
              </div>
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedRounds.slice(0, 8).map((round) => {
                  const name = field(round, "name") ?? titleCase(round.key);
                  const date = field(round, "date");
                  const raised = round.fields.raised;
                  const valuation = round.fields.valuation;
                  const leadInvestor = field(round, "lead_investor");
                  const { name: leadInvestorName, href: leadInvestorHref } =
                    resolveRefName(leadInvestor, undefined);
                  const instrument = field(round, "instrument");
                  const notes = field(round, "notes");
                  const source = field(round, "source");

                  return (
                    <div
                      key={round.key}
                      className="flex gap-4 py-4 border-b border-border/40 last:border-b-0 group/row hover:bg-muted/20 -mx-4 px-4 transition-colors"
                    >
                      {/* Timeline dot */}
                      <div className="flex flex-col items-center pt-1">
                        <div className="w-3 h-3 rounded-full border-2 border-primary/50 bg-card shrink-0 group-hover/row:border-primary transition-colors" />
                        <div className="w-px flex-1 bg-gradient-to-b from-border/50 to-transparent mt-1" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-semibold text-sm">{name}</span>
                          {instrument && (
                            <Badge>{instrument}</Badge>
                          )}
                          {date && (
                            <span className="text-xs text-muted-foreground/70">
                              {formatKBDate(date)}
                            </span>
                          )}
                        </div>
                        <div className="flex items-baseline gap-4 mt-1.5 flex-wrap">
                          {raised != null && (
                            <span className="text-base font-bold tabular-nums tracking-tight">
                              {formatAmount(raised)}
                            </span>
                          )}
                          {valuation != null && (
                            <span className="text-xs text-muted-foreground">
                              at {formatAmount(valuation)} valuation
                            </span>
                          )}
                          {leadInvestor && (
                            <span className="text-xs text-muted-foreground">
                              Led by{" "}
                              {leadInvestorHref ? (
                                <Link
                                  href={leadInvestorHref}
                                  className="text-primary hover:underline"
                                >
                                  {leadInvestorName}
                                </Link>
                              ) : (
                                leadInvestorName
                              )}
                            </span>
                          )}
                        </div>
                        {notes && (
                          <div className="text-[10px] text-muted-foreground/50 mt-1.5 line-clamp-2">
                            {notes}
                          </div>
                        )}
                        <SourceLink source={source} />
                      </div>
                    </div>
                  );
                })}
              </div>
              {sortedRounds.length > 8 && (
                <Link
                  href={`/organizations/${slug}/funding`}
                  className="block mt-2 text-xs text-primary hover:underline text-center"
                >
                  +{sortedRounds.length - 8} more rounds
                </Link>
              )}
            </section>
          )}

          {/* Investments (investor participation) */}
          {investments.length > 0 && (
            <section>
              <SectionHeader title="Investor Participation" count={investments.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {investments.map((inv) => {
                  const investorRef = field(inv, "investor");
                  const { name: investorName, href: investorHref } =
                    resolveRefName(
                      investorRef,
                      inv.displayName ?? field(inv, "display_name"),
                    );
                  const roundName = field(inv, "round_name");
                  const amount = inv.fields.amount;
                  const date = field(inv, "date");
                  const notes = field(inv, "notes");

                  return (
                    <div
                      key={inv.key}
                      className="px-4 py-3"
                    >
                      <div className="flex items-center gap-4">
                        <div className="flex-1 min-w-0">
                          {investorHref ? (
                            <Link
                              href={investorHref}
                              className="font-semibold text-sm text-primary hover:underline"
                            >
                              {investorName}
                            </Link>
                          ) : (
                            <span className="font-semibold text-sm">
                              {investorName}
                            </span>
                          )}
                          {roundName && (
                            <span className="ml-2 text-xs text-muted-foreground">
                              {roundName}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-3 text-sm tabular-nums">
                          {amount != null && (
                            <span className="font-bold">
                              {formatAmount(amount)}
                            </span>
                          )}
                          {date && (
                            <span className="text-xs text-muted-foreground">
                              {formatKBDate(date)}
                            </span>
                          )}
                        </div>
                      </div>
                      {notes && (
                        <div className="text-[10px] text-muted-foreground/50 mt-1 line-clamp-2">
                          {notes}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Model releases */}
          {sortedModels.length > 0 && (
            <section>
              <SectionHeader title="Model Releases" count={sortedModels.length} />
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedModels.map((model) => {
                  const name = field(model, "name") ?? titleCase(model.key);
                  const released = field(model, "released");
                  const safetyLevel = field(model, "safety_level");
                  const description = field(model, "description");
                  const source = field(model, "source");

                  return (
                    <div
                      key={model.key}
                      className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-b-0"
                    >
                      <div className="min-w-[70px] text-xs text-muted-foreground pt-0.5">
                        {released ? formatKBDate(released) : "\u2014"}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-baseline gap-2 flex-wrap">
                          <span className="font-medium text-sm">{name}</span>
                          {safetyLevel && (
                            <Badge
                              color={
                                SAFETY_LEVEL_COLORS[safetyLevel] ??
                                "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                              }
                            >
                              {safetyLevel}
                            </Badge>
                          )}
                        </div>
                        {description && (
                          <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                            {description}
                          </p>
                        )}
                        <SourceLink source={source} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Products (card grid like KB page) */}
          {products.length > 0 && (
            <section>
              <SectionHeader title="Products" count={products.length} />
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {products.map((prod) => {
                  const name = field(prod, "name") ?? titleCase(prod.key);
                  const launched = field(prod, "launched");
                  const description = field(prod, "description");
                  const source = field(prod, "source");

                  return (
                    <div
                      key={prod.key}
                      className="group rounded-xl border border-border/60 bg-card p-4 transition-all hover:shadow-md hover:border-border"
                    >
                      <div className="flex items-baseline gap-2">
                        <span className="font-semibold text-sm group-hover:text-primary transition-colors">
                          {name}
                        </span>
                        {launched && (
                          <span className="text-[10px] text-muted-foreground/60">
                            {formatKBDate(launched)}
                          </span>
                        )}
                      </div>
                      {description && (
                        <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">
                          {description}
                        </div>
                      )}
                      {source && isUrl(source) && (
                        <div className="mt-1.5">
                          <SourceLink source={source} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Safety milestones */}
          {sortedMilestones.length > 0 && (
            <section>
              <SectionHeader title="Safety Milestones" count={sortedMilestones.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {sortedMilestones.map((ms) => {
                  const name = field(ms, "name") ?? titleCase(ms.key);
                  const date = field(ms, "date");
                  const msType = field(ms, "type");
                  const description = field(ms, "description");
                  const source = field(ms, "source");

                  return (
                    <div key={ms.key} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold text-sm">{name}</span>
                        {msType && (
                          <Badge
                            color={
                              MILESTONE_TYPE_COLORS[msType] ??
                              "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                            }
                          >
                            {titleCase(msType)}
                          </Badge>
                        )}
                        {date && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatKBDate(date)}
                          </span>
                        )}
                      </div>
                      {description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {description}
                        </p>
                      )}
                      <SourceLink source={source} />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Strategic partnerships */}
          {sortedPartnerships.length > 0 && (
            <section>
              <SectionHeader title="Strategic Partnerships" count={sortedPartnerships.length} />
              <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
                {sortedPartnerships.map((sp) => {
                  const partnerRef = field(sp, "partner");
                  const { name: partnerName, href: partnerHref } =
                    resolveRefName(partnerRef, sp.displayName);
                  const date = field(sp, "date");
                  const spType = field(sp, "type");
                  const investmentAmount = sp.fields.investment_amount;
                  const computeCommitment = sp.fields.compute_commitment;
                  const notes = field(sp, "notes");
                  const source = field(sp, "source");

                  return (
                    <div key={sp.key} className="px-4 py-3">
                      <div className="flex items-center gap-2 mb-1">
                        {partnerHref ? (
                          <Link
                            href={partnerHref}
                            className="font-semibold text-sm text-primary hover:underline"
                          >
                            {partnerName}
                          </Link>
                        ) : (
                          <span className="font-semibold text-sm">
                            {partnerName}
                          </span>
                        )}
                        {spType && (
                          <Badge>{spType}</Badge>
                        )}
                        {date && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            {formatKBDate(date)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-4 text-xs text-muted-foreground">
                        {investmentAmount != null && (
                          <span>
                            Investment: <span className="font-semibold text-foreground">{formatAmount(investmentAmount)}</span>
                          </span>
                        )}
                        {computeCommitment != null && (
                          <span>
                            Compute: <span className="font-semibold text-foreground">{formatAmount(computeCommitment)}</span>
                          </span>
                        )}
                      </div>
                      {notes && (
                        <div className="text-[10px] text-muted-foreground/50 mt-1 line-clamp-2">
                          {notes}
                        </div>
                      )}
                      <SourceLink source={source} />
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {/* Other data (dynamic rendering for non-curated collections) */}
          {otherCollections.length > 0 && (
            <section>
              <SectionHeader title="Other Data" />
              {otherCollections.map(([name]) => (
                <KBRecordCollection
                  key={name}
                  entity={entity.id}
                  collection={name}
                />
              ))}
            </section>
          )}
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Key People */}
          {sortedPersons.length > 0 && (
            <section>
              <SectionHeader title="Key People" count={sortedPersons.length} />
              <div className="border border-border/60 rounded-xl bg-card px-4">
                {sortedPersons.map((person) => {
                  const personRef = field(person, "person");
                  const personEntityId = personRef
                    ? resolveKBSlug(personRef)
                    : undefined;
                  const personEntity = personEntityId
                    ? getKBEntity(personEntityId)
                    : undefined;
                  const name =
                    field(person, "display_name") ??
                    personEntity?.name ??
                    titleCase(personRef ?? person.key);

                  return (
                    <PersonRow
                      key={person.key}
                      name={name}
                      title={field(person, "title")}
                      slug={personRef}
                      entityType={personEntity?.type}
                      isFounder={!!person.fields.is_founder}
                      start={field(person, "start")}
                      end={field(person, "end")}
                      notes={field(person, "notes")}
                    />
                  );
                })}
              </div>
            </section>
          )}

          {/* Facts sidebar */}
          {allFacts.length > 0 && (
            <FactsPanel facts={allFacts} entityId={entity.id} />
          )}

          {/* Grants Made (this org is the funder) */}
          <GrantsMadeSection
            grants={grantsMade}
            orgName={entity.name}
            totalCount={grantsMade.length}
          />

          {/* Funding Received (this org is a grant recipient) */}
          <FundingReceivedSection grants={grantsReceived} />

          {/* Divisions (org subdivisions: funds, teams, labs, etc.) */}
          <DivisionsSection divisions={divisions} />

          {/* Funding Programs (RFPs, grant rounds, fellowships, etc.) */}
          <FundingProgramsSection programs={fundingPrograms} />

          {/* Key Personnel (key people, board members) */}
          <KeyPersonnelSection personnel={personnel} />

          {/* Funding Rounds (equity funding rounds) */}
          <FundingRoundsSection rounds={fundingRounds} />

          {/* Investments Received */}
          <InvestmentsReceivedSection investments={investmentsReceived} />

          {/* Equity Positions (ownership stakes) */}
          <EquityPositionsSection positions={equityPositions} />

          {/* AI Models section */}
          {orgModels.length > 0 && (
            <section>
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-bold tracking-tight">
                  AI Models ({orgModels.length})
                </h2>
                <Link
                  href={`/ai-models`}
                  className="text-xs text-primary hover:underline"
                >
                  View all models &rarr;
                </Link>
              </div>
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                      <th className="py-2 px-3 text-left font-medium">Model</th>
                      <th className="py-2 px-3 text-left font-medium">Released</th>
                      <th className="py-2 px-3 text-right font-medium">Pricing (in/out)</th>
                      <th className="py-2 px-3 text-right font-medium">Context</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {orgModels.map((model) => {
                      const href = model.numericId ? `/wiki/${model.numericId}` : getEntityHref(model.id, model.entityType);
                      return (
                        <tr key={model.id} className="hover:bg-muted/20 transition-colors">
                          <td className="py-2 px-3">
                            <Link href={href} className="font-medium text-foreground hover:text-primary transition-colors">
                              {model.title}
                            </Link>
                          </td>
                          <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                            {model.releaseDate ?? ""}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums">
                            {model.inputPrice != null && model.outputPrice != null
                              ? `$${model.inputPrice} / $${model.outputPrice}`
                              : ""}
                          </td>
                          <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap">
                            {model.contextWindow != null
                              ? `${formatCompactNumber(model.contextWindow)} tokens`
                              : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
