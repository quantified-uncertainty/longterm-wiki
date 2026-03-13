import type { Metadata } from "next";
import Link from "next/link";
import {
  getKBEntities,
  getKBLatest,
  getKBEntitySlug,
  getAllKBRecords,
} from "@/data/kb";
import { getExpertById } from "@/data";
import { getEntityHref } from "@/data/entity-nav";
import { NetworkGraph, type GraphNode, type GraphEdge } from "./network-graph";

export const metadata: Metadata = {
  title: "People & Organizations Network",
  description:
    "Interactive network visualization showing relationships between people and organizations in AI safety.",
};

/**
 * Build graph data from KB entities + relationships.
 *
 * Sources of relationships (in priority order):
 * 1. KB `employed-by` facts — current employer for each person
 * 2. KB `key-persons` records — orgs listing their key people
 * 3. YAML `relatedEntries` — entity-level associations
 * 4. `experts.yaml` `affiliation` field via getExpertById
 */
function buildGraphData(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const allEntities = getKBEntities();
  const people = allEntities.filter((e) => e.type === "person");
  const orgSet = new Set<string>();
  const edgeSet = new Set<string>(); // "personId->orgId" dedup
  const edges: GraphEdge[] = [];

  function addEdge(personId: string, orgId: string, label?: string) {
    const key = `${personId}->${orgId}`;
    if (edgeSet.has(key)) return;
    edgeSet.add(key);
    orgSet.add(orgId);
    edges.push({ source: personId, target: orgId, label });
  }

  // 1. KB employed-by facts
  for (const person of people) {
    const employedBy = getKBLatest(person.id, "employed-by");
    if (employedBy?.value.type === "ref") {
      const slug = getKBEntitySlug(employedBy.value.value);
      if (slug) {
        addEdge(person.id, slug, "employed");
      }
    }
  }

  // 2. KB key-persons records (org -> person links)
  const allKeyPersons = getAllKBRecords("key-persons");
  for (const rec of allKeyPersons) {
    const personId = rec.fields.person as string | undefined;
    if (!personId) continue;
    // ownerEntityId is the org's KB entity ID; get its slug
    const orgSlug = getKBEntitySlug(rec.ownerEntityId);
    if (!orgSlug) continue;
    // personId here is a KB entity ID; get slug
    const personSlug = getKBEntitySlug(personId);
    if (!personSlug) continue;
    const title = rec.fields.title as string | undefined;
    addEdge(personSlug, orgSlug, title ?? "key person");
  }

  // 3. Entity relatedEntries from YAML (for people without KB employed-by)
  for (const person of people) {
    const slug = getKBEntitySlug(person.id) ?? person.id;
    // Check if this person already has edges from KB data
    const entity = allEntities.find((e) => e.id === person.id);
    if (!entity) continue;

    // relatedEntries are not directly on KB entities; we use expert data instead
    // (covered by source 4 below)
  }

  // 4. Expert affiliation data
  for (const person of people) {
    const slug = getKBEntitySlug(person.id) ?? person.id;
    const expert = getExpertById(slug);
    if (expert?.affiliation) {
      const aff = expert.affiliation as string;
      if (aff && aff !== "independent") {
        addEdge(slug, aff, "affiliated");
      }
    }
  }

  // Build organization nodes (only for orgs that have connections)
  const orgEntities = allEntities.filter(
    (e) => e.type === "organization" || e.type?.startsWith("lab"),
  );
  const orgMap = new Map(
    orgEntities.map((e) => [getKBEntitySlug(e.id) ?? e.id, e]),
  );

  // Build people nodes (only those that have at least one connection)
  const connectedPeople = new Set(edges.map((e) => e.source));
  const personNodes: GraphNode[] = [];

  for (const person of people) {
    const slug = getKBEntitySlug(person.id) ?? person.id;
    if (!connectedPeople.has(slug)) continue;

    const roleFact = getKBLatest(person.id, "role");
    const role =
      roleFact?.value.type === "text" ? roleFact.value.value : undefined;
    const expert = getExpertById(slug);

    personNodes.push({
      id: slug,
      label: person.name,
      type: "person",
      href: getEntityHref(slug),
      detail: role ?? expert?.role ?? undefined,
    });
  }

  const orgNodes: GraphNode[] = [];
  for (const orgId of orgSet) {
    const orgEntity = orgMap.get(orgId);
    orgNodes.push({
      id: orgId,
      label: orgEntity?.name ?? orgId,
      type: "organization",
      href: getEntityHref(orgId),
      detail: orgEntity?.name ?? undefined,
    });
  }

  // Remap edges to use slugs consistently (they already use slugs from addEdge)
  // Filter edges where both source and target exist as nodes
  const nodeIds = new Set([
    ...personNodes.map((n) => n.id),
    ...orgNodes.map((n) => n.id),
  ]);
  const validEdges = edges.filter(
    (e) => nodeIds.has(e.source) && nodeIds.has(e.target),
  );

  return {
    nodes: [...personNodes, ...orgNodes],
    edges: validEdges,
  };
}

export default function PeopleNetworkPage() {
  const { nodes, edges } = buildGraphData();

  const personCount = nodes.filter((n) => n.type === "person").length;
  const orgCount = nodes.filter((n) => n.type === "organization").length;

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/people"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            People
          </Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-2xl font-extrabold tracking-tight">
            Relationship Network
          </h1>
        </div>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Interactive network showing employment and affiliation relationships
          between {personCount} people and {orgCount} organizations in the AI
          safety ecosystem. Data sourced from the knowledge base.
        </p>
      </div>

      <NetworkGraph nodes={nodes} edges={edges} />

      {/* Stats summary */}
      <div className="mt-6 grid grid-cols-3 gap-4 max-w-md">
        <div className="text-center p-3 rounded-lg bg-indigo-50 dark:bg-indigo-950">
          <div className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">
            {personCount}
          </div>
          <div className="text-xs text-muted-foreground">People</div>
        </div>
        <div className="text-center p-3 rounded-lg bg-amber-50 dark:bg-amber-950">
          <div className="text-2xl font-bold text-amber-600 dark:text-amber-400">
            {orgCount}
          </div>
          <div className="text-xs text-muted-foreground">Organizations</div>
        </div>
        <div className="text-center p-3 rounded-lg bg-gray-50 dark:bg-gray-800">
          <div className="text-2xl font-bold">{edges.length}</div>
          <div className="text-xs text-muted-foreground">Connections</div>
        </div>
      </div>
    </div>
  );
}
