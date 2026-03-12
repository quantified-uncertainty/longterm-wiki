import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { resolveOrgBySlug, getOrgSlugs } from "@/app/organizations/org-utils";
import {
  getKBLatest,
  getKBFacts,
  getKBProperty,
  getKBEntity,
  getKBEntitySlug,
  getKBRecords,
  getAllKBRecords,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById, isOrganization } from "@/data";
import {
  formatKBDate,
  titleCase,
  shortDomain,
} from "@/components/wiki/kb/format";
import { formatCompactCurrency } from "@/lib/format-compact";
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
function parseGrantRecord(record: KBRecordEntry): {
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

function parseDivisionRecord(record: KBRecordEntry) {
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

function parseFundingProgramRecord(record: KBRecordEntry) {
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

  // Header facts
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All facts for the panel
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Description and website come from typed entity YAML data
  const descriptionText = orgData?.description ?? null;
  const websiteUrl = orgData?.website ?? null;

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
  const allGrantRecords = getAllKBRecords("grants");
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

        {/* Metadata row */}
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
        </div>

        {/* Sidebar */}
        <div className="space-y-8">
          {/* Quick links */}
          {allFacts.length > 0 && (
            <section>
              <h2 className="text-lg font-bold tracking-tight mb-4">
                Quick Links
              </h2>
              <div className="flex flex-col gap-2">
                <Link
                  href={`/kb/entity/${entity.id}`}
                  className="text-xs text-primary hover:underline"
                >
                  View all facts in KB explorer &rarr;
                </Link>
                {wikiHref && (
                  <Link
                    href={wikiHref}
                    className="text-xs text-primary hover:underline"
                  >
                    Wiki page &rarr;
                  </Link>
                )}
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
