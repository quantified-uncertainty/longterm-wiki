import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllKBRecords,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById } from "@/data/database";
import { formatCompactCurrency } from "@/lib/format-compact";
import { Breadcrumbs } from "@/components/directory";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ParsedGrant {
  key: string;
  ownerEntityId: string;
  name: string;
  funderName: string;
  funderHref: string | null;
  recipientId: string | null;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null;
  currency: string | null;
  date: string | null;
  period: string | null;
  status: string | null;
  source: string | null;
  program: string | null;
  programId: string | null;
  notes: string | null;
}

// ── Resolution helpers ─────────────────────────────────────────────────

function resolveEntityLink(entityId: string): { name: string; href: string | null } {
  const entity = getKBEntity(entityId);
  if (entity) {
    const slug = getKBEntitySlug(entityId);
    if (slug) {
      if (entity.type === "organization") return { name: entity.name, href: `/organizations/${slug}` };
      if (entity.type === "person") return { name: entity.name, href: `/people/${slug}` };
    }
    return { name: entity.name, href: `/kb/entity/${entityId}` };
  }
  return { name: titleCase(entityId.replace(/-/g, " ")), href: null };
}

function parseGrant(record: KBRecordEntry): ParsedGrant {
  const f = record.fields;
  const funder = resolveEntityLink(record.ownerEntityId);
  const recipientId = typeof f.recipient === "string" ? f.recipient : null;
  const recipient = recipientId
    ? resolveEntityLink(recipientId)
    : { name: "", href: null };

  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: (f.name as string) ?? record.key,
    funderName: funder.name,
    funderHref: funder.href,
    recipientId,
    recipientName: recipient.name,
    recipientHref: recipient.href,
    amount: typeof f.amount === "number" ? f.amount : null,
    currency: typeof f.currency === "string" ? f.currency : null,
    date: typeof f.date === "string" ? f.date : null,
    period: typeof f.period === "string" ? f.period : null,
    status: typeof f.status === "string" ? f.status : null,
    source: typeof f.source === "string" ? f.source : null,
    program: typeof f.program === "string" ? f.program : null,
    programId: typeof f.programId === "string" ? f.programId : null,
    notes: typeof f.notes === "string" ? f.notes : null,
  };
}

// ── Rendering mode ─────────────────────────────────────────────────────
// Render on-demand to reduce build output size.
// Grant detail pages are new and low-traffic.

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const allGrants = getAllKBRecords("grants");
  const record = allGrants.find((r) => r.key === id);
  if (!record) {
    return { title: "Grant Not Found" };
  }
  const grant = parseGrant(record);
  const title = grant.name;
  const parts = [title];
  if (grant.funderName) parts.push(`funded by ${grant.funderName}`);
  if (grant.amount) parts.push(formatCompactCurrency(grant.amount));

  return {
    title: `${title} | Grants`,
    description: parts.join(" — "),
  };
}

// ── Status badge colors ────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  completed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  "winding-down": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  terminated: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

// ── Page ───────────────────────────────────────────────────────────────

