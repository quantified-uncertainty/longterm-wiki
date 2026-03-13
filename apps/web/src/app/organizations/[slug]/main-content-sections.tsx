/**
 * Main content column sections for organization profile pages.
 * These sections render KB record collections inline (funding history timeline,
 * investor participation, model releases, products, safety milestones,
 * strategic partnerships, and other data collections).
 *
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import type { KBRecordEntry } from "@/data/kb";
import {
  formatKBDate,
  titleCase,
  isUrl,
} from "@/components/wiki/kb/format";
import { KBRecordCollection } from "@/components/wiki/kb/KBRecordCollection";
import {
  SectionHeader,
  SourceLink,
  Badge,
  field,
  resolveRefName,
} from "./org-shared";
import {
  formatAmount,
  SAFETY_LEVEL_COLORS,
  MILESTONE_TYPE_COLORS,
} from "./org-data";

// ── Funding History (timeline) ───────────────────────────────────────

export function FundingHistorySection({
  rounds,
  slug,
}: {
  rounds: KBRecordEntry[];
  slug: string;
}) {
  if (rounds.length === 0) return null;

  return (
    <section>
      <div className="flex items-center justify-between mb-4">
        <SectionHeader title="Funding History" count={rounds.length} />
        <Link
          href={`/organizations/${slug}/funding`}
          className="text-xs text-primary hover:underline shrink-0"
        >
          View all &rarr;
        </Link>
      </div>
      <div className="border border-border/60 rounded-xl bg-card px-4">
        {rounds.slice(0, 8).map((round) => {
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
              <div className="flex flex-col items-center pt-1" aria-hidden="true">
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
                  <div className="text-[11px] text-muted-foreground mt-1.5 line-clamp-2">
                    {notes}
                  </div>
                )}
                <SourceLink source={source} />
              </div>
            </div>
          );
        })}
      </div>
      {rounds.length > 8 && (
        <Link
          href={`/organizations/${slug}/funding`}
          className="block mt-2 text-xs text-primary hover:underline text-center"
        >
          +{rounds.length - 8} more rounds
        </Link>
      )}
    </section>
  );
}

// ── Investor Participation ───────────────────────────────────────────

export function InvestorParticipationSection({
  investments,
}: {
  investments: KBRecordEntry[];
}) {
  if (investments.length === 0) return null;

  return (
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
                <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                  {notes}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Model Releases ──────────────────────────────────────────────────

export function ModelReleasesSection({
  models,
}: {
  models: KBRecordEntry[];
}) {
  if (models.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Model Releases" count={models.length} />
      <div className="border border-border/60 rounded-xl bg-card px-4">
        {models.map((model) => {
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
  );
}

// ── Products ────────────────────────────────────────────────────────

export function ProductsSection({
  products,
}: {
  products: KBRecordEntry[];
}) {
  if (products.length === 0) return null;

  return (
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
                  <span className="text-[11px] text-muted-foreground">
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
  );
}

// ── Safety Milestones ───────────────────────────────────────────────

export function SafetyMilestonesSection({
  milestones,
}: {
  milestones: KBRecordEntry[];
}) {
  if (milestones.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Safety Milestones" count={milestones.length} />
      <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
        {milestones.map((ms) => {
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
  );
}

// ── Strategic Partnerships ──────────────────────────────────────────

export function StrategicPartnershipsSection({
  partnerships,
}: {
  partnerships: KBRecordEntry[];
}) {
  if (partnerships.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Strategic Partnerships" count={partnerships.length} />
      <div className="border border-border/60 rounded-xl divide-y divide-border/40 bg-card">
        {partnerships.map((sp) => {
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
                <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2">
                  {notes}
                </div>
              )}
              <SourceLink source={source} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── Other Data Collections ──────────────────────────────────────────

export function OtherDataSection({
  collections,
  entityId,
}: {
  collections: [string, KBRecordEntry[]][];
  entityId: string;
}) {
  if (collections.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Other Data" />
      {collections.map(([name]) => (
        <KBRecordCollection
          key={name}
          entity={entityId}
          collection={name}
        />
      ))}
    </section>
  );
}
