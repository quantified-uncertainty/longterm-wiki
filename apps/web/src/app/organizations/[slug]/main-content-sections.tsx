/**
 * Main content column sections for organization profile pages.
 * These sections render KB record collections inline (funding history timeline,
 * investor participation, model releases, products, safety milestones,
 * strategic partnerships, and other data collections).
 *
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import type { KBRecordEntry } from "@/data/factbase";
import { getRecordVerdict } from "@data/tablebase";
import { getSourceCheckHref } from "@/app/source-checks/source-checks-shared";
import {
  formatKBDate,
  titleCase,
  isUrl,
} from "@/components/wiki/factbase/format";
import { FBRecordCollection } from "@/components/wiki/factbase/FBRecordCollection";
import { RecordStatusDots } from "@/components/coverage/RecordStatusDots";
import { computeFundingRoundCoverage, computeGenericCoverage } from "@/components/coverage/coverage-score";
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

  const hasValuation = rounds.some((r) => r.fields.valuation != null);
  const hasLeadInvestor = rounds.some((r) => field(r, "lead_investor"));
  const hasInstrument = rounds.some((r) => field(r, "instrument"));

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
              {hasValuation && (
                <th scope="col" className="py-2 px-3 text-right font-medium">Valuation</th>
              )}
              {hasLeadInvestor && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Lead Investor</th>
              )}
              {hasInstrument && (
                <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Type</th>
              )}
              <th scope="col" className="py-2 px-2 w-16" />
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
              const roundVerdict = getRecordVerdict("funding-round", String(round.key))?.verdict;

              return (
                <tr key={round.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-2 px-3 font-medium">
                    <Link href={`/funding-rounds/${round.key}`} className="text-foreground hover:text-primary transition-colors">
                      {name}
                    </Link>
                  </td>
                  <td className="py-2 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : "\u2014"}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                    {raised != null ? formatAmount(raised) : "\u2014"}
                  </td>
                  {hasValuation && (
                    <td className="py-2 px-3 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                      {valuation != null ? formatAmount(valuation) : "\u2014"}
                    </td>
                  )}
                  {hasLeadInvestor && (
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
                  )}
                  {hasInstrument && (
                    <td className="py-2 px-3 hidden lg:table-cell">
                      {instrument && <Badge>{instrument}</Badge>}
                    </td>
                  )}
                  <td className="py-2 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeFundingRoundCoverage({
                        raised: typeof raised === "number" ? raised : undefined,
                        valuation: typeof valuation === "number" ? valuation : undefined,
                        leadInvestorName: leadInvestorName,
                        date,
                        instrument,
                      })}
                      verdict={roundVerdict}
                      sourcingHref={getSourceCheckHref("funding-round", String(round.key))}
                    />
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

  const hasRound = investments.some((inv) => field(inv, "round_name"));
  const hasAmount = investments.some((inv) => inv.fields.amount != null);
  const hasDate = investments.some((inv) => field(inv, "date"));

  return (
    <section>
      <SectionHeader title="Investor Participation" count={investments.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Investor</th>
              {hasRound && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Round</th>
              )}
              {hasAmount && (
                <th scope="col" className="py-2 px-3 text-right font-medium">Amount</th>
              )}
              {hasDate && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              )}
              <th scope="col" className="py-2 px-2 w-16" />
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
              const invVerdict = getRecordVerdict("investment", String(inv.key))?.verdict;

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
                  {hasRound && (
                    <td className="py-1.5 px-3 text-muted-foreground">
                      {roundName ? (
                        <Link href={`/investments/${inv.key}`} className="text-muted-foreground hover:text-primary transition-colors">
                          {roundName}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground/40">{"\u2014"}</span>
                      )}
                    </td>
                  )}
                  {hasAmount && (
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                      {amount != null ? formatAmount(amount) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  {hasDate && (
                    <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                      {date ? formatKBDate(date) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeGenericCoverage({
                        filledFieldCount: (amount != null ? 1 : 0) + (roundName ? 1 : 0) + (date ? 1 : 0),
                      })}
                      verdict={invVerdict}
                      sourcingHref={getSourceCheckHref("investment", String(inv.key))}
                    />
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
              <th scope="col" className="py-2 px-2 w-16" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {products.map((prod) => {
              const name = field(prod, "name") ?? titleCase(prod.key);
              const launched = field(prod, "launched");
              const description = field(prod, "description");
              const source = field(prod, "source");
              const prodVerdict = getRecordVerdict("product", String(prod.key))?.verdict;

              return (
                <tr key={prod.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3 font-medium">{name}</td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {launched ? formatKBDate(launched) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                  </td>
                  {hasDescription && (
                    <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                      {description ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  {hasSource && (
                    <td className="py-1.5 px-3">
                      {source && isUrl(source) ? <SourceLink source={source} /> : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeGenericCoverage({
                        description: field(prod, "description"),
                        filledFieldCount: (field(prod, "status") ? 1 : 0) + (field(prod, "website") ? 1 : 0),
                      })}
                      verdict={prodVerdict}
                      sourcingHref={getSourceCheckHref("product", String(prod.key))}
                    />
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

// ── Safety Milestones ───────────────────────────────────────────────

export function SafetyMilestonesSection({
  milestones,
}: {
  milestones: KBRecordEntry[];
}) {
  if (milestones.length === 0) return null;

  const hasType = milestones.some((ms) => field(ms, "type"));
  const hasDescription = milestones.some((ms) => field(ms, "description"));
  const hasSource = milestones.some((ms) => {
    const s = field(ms, "source");
    return s && isUrl(s);
  });

  return (
    <section>
      <SectionHeader title="Safety Milestones" count={milestones.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Milestone</th>
              {hasType && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Type</th>
              )}
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              {hasDescription && (
                <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Description</th>
              )}
              {hasSource && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Source</th>
              )}
              <th scope="col" className="py-2 px-2 w-16" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {milestones.map((ms) => {
              const name = field(ms, "name") ?? titleCase(ms.key);
              const date = field(ms, "date");
              const msType = field(ms, "type");
              const description = field(ms, "description");
              const source = field(ms, "source");
              const msVerdict = getRecordVerdict("safety-milestone", String(ms.key))?.verdict;

              return (
                <tr key={ms.key} className="hover:bg-muted/20 transition-colors">
                  <td className="py-1.5 px-3 font-medium">{name}</td>
                  {hasType && (
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
                  )}
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                  </td>
                  {hasDescription && (
                    <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                      {description ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  {hasSource && (
                    <td className="py-1.5 px-3">
                      <SourceLink source={source} />
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeGenericCoverage({
                        description: field(ms, "description"),
                        filledFieldCount: (field(ms, "date") ? 1 : 0) + (field(ms, "source") ? 1 : 0),
                      })}
                      verdict={msVerdict}
                      sourcingHref={getSourceCheckHref("safety-milestone", String(ms.key))}
                    />
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

  const hasType = partnerships.some((sp) => field(sp, "type"));
  const hasInvestment = partnerships.some((sp) => sp.fields.investment_amount != null);
  const hasCompute = partnerships.some((sp) => sp.fields.compute_commitment != null);
  const hasNotes = partnerships.some((sp) => field(sp, "notes"));

  return (
    <section>
      <SectionHeader title="Strategic Partnerships" count={partnerships.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Partner</th>
              {hasType && (
                <th scope="col" className="py-2 px-3 text-left font-medium">Type</th>
              )}
              {hasInvestment && (
                <th scope="col" className="py-2 px-3 text-right font-medium">Investment</th>
              )}
              {hasCompute && (
                <th scope="col" className="py-2 px-3 text-right font-medium">Compute</th>
              )}
              <th scope="col" className="py-2 px-3 text-left font-medium">Date</th>
              {hasNotes && (
                <th scope="col" className="py-2 px-3 text-left font-medium hidden lg:table-cell">Notes</th>
              )}
              <th scope="col" className="py-2 px-2 w-16" />
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
              const spVerdict = getRecordVerdict("strategic-partnership", String(sp.key))?.verdict;

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
                  {hasType && (
                    <td className="py-1.5 px-3">
                      {spType && <Badge>{spType}</Badge>}
                    </td>
                  )}
                  {hasInvestment && (
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                      {investmentAmount != null ? formatAmount(investmentAmount) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  {hasCompute && (
                    <td className="py-1.5 px-3 text-right tabular-nums font-semibold whitespace-nowrap">
                      {computeCommitment != null ? formatAmount(computeCommitment) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                    {date ? formatKBDate(date) : <span className="text-muted-foreground/40">{"\u2014"}</span>}
                  </td>
                  {hasNotes && (
                    <td className="py-1.5 px-3 text-muted-foreground text-xs max-w-xs truncate hidden lg:table-cell">
                      {notes ?? <span className="text-muted-foreground/40">{"\u2014"}</span>}
                    </td>
                  )}
                  <td className="py-1.5 px-2 text-right">
                    <RecordStatusDots
                      coverageScore={computeGenericCoverage({
                        description: field(sp, "description"),
                        filledFieldCount: (field(sp, "date") ? 1 : 0) + (field(sp, "partner") ? 1 : 0),
                      })}
                      verdict={spVerdict}
                      sourcingHref={getSourceCheckHref("strategic-partnership", String(sp.key))}
                    />
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
        <FBRecordCollection
          key={name}
          entity={entityId}
          collection={name}
        />
      ))}
    </section>
  );
}
