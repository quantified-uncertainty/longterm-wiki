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

// ---- Mock data for development (before wiki-server has the route deployed) ----

function devFallback(): DashboardData {
  if (process.env.NODE_ENV !== "development") {
    return { flows: [], orgNetFlows: [], stats: { totalTransitions: 0, uniquePeople: 0, uniqueOrgs: 0 } };
  }

  // Realistic mock data based on actual career records in the personnel table
  const flows: FlowEdge[] = [
    {
      fromOrg: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" },
      toOrg: { id: "mK9pX3rQ7n", name: "Anthropic", slug: "anthropic" },
      count: 12,
      people: [
        { name: "Dario Amodei", slug: "dario-amodei", role: "CEO", year: "2021" },
        { name: "Daniela Amodei", slug: "daniela-amodei", role: "President", year: "2021" },
        { name: "Chris Olah", slug: "chris-olah", role: "Head of Interpretability", year: "2021" },
        { name: "Tom Brown", slug: "tom-brown", role: "Co-founder", year: "2021" },
        { name: "Sam McCandlish", slug: "sam-mccandlish", role: "Co-founder", year: "2021" },
        { name: "Jared Kaplan", slug: "jared-kaplan", role: "Co-founder", year: "2021" },
        { name: "Jack Clark", slug: "jack-clark", role: "Head of Policy", year: "2021" },
        { name: "Jan Leike", slug: "jan-leike", role: "Head of Alignment", year: "2024" },
        { name: "John Schulman", slug: "john-schulman", role: "Researcher", year: "2024" },
        { name: "Catherine Olsson", slug: "catherine-olsson", role: "Researcher", year: "2021" },
        { name: "Tom Henighan", slug: "tom-henighan", role: "Researcher", year: "2021" },
        { name: "Ben Mann", slug: "ben-mann", role: "Infrastructure", year: "2021" },
      ],
    },
    {
      fromOrg: { id: "A4XoubikkQ", name: "Google DeepMind", slug: "deepmind" },
      toOrg: { id: "mK9pX3rQ7n", name: "Anthropic", slug: "anthropic" },
      count: 3,
      people: [
        { name: "Jan Leike", slug: "jan-leike", role: "Alignment Lead", year: "2024" },
        { name: "Nova DasSarma", slug: "nova-dassarma", role: "Researcher", year: "2022" },
        { name: "Chris Olah", slug: "chris-olah", role: "Researcher", year: "2018" },
      ],
    },
    {
      fromOrg: { id: "AZmSQxCAlk", name: "Google Brain", slug: "google-brain" },
      toOrg: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" },
      count: 4,
      people: [
        { name: "Ilya Sutskever", slug: "ilya-sutskever", role: "Chief Scientist", year: "2015" },
        { name: "Barret Zoph", slug: "barret-zoph", role: "VP Research", year: "2022" },
        { name: "Lukasz Kaiser", slug: "lukasz-kaiser", role: "Researcher", year: "2021" },
        { name: "Jason Wei", slug: "jason-wei", role: "Researcher", year: "2023" },
      ],
    },
    {
      fromOrg: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" },
      toOrg: { id: "1OSiYOaWVL", name: "SSI", slug: "ssi" },
      count: 1,
      people: [
        { name: "Ilya Sutskever", slug: "ilya-sutskever", role: "Chief Scientist", year: "2024" },
      ],
    },
    {
      fromOrg: { id: "A4XoubikkQ", name: "Google DeepMind", slug: "deepmind" },
      toOrg: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" },
      count: 2,
      people: [
        { name: "Richard Ngo", slug: "richard-ngo", role: "Governance", year: "2023" },
        { name: "Jan Leike", slug: "jan-leike", role: "Alignment", year: "2021" },
      ],
    },
    {
      fromOrg: { id: "puAffUjWSS", name: "MIRI", slug: "miri" },
      toOrg: { id: "NifCYhN75w", name: "Open Philanthropy", slug: "open-philanthropy" },
      count: 1,
      people: [
        { name: "Luke Muehlhauser", slug: "luke-muehlhauser", role: "Senior Analyst", year: "2017" },
      ],
    },
    {
      fromOrg: { id: "Zmw9nfUYWA", name: "FHI", slug: "fhi" },
      toOrg: { id: "NifCYhN75w", name: "Open Philanthropy", slug: "open-philanthropy" },
      count: 1,
      people: [
        { name: "Nick Beckstead", slug: "nick-beckstead", role: "Head of AI Safety", year: "2016" },
      ],
    },
    {
      fromOrg: { id: "XLLyzaEaCA", name: "GovAI", slug: "govai" },
      toOrg: { id: "A4XoubikkQ", name: "Google DeepMind", slug: "deepmind" },
      count: 1,
      people: [
        { name: "Allan Dafoe", slug: "allan-dafoe", role: "VP AI Safety", year: "2023" },
      ],
    },
    {
      fromOrg: { id: "A4XoubikkQ", name: "Google DeepMind", slug: "deepmind" },
      toOrg: { id: "GLXKjYAEKw", name: "xAI", slug: "xai" },
      count: 1,
      people: [
        { name: "Sholto Douglas", slug: "sholto-douglas", role: "Researcher", year: "2023" },
      ],
    },
    {
      fromOrg: { id: "XLLyzaEaCA", name: "GovAI", slug: "govai" },
      toOrg: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" },
      count: 1,
      people: [
        { name: "Jade Leung", slug: "jade-leung", role: "VP Global Affairs", year: "2022" },
      ],
    },
  ];

  const orgNetFlows: OrgNetFlow[] = [
    { org: { id: "mK9pX3rQ7n", name: "Anthropic", slug: "anthropic" }, inflows: 15, outflows: 0, net: 15 },
    { org: { id: "1LcLlMGLbw", name: "OpenAI", slug: "openai" }, inflows: 7, outflows: 14, net: -7 },
    { org: { id: "A4XoubikkQ", name: "Google DeepMind", slug: "deepmind" }, inflows: 2, outflows: 7, net: -5 },
    { org: { id: "AZmSQxCAlk", name: "Google Brain", slug: "google-brain" }, inflows: 0, outflows: 4, net: -4 },
    { org: { id: "NifCYhN75w", name: "Open Philanthropy", slug: "open-philanthropy" }, inflows: 3, outflows: 1, net: 2 },
    { org: { id: "puAffUjWSS", name: "MIRI", slug: "miri" }, inflows: 0, outflows: 2, net: -2 },
    { org: { id: "XLLyzaEaCA", name: "GovAI", slug: "govai" }, inflows: 0, outflows: 2, net: -2 },
    { org: { id: "fYyAxYlHDQ", name: "US AISI", slug: "us-aisi" }, inflows: 2, outflows: 0, net: 2 },
    { org: { id: "GLXKjYAEKw", name: "xAI", slug: "xai" }, inflows: 1, outflows: 0, net: 1 },
    { org: { id: "1OSiYOaWVL", name: "SSI", slug: "ssi" }, inflows: 1, outflows: 0, net: 1 },
    { org: { id: "Zmw9nfUYWA", name: "FHI", slug: "fhi" }, inflows: 0, outflows: 1, net: -1 },
  ];

  return {
    flows,
    orgNetFlows,
    stats: { totalTransitions: 28, uniquePeople: 24, uniqueOrgs: 11 },
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
  // In development, use mock data so the UI can be designed
  const mock = devFallback();
  if (mock.flows.length > 0) return mock;
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
        <OrgNetFlowTable orgNetFlows={orgNetFlows} />
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
        <FlowEdgesTable flows={flows} />
      </div>
    </>
  );
}
