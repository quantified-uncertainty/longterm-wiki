import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, getTypedEntityById, isProject } from "@/data";

import { getEntityHref } from "@/data/entity-nav";
import { ProfileStatCard } from "@/components/directory";
import { getKBLatest } from "@/data/factbase";
import { ProjectsTable, type ProjectRow } from "./projects-table";
import { TableSkeleton } from "@/components/ui/table-states";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Directory of AI safety tools, platforms, forecasting systems, and research projects tracked in the knowledge base.",
};

// ── Types for API response ────────────────────────────────────────────────

interface DirectoryFact {
  value: string | null;
  numeric: number | null;
  asOf: string | null;
  label: string | null;
  format: string | null;
  formatDivisor: number | null;
}

interface DirectoryEntity {
  id: string;
  wikiId: string | null;
  stableId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  facts: Record<string, DirectoryFact>;
  resolvedRefs: Record<string, { name: string; entityId: string }>;
  counts: { careerHistory: number; grantsGiven: number; grantsReceived: number };
}

interface DirectoryResult {
  entities: DirectoryEntity[];
  total: number;
}

// ── Data shape ────────────────────────────────────────────────────────────

interface ProjectsPageData {
  rows: ProjectRow[];
  stats: StatDef[];
}

interface StatDef {
  label: string;
  value: string;
}

// ── API-first data loading ────────────────────────────────────────────────

function apiEntityToRow(e: DirectoryEntity): ProjectRow {
  const meta = e.metadata ?? {};
  const foundedBy = e.resolvedRefs["founded-by"];

  // Website: use fact value, then metadata fields, then entity website
  const websiteFact = e.facts["website"];
  const website =
    websiteFact?.value ??
    (meta.projectUrl as string | undefined) ??
    e.website ??
    null;

  // Org: from resolved ref of "founded-by" fact, then YAML organization field
  let orgName = foundedBy?.name ?? null;
  let orgHref = foundedBy?.entityId
    ? getEntityHref(foundedBy.entityId)
    : null;

  // Fallback: use the organization field from entity metadata (YAML)
  if (!orgName && meta.organization) {
    const orgId = meta.organization as string;
    // The directory API includes resolvedRefs for fact-based refs but not YAML fields,
    // so resolve the entity title from the slug using local data.
    const orgEntity = getTypedEntityById(orgId);
    if (orgEntity) {
      orgName = orgEntity.title;
      orgHref = getEntityHref(orgEntity.id);
    } else {
      // Fallback: use the slug as display name if entity not found locally
      orgName = orgId;
      orgHref = getEntityHref(orgId);
    }
  }

  return {
    id: e.id,
    title: e.title,
    description: e.description ?? null,
    wikiId: e.wikiId ?? null,
    // projectStatus is in metadata; status is a base-level column not in metadata
    status: (meta.projectStatus as string | undefined) ?? null,
    website,
    // clusters is a separate DB column not included in the directory API response;
    // tags serve as a reasonable proxy for display purposes
    clusters: e.tags ?? [],
    orgName,
    orgHref,
    verdictString: null, // project has no sourcing verdicts yet (QUA-211)
  };
}

async function loadFromApi(): Promise<FetchResult<ProjectsPageData>> {
  const result = await fetchDetailed<DirectoryResult>(
    "/api/entities/directory?entityType=project&measures=founded-by,website",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  // Deduplicate entities by title. The PG entities table can contain stale
  // rows where the slug was reassigned — the old row's id is set to its
  // stableId (a hash-like string) and both the old and new rows appear.
  // Keep the row with a slug-style id (contains hyphens) over hash-style ids,
  // or the one with a wikiId, or the first one seen.
  const seen = new Map<string, DirectoryEntity>();
  for (const e of result.data.entities) {
    const key = e.title.toLowerCase().trim();
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, e);
      continue;
    }
    // Prefer slug-style ids (contain hyphens) over hash-style ids
    const hasSlugId = (ent: DirectoryEntity) => ent.id.includes("-");
    const hasWikiId = (ent: DirectoryEntity) => ent.wikiId != null;
    if (
      (!hasSlugId(existing) && hasSlugId(e)) ||
      (!hasWikiId(existing) && hasWikiId(e))
    ) {
      seen.set(key, e);
    }
  }

  const rows = Array.from(seen.values()).map(apiEntityToRow);
  const stats = buildStats(rows);

  return { ok: true, data: { rows, stats } };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

function loadFromLocal(): ProjectsPageData {
  const projects = getTypedEntities().filter(isProject).filter((e) => !e.deprecated);

  const rows: ProjectRow[] = projects.map((p) => {
    // Resolve org from founded-by KB fact, then YAML organization field
    let orgName: string | null = null;
    let orgHref: string | null = null;
    const foundedBy = getKBLatest(p.id, "founded-by");
    if (foundedBy?.value.type === "refs" && foundedBy.value.value.length > 0) {
      const orgRef = foundedBy.value.value[0];
      const orgEntity = getTypedEntityById(orgRef);
      if (orgEntity) {
        orgName = orgEntity.title;
        orgHref = getEntityHref(orgEntity.id);
      }
    }

    // Fallback: use the organization field from entity YAML
    if (!orgName && p.organization) {
      const orgEntity = getTypedEntityById(p.organization);
      if (orgEntity) {
        orgName = orgEntity.title;
        orgHref = getEntityHref(orgEntity.id);
      }
    }

    // Resolve website from KB fact
    const websiteFact = getKBLatest(p.id, "website");
    const website =
      (websiteFact?.value.type === "text" ? websiteFact.value.value : null) ??
      p.projectUrl ??
      p.website ??
      null;

    return {
      id: p.id,
      title: p.title,
      description: p.description ?? null,
      wikiId: p.wikiId ?? null,
      status: p.projectStatus ?? p.status ?? null,
      website,
      clusters: p.clusters,
      orgName,
      orgHref,
      verdictString: null, // project has no sourcing verdicts yet (QUA-211)
    };
  });

  const stats = buildStats(rows);
  return { rows, stats };
}

// ── Shared stats computation ──────────────────────────────────────────────

function buildStats(rows: ProjectRow[]): StatDef[] {
  const withWebsite = rows.filter((r) => r.website).length;
  const withOrg = rows.filter((r) => r.orgName).length;

  return [
    { label: "Projects", value: String(rows.length) },
    { label: "With Website", value: String(withWebsite) },
    { label: "With Organization", value: String(withOrg) },
  ];
}

// ── Page component ────────────────────────────────────────────────────────

export default async function ProjectsPage() {
  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(),
    () => loadFromLocal(),
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Projects
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety tools, platforms, forecasting systems, and research
          projects.
        </p>
      </div>

      <DataSourceBanner source={source} apiError={apiError} />

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {data.stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <Suspense fallback={<TableSkeleton rows={10} columns={5} />}>
        <ProjectsTable rows={data.rows} />
      </Suspense>
    </div>
  );
}
