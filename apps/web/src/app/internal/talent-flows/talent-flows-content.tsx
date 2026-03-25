import {
  fetchDetailed,
  withApiFallback,
  type FetchResult,
  type RpcTalentFlowsResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import {
  FlowEdgesTable,
  OrgNetFlowTable,
  type FlowEdge,
  type OrgNetFlow,
} from "./talent-flows-table";

// ---- Types ----

interface DashboardData {
  flows: FlowEdge[];
  orgNetFlows: OrgNetFlow[];
  stats: {
    totalTransitions: number;
    uniquePeople: number;
    uniqueOrgs: number;
  };
}

// ---- Data Loading ----

async function loadFromApi(): Promise<FetchResult<DashboardData>> {
  const result = await fetchDetailed<RpcTalentFlowsResult>(
    "/api/talent-flows/",
    { revalidate: 300 }
  );
  if (!result.ok) return result;
  return { ok: true, data: result.data };
}

function emptyFallback(): DashboardData {
  return {
    flows: [],
    orgNetFlows: [],
    stats: { totalTransitions: 0, uniquePeople: 0, uniqueOrgs: 0 },
  };
}

// ---- Component ----

export async function TalentFlowsContent() {
  const { data, source, apiError } = await withApiFallback(
    loadFromApi,
    emptyFallback
  );

  const { flows, orgNetFlows, stats } = data;

  return (
    <>
      <DataSourceBanner source={source} apiError={apiError} />

      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        Org-to-org career transitions computed from the personnel table.
        For each person with 2+ career records ordered by start date,
        consecutive organizations form directed edges.{" "}
        <span className="font-medium text-foreground">
          {stats.totalTransitions}
        </span>{" "}
        transitions across{" "}
        <span className="font-medium text-foreground">
          {stats.uniquePeople}
        </span>{" "}
        people and{" "}
        <span className="font-medium text-foreground">
          {stats.uniqueOrgs}
        </span>{" "}
        organizations.
      </p>

      {/* Net Talent Gain/Loss */}
      <h2 className="text-lg font-semibold mt-8 mb-3">
        Net Talent Flow by Organization
      </h2>
      <p className="text-muted-foreground text-xs mb-3">
        Sorted by absolute net flow. Positive = net talent gain, negative = net talent loss.
      </p>
      <OrgNetFlowTable orgNetFlows={orgNetFlows} />

      {/* Org-to-Org Flow Edges */}
      <h2 className="text-lg font-semibold mt-8 mb-3">
        Org-to-Org Transitions
      </h2>
      <p className="text-muted-foreground text-xs mb-3">
        Each row is a directed edge showing how many people moved from one org to another.
        Click &ldquo;Show&rdquo; to see individual people.
      </p>
      <FlowEdgesTable flows={flows} />
    </>
  );
}