export default async function GrantDetailPage({ params }: PageProps) {
  const { id } = await params;
  const allGrants = getAllKBRecords("grants");
  const record = allGrants.find((r) => r.key === id);

  if (!record) notFound();

  const grant = parseGrant(record);

  // Find related grants: same funder or same recipient
  const relatedByFunder = allGrants
    .filter((r) => r.ownerEntityId === grant.ownerEntityId && r.key !== grant.key)
    .map(parseGrant);

  const relatedByRecipient = grant.recipientId
    ? allGrants
        .filter(
          (r) =>
            r.key !== grant.key &&
            typeof r.fields.recipient === "string" &&
            r.fields.recipient === grant.recipientId &&
            r.ownerEntityId !== grant.ownerEntityId,
        )
        .map(parseGrant)
    : [];

  // Funder wiki page link
  const funderTypedEntity = getTypedEntityById(grant.ownerEntityId);
  const funderWikiPageId = funderTypedEntity?.numericId ?? null;

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Grants", href: "/grants" },
          { label: grant.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {grant.name}
          </h1>
          {grant.status && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                STATUS_COLORS[grant.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(grant.status)}
            </span>
          )}
        </div>

        {/* Amount hero */}
        {grant.amount != null && (
          <div className="text-3xl font-bold tabular-nums tracking-tight text-primary mb-1">
            {formatCompactCurrency(grant.amount)}
            {grant.currency && grant.currency !== "USD" && (
              <span className="text-base font-medium text-muted-foreground ml-2">
                {grant.currency}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Left column: key details */}
        <div className="space-y-4">
          <DetailSection title="Funder">
            <EntityLinkDisplay
              name={grant.funderName}
              href={grant.funderHref}
            />
            {funderWikiPageId && (
              <Link
                href={`/wiki/${funderWikiPageId}`}
                className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                title="Wiki page"
              >
                wiki
              </Link>
            )}
          </DetailSection>

          {grant.recipientId && (
            <DetailSection title="Recipient">
              <EntityLinkDisplay
                name={grant.recipientName}
                href={grant.recipientHref}
              />
            </DetailSection>
          )}

          {(grant.program || grant.programId) && (
            <DetailSection title="Program">
              {grant.programId ? (
                <Link
                  href={`/funding-programs/${grant.programId}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {grant.program ?? grant.programId}
                </Link>
              ) : (
                <span className="text-sm text-foreground">{grant.program}</span>
              )}
            </DetailSection>
          )}

          {(grant.date || grant.period) && (
            <DetailSection title={grant.period ? "Period" : "Date"}>
              <span className="text-sm text-foreground">
                {grant.date ? formatKBDate(grant.date) : grant.period}
              </span>
            </DetailSection>
          )}
        </div>

        {/* Right column: supplementary info */}
        <div className="space-y-4">
          {grant.source && (
            <DetailSection title="Source">
              {isUrl(grant.source) ? (
                <a
                  href={grant.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(grant.source)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              ) : (
                <span className="text-sm text-foreground">{grant.source}</span>
              )}
            </DetailSection>
          )}

          {grant.notes && (
            <DetailSection title="Notes">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {grant.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Related grants: same funder */}
      {relatedByFunder.length > 0 && (
        <RelatedGrantsSection
          title={`Other Grants by ${grant.funderName}`}
          grants={relatedByFunder.slice(0, 10)}
          totalCount={relatedByFunder.length}
        />
      )}

      {/* Related grants: same recipient */}
      {relatedByRecipient.length > 0 && (
        <RelatedGrantsSection
          title={`Other Grants to ${grant.recipientName}`}
          grants={relatedByRecipient.slice(0, 10)}
          totalCount={relatedByRecipient.length}
        />
      )}

      {/* Back to listing */}
      <div className="mt-8 pt-6 border-t border-border/60">
        <Link
          href="/grants"
          className="text-sm text-primary hover:underline"
        >
          &larr; Back to all grants
        </Link>
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
        {title}
      </div>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

function EntityLinkDisplay({
  name,
  href,
}: {
  name: string;
  href: string | null;
}) {
  if (href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-primary hover:underline"
      >
        {name}
      </Link>
    );
  }
  return <span className="text-sm font-medium text-foreground">{name}</span>;
}

function RelatedGrantsSection({
  title,
  grants,
  totalCount,
}: {
  title: string;
  grants: ParsedGrant[];
  totalCount: number;
}) {
  return (
    <section className="mb-8">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-base font-bold tracking-tight">{title}</h2>
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {totalCount}
        </span>
        <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
      </div>
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th className="text-left py-2 px-3 font-medium">Grant</th>
              <th className="text-left py-2 px-3 font-medium">Funder</th>
              <th className="text-left py-2 px-3 font-medium">Recipient</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => (
              <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <Link
                    href={`/grants/${g.key}`}
                    className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                  >
                    {g.name}
                  </Link>
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
                    <span className="font-semibold">
                      {formatCompactCurrency(g.amount)}
                    </span>
                  )}
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {g.date ? formatKBDate(g.date) : g.period ?? ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {totalCount > 10 && (
        <div className="mt-2 text-xs text-muted-foreground text-center">
          Showing 10 of {totalCount} grants
        </div>
      )}
    </section>
  );
}
