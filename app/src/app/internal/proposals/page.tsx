import { getProposals, getEntityHref } from "@/data";
import { ProposalsTable, type ProposalRow } from "./proposals-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Proposals Dashboard | Longterm Wiki Internal",
  description:
    "Browse all tactical proposals with cost/EV estimates, feasibility, and honest concerns.",
};

export default function ProposalsPage() {
  const proposals = getProposals();

  const domains = new Set(proposals.map((p) => p.domain).filter(Boolean));
  const stances = new Set(proposals.map((p) => p.stance).filter(Boolean));

  const rows: ProposalRow[] = proposals.map((item) => ({
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
    sourcePageHref: item.sourcePageId ? getEntityHref(item.sourcePageId) : null,
    leadOrganizations: item.leadOrganizations || [],
    relatedProposals: item.relatedProposals || [],
  }));

  return (
    <article className="prose max-w-none">
      <h1>Proposals Dashboard</h1>
      <p className="text-muted-foreground">
        Tactical proposals from <code>data/proposals.yaml</code> — concrete,
        specific actions someone could fund or execute.{" "}
        <span className="font-medium text-foreground">
          {proposals.length}
        </span>{" "}
        proposals across{" "}
        <span className="font-medium text-foreground">{domains.size}</span>{" "}
        domains and{" "}
        <span className="font-medium text-foreground">{stances.size}</span>{" "}
        stances.
      </p>
      {proposals.length === 0 ? (
        <p className="text-muted-foreground italic">
          No proposals loaded. Ensure <code>data/proposals.yaml</code> exists
          and run <code>pnpm build</code>.
        </p>
      ) : (
        <ProposalsTable data={rows} />
      )}
    </article>
  );
}
