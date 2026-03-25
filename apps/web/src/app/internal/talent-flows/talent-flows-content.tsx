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
  StatCards,
  type FlowEdge,
  type OrgNetFlow,
} from "./talent-flows-table";

// ---- Data Loading ----

async function loadFromApi(): Promise<FetchResult<RpcTalentFlowsResult>> {
  return fetchDetailed<RpcTalentFlowsResult>(
    "/api/talent-flows/",
    { revalidate: 3600 }
  );
}

function emptyFallback(): RpcTalentFlowsResult {
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
        Career transitions across the AI safety ecosystem, computed from personnel records.
        Each transition represents a person moving from one organization to another.
      </p>

      <StatCards stats={stats} />

      {/* Net Talent Flow */}
      <div className="mb-10">
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          Net Talent Flow
          <span className="text-xs font-normal text-muted-foreground">
            by organization
          </span>
        </h2>
        <p className="text-muted-foreground text-xs mb-3">
          Positive = net talent gain, negative = net talent loss. Bar shows
          relative in/out volume.
        </p>
        <OrgNetFlowTable orgNetFlows={orgNetFlows as OrgNetFlow[]} />
      </div>

      {/* Org-to-Org Transitions */}
      <div>
        <h2 className="text-base font-semibold mb-1 flex items-center gap-2">
          Transition Routes
          <span className="text-xs font-normal text-muted-foreground">
            org-to-org
          </span>
        </h2>
        <p className="text-muted-foreground text-xs mb-3">
          Click any row to see who made that transition. Sorted by volume.
        </p>
        <FlowEdgesTable flows={flows as FlowEdge[]} />
      </div>
    </>
  );
}
