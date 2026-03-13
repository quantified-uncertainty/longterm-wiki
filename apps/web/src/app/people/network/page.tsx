import type { Metadata } from "next";
import {
  getKBEntities,
  getKBLatest,
  getKBEntity,
  getKBEntitySlug,
  getAllKBRecords,
} from "@/data/kb";
import { getExpertById } from "@/data";
import Link from "next/link";
import {
  NetworkGraph,
  type NetworkNode,
  type NetworkEdge,
} from "./network-graph";

export const metadata: Metadata = {
  title: "People & Organization Network",
  description:
    "Interactive network visualization showing connections between people and organizations in AI safety.",
};

/** Build the network data on the server, then pass it to the client graph. */
export default function PeopleNetworkPage() {
  const allEntities = getKBEntities();
  const people = allEntities.filter((e) => e.type === "person");
  const orgs = allEntities.filter((e) => e.type === "organization");

  // Build sets for quick lookups
  const personIds = new Set(people.map((p) => p.id));
  const orgIds = new Set(orgs.map((o) => o.id));

  // Collect key-person records (org→person edges)
  const allKeyPersons = getAllKBRecords("key-persons");

  // Build nodes
  const nodeMap = new Map<string, NetworkNode>();

  for (const person of people) {
    const slug = getKBEntitySlug(person.id) ?? person.id;
    const expert = getExpertById(slug);
    const roleFact = getKBLatest(person.id, "role");
    const role =
      roleFact?.value.type === "text" ? roleFact.value.value : undefined;
    const employedByFact = getKBLatest(person.id, "employed-by");
    const employerName =
      employedByFact?.value.type === "ref"
        ? getKBEntity(employedByFact.value.value)?.name
        : undefined;

    nodeMap.set(person.id, {
      id: person.id,
      label: person.name,
      type: "person",
      slug,
      numericId: person.numericId ?? undefined,
      role,
      employer: employerName,
      topicCount: expert?.positions?.length ?? 0,
    });
  }

  for (const org of orgs) {
    const slug = getKBEntitySlug(org.id) ?? org.id;
    nodeMap.set(org.id, {
      id: org.id,
      label: org.name,
      type: "organization",
      slug,
      numericId: org.numericId ?? undefined,
    });
  }

  // Build edges from key-person records
  const edges: NetworkEdge[] = [];
  const edgeSet = new Set<string>(); // deduplicate

  for (const rec of allKeyPersons) {
    const personId = rec.fields.person as string | undefined;
    const orgId = rec.ownerEntityId;
    if (!personId || !personIds.has(personId) || !orgIds.has(orgId)) continue;

    const edgeKey = `${personId}-${orgId}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    const title = rec.fields.title as string | undefined;
    const isFounder = rec.fields.is_founder === true;
    const endDate = rec.fields.end as string | undefined;

    edges.push({
      id: edgeKey,
      source: personId,
      target: orgId,
      label: title ?? "member",
      isFounder,
      isCurrent: !endDate,
    });
  }

  // Also add employed-by relationships that don't have key-person records
  for (const person of people) {
    const employedByFact = getKBLatest(person.id, "employed-by");
    if (!employedByFact || employedByFact.value.type !== "ref") continue;
    const orgEntityId = employedByFact.value.value;
    if (!orgIds.has(orgEntityId)) continue;

    const edgeKey = `${person.id}-${orgEntityId}`;
    if (edgeSet.has(edgeKey)) continue;
    edgeSet.add(edgeKey);

    edges.push({
      id: edgeKey,
      source: person.id,
      target: orgEntityId,
      label: "employed",
      isFounder: false,
      isCurrent: true,
    });
  }

  // Only include nodes that have at least one edge (connected)
  const connectedNodeIds = new Set<string>();
  for (const edge of edges) {
    connectedNodeIds.add(edge.source);
    connectedNodeIds.add(edge.target);
  }

  const nodes = Array.from(nodeMap.values()).filter((n) =>
    connectedNodeIds.has(n.id),
  );

  // Collect unique org names for filtering
  const orgNames = orgs
    .filter((o) => connectedNodeIds.has(o.id))
    .map((o) => o.name)
    .sort();

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-2">
          <Link
            href="/people"
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; People Directory
          </Link>
        </div>
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          People &amp; Organization Network
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Interactive network graph showing connections between people and
          organizations in AI safety. Edges represent employment, leadership, and
          founding relationships from the knowledge base.
        </p>
        <p className="text-muted-foreground text-xs mt-1">
          {nodes.filter((n) => n.type === "person").length} people &middot;{" "}
          {nodes.filter((n) => n.type === "organization").length} organizations
          &middot; {edges.length} connections
        </p>
      </div>

      <NetworkGraph nodes={nodes} edges={edges} orgNames={orgNames} />
    </div>
  );
}
