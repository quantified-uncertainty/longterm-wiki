import { getProposals, getEntityHref } from "@/data";
import {
  ProposalsTable,
  type ProposalRow,
  type ProposalSummary,
} from "./proposals-table";
import { computeLeverage } from "./leverage";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Proposals Dashboard | Longterm Wiki Internal",
  description:
    "Browse all tactical proposals with cost/EV estimates, feasibility, and honest concerns.",
};

export default function ProposalsPage() {
  const proposals = getProposals();

  const rows: ProposalRow[] = proposals.map((item) => {
    const lev = computeLeverage(item.costEstimate || "", item.evEstimate || "");
    return {
      id: item.id,
      name: item.name,
      description: item.description || "",
      domain: item.domain || "unknown",
      stance: item.stance || "neutral",
      costEstimate: item.costEstimate || "",
      evEstimate: item.evEstimate || "",
      feasibility: item.feasibility || "",
      honestConcerns: item.honestConcerns || "",
      status: item.status || "idea",
      sourcePageId: item.sourcePageId || "",
      sourcePageHref: item.sourcePageId
        ? getEntityHref(item.sourcePageId)
        : null,
      leadOrganizations: item.leadOrganizations || [],
      relatedProposals: item.relatedProposals || [],
      leverage: lev.ratio,
      leverageLabel: lev.label,
    };
  });

  // Compute summary stats
  const byDomain: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byStance: Record<string, number> = {};

  for (const row of rows) {
    byDomain[row.domain] = (byDomain[row.domain] || 0) + 1;
    byStatus[row.status] = (byStatus[row.status] || 0) + 1;
    byStance[row.stance] = (byStance[row.stance] || 0) + 1;
  }

  const topLeverage = rows
    .filter((r) => r.leverage !== null)
    .sort((a, b) => (b.leverage ?? 0) - (a.leverage ?? 0))
    .slice(0, 5)
    .map((r) => ({ name: r.name, leverageLabel: r.leverageLabel }));

  const summary: ProposalSummary = {
    total: rows.length,
    byDomain,
    byStatus,
    byStance,
    topLeverage,
  };

  return (
    <article className="prose max-w-none">
      <h1>Proposals Dashboard</h1>
      <p className="text-muted-foreground">
        Tactical proposals from <code>data/proposals.yaml</code> — concrete
        actions someone could fund or execute. Click any row to expand full
        details including honest concerns. Leverage = EV midpoint / cost
        midpoint.
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground italic">
          No proposals loaded. Ensure <code>data/proposals.yaml</code> exists
          and run <code>pnpm build</code>.
        </p>
      ) : (
        <ProposalsTable data={rows} summary={summary} />
      )}
    </article>
  );
}
