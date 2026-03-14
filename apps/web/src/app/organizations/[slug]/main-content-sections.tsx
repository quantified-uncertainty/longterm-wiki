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
  MILESTONE_TYPE_COLORS,
} from "./org-data";

// ── Funding History (timeline) ───────────────────────────────────────

export function FundingHistorySection({
  rounds,
}: {
  rounds: KBRecordEntry[];
}) {
  if (rounds.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Funding History" count={rounds.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Round</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Raised</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Valuation</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Lead Investor</th>
              <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Type</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {[...rounds].reverse().map((round) => {
              const name = field(round, "name") ?? titleCase(round.key);
              const date = field(round, "date");
              const raised = round.fields.raised;
              const valuation = round.fields.valuation;
              const leadInvestor = field(round, "lead_investor");
              const { name: leadInvestorName, href: leadInvestorHref } =
                resolveRefName(leadInvestor, undefined);
              const instrument = field(round, "instrument");

              return (
                <tr key={round.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3 font-medium">{name}</td>
                  <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : "\u2014"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                    {raised != null ? formatAmount(raised) : "\u2014"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                    {valuation != null ? formatAmount(valuation) : "\u2014"}
                  </td>
                  <td className="py-2 px-3">
                    {leadInvestorHref ? (
                      <Link href={leadInvestorHref} className="text-primary hover:underline">
                        {leadInvestorName}
                      </Link>
                    ) : leadInvestor ? (
                      <span>{leadInvestorName}</span>
                    ) : (
                      <span className="text-muted-foreground">{"\u2014"}</span>
                    )}
                  </td>
                  <td className="py-2 px-3 hidden lg:table-cell">
                    {instrument && <Badge>{instrument}</Badge>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Investor</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Round</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Amount</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
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

              return (
                <tr key={inv.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3">
                    {investorHref ? (
                      <Link href={investorHref} className="font-medium text-foreground hover:text-primary transition-colors">
                        {investorName}
                      </Link>
                    ) : (
                      <span className="font-medium">{investorName}</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground">{roundName ?? ""}</td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                    {amount != null ? formatAmount(amount) : ""}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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

  const hasDescription = products.some((p) => field(p, "description"));
  const hasSource = products.some((p) => {
    const s = field(p, "source");
    return s && isUrl(s);
  });

  return (
    <section>
      <SectionHeader title="Products" count={products.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Product</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Launched</th>
              {hasDescription && (
                <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Description</th>
              )}
              {hasSource && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Source</th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {products.map((prod) => {
              const name = field(prod, "name") ?? titleCase(prod.key);
              const launched = field(prod, "launched");
              const description = field(prod, "description");
              const source = field(prod, "source");

              return (
                <tr key={prod.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3 font-medium">{name}</td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {launched ? formatKBDate(launched) : ""}
                  </td>
                  {hasDescription && (
                    <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                      {description ?? ""}
                    </td>
                  )}
                  {hasSource && (
                    <td className="py-1.5 px-3">
                      {source && isUrl(source) ? <SourceLink source={source} /> : ""}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
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
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Milestone</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Type</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Description</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Source</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {milestones.map((ms) => {
              const name = field(ms, "name") ?? titleCase(ms.key);
              const date = field(ms, "date");
              const msType = field(ms, "type");
              const description = field(ms, "description");
              const source = field(ms, "source");

              return (
                <tr key={ms.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3 font-medium">{name}</td>
                  <td className="py-1.5 px-3">
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
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : ""}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                    {description ?? ""}
                  </td>
                  <td className="py-1.5 px-3">
                    <SourceLink source={source} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Partner</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Type</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Investment</th>
              <th scope="col" className="py-2 px-3 text-right font-medium">Compute</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Notes</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {partnerships.map((sp) => {
              const partnerRef = field(sp, "partner");
              const { name: partnerName, href: partnerHref } =
                resolveRefName(partnerRef, sp.displayName);
              const date = field(sp, "date");
              const spType = field(sp, "type");
              const investmentAmount = sp.fields.investment_amount;
              const computeCommitment = sp.fields.compute_commitment;
              const notes = field(sp, "notes");

              return (
                <tr key={sp.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3">
                    {partnerHref ? (
                      <Link href={partnerHref} className="font-medium text-foreground hover:text-primary transition-colors">
                        {partnerName}
                      </Link>
                    ) : (
                      <span className="font-medium">{partnerName}</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3">
                    {spType && <Badge>{spType}</Badge>}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                    {investmentAmount != null ? formatAmount(investmentAmount) : ""}
                  </td>
                  <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                    {computeCommitment != null ? formatAmount(computeCommitment) : ""}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : ""}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                    {notes ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
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
