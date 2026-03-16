/**
 * Shared components and helpers for grant detail pages.
 * Used by both /organizations/[slug]/grants/[grantId] and /funding-programs/[id].
 */
import Link from "next/link";
import {
  getKBEntity,
  getKBEntitySlug,
} from "@/data/factbase";
import type { KBRecordEntry } from "@/data/factbase";
import { formatCompactCurrency } from "@/lib/format-compact";
import {
  formatKBDate,
  titleCase,
} from "@/components/wiki/factbase/format";

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedGrantDetail {
  key: string;
  ownerEntityId: string;
  name: string;
  funderName: string;
  funderSlug: string | null;
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

export function resolveEntityLink(entityId: string): {
  name: string;
  slug: string | null;
  href: string | null;
} {
  const entity = getKBEntity(entityId);
  if (entity) {
    const slug = getKBEntitySlug(entityId);
    if (slug) {
      if (entity.type === "organization")
        return { name: entity.name, slug, href: `/organizations/${slug}` };
      if (entity.type === "person")
        return { name: entity.name, slug, href: `/people/${slug}` };
    }
    return { name: entity.name, slug: null, href: `/factbase/entity/${entityId}` };
  }
  return { name: titleCase(entityId.replace(/-/g, " ")), slug: null, href: null };
}

export function parseGrantDetail(record: KBRecordEntry): ParsedGrantDetail {
  const f = record.fields;
  const funder = resolveEntityLink(record.ownerEntityId);
  const recipientId = typeof f.recipient === "string" ? f.recipient : null;
  const recipient = recipientId
    ? resolveEntityLink(recipientId)
    : { name: "", slug: null, href: null };

  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: (f.name as string) ?? record.key,
    funderName: funder.name,
    funderSlug: funder.slug,
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

/** Build the canonical grant detail URL for a grant. */
export function grantDetailHref(grant: { key: string; funderSlug: string | null }, orgSlug?: string): string | null {
  const slug = grant.funderSlug ?? orgSlug ?? null;
  return slug ? `/organizations/${slug}/grants/${grant.key}` : null;
}

// ── Shared UI components ──────────────────────────────────────────────

export function DetailSection({
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

export function EntityLinkDisplay({
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

export function RelatedGrantsSection({
  title,
  grants,
  totalCount,
  orgSlug,
}: {
  title: string;
  grants: ParsedGrantDetail[];
  totalCount: number;
  orgSlug?: string;
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
              <th className="text-left py-2 px-3 font-medium">Recipient</th>
              <th className="text-right py-2 px-3 font-medium">Amount</th>
              <th className="text-center py-2 px-3 font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {grants.map((g) => {
              const href = grantDetailHref(g, orgSlug);
              return (
                <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3">
                    {href ? (
                      <Link
                        href={href}
                        className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                      >
                        {g.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-foreground text-xs">
                        {g.name}
                      </span>
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
              );
            })}
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
