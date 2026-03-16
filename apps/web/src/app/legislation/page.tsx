import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, isPolicy } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { LegislationTable, type LegislationRow } from "./legislation-table";
import { normalizeStatus } from "./legislation-constants";
import { deriveStatus, getPolicyScope, inferScope } from "./legislation-utils";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

export const metadata: Metadata = {
  title: "Legislation",
  description:
    "Directory of AI-related legislation, policies, and regulatory frameworks tracked in the knowledge base.",
};

// ── Types for API response ────────────────────────────────────────────────

interface DirectoryEntity {
  id: string;
  numericId: string | null;
  stableId: string | null;
  entityType: string;
  title: string;
  description: string | null;
  website: string | null;
  metadata: Record<string, unknown> | null;
  tags: string[] | null;
  facts: Record<string, unknown>;
  resolvedRefs: Record<string, { name: string; entityId: string }>;
  counts: { careerHistory: number; grantsGiven: number; grantsReceived: number };
}

interface DirectoryResult {
  entities: DirectoryEntity[];
  total: number;
}

// ── Data shape ────────────────────────────────────────────────────────────

interface LegislationPageData {
  rows: LegislationRow[];
  stats: StatDef[];
}

interface StatDef {
  label: string;
  value: string;
}

// ── API-first data loading ────────────────────────────────────────────────

const VALID_SCOPES = new Set(["state", "federal", "international", "national"]);

function apiEntityToRow(e: DirectoryEntity): LegislationRow {
  const meta = e.metadata ?? {};
  const policyStatus = (meta.policyStatus as string | undefined) ?? null;

  // Derive status from policyStatus metadata field
  // Note: customFields (used for legacy status derivation) are a separate DB column
  // not included in the directory API response, so only policyStatus is available here.
  const effectiveStatus = policyStatus;

  // Derive scope
  const rawScope = (meta.scope as string | undefined) ?? null;
  const scope = (rawScope && VALID_SCOPES.has(rawScope.toLowerCase()))
    ? rawScope
    : inferScope(e.tags ?? [], e.id);

  return {
    id: e.id,
    title: e.title,
    numericId: e.numericId ?? null,
    introduced: (meta.introduced as string | undefined) ?? null,
    policyStatus: effectiveStatus,
    statusKey: normalizeStatus(effectiveStatus),
    author: (meta.author as string | undefined) ?? null,
    scope,
    description: e.description ?? null,
    tags: e.tags ?? [],
    // sources column is not included in directory API response; sourceCount unavailable
    sourceCount: 0,
  };
}

async function loadFromApi(): Promise<FetchResult<LegislationPageData>> {
  const result = await fetchDetailed<DirectoryResult>(
    "/api/entities/directory?entityType=policy",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  const rows = result.data.entities.map(apiEntityToRow);
  const stats = buildStats(rows);

  return { ok: true, data: { rows, stats } };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

function loadFromLocal(): LegislationPageData {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy);

  const rows: LegislationRow[] = policies.map((entity) => {
    const effectiveStatus = deriveStatus(entity);
    const scope = getPolicyScope(entity);

    return {
      id: entity.id,
      title: entity.title,
      numericId: entity.numericId ?? null,
      introduced: entity.introduced ?? null,
      policyStatus: effectiveStatus,
      statusKey: normalizeStatus(effectiveStatus),
      author: entity.author ?? null,
      scope,
      description: entity.description ?? null,
      tags: entity.tags,
      sourceCount: entity.sources.length,
    };
  });

  const stats = buildStats(rows);
  return { rows, stats };
}

// ── Shared stats computation ──────────────────────────────────────────────

function buildStats(rows: LegislationRow[]): StatDef[] {
  const totalPolicies = rows.length;
  const withStatus = rows.filter((r) => r.statusKey != null).length;
  const enacted = rows.filter((r) =>
    r.statusKey === "enacted" || r.statusKey === "in-effect",
  ).length;
  const vetoed = rows.filter((r) => r.statusKey === "vetoed").length;

  return [
    { label: "Policies", value: String(totalPolicies) },
    { label: "With Status", value: String(withStatus) },
    { label: "Enacted / In Effect", value: String(enacted) },
    { label: "Vetoed", value: String(vetoed) },
  ];
}

// ── Page component ────────────────────────────────────────────────────────

export default async function LegislationPage() {
  const { data, source, apiError } = await withApiFallback(
    () => loadFromApi(),
    () => loadFromLocal(),
  );

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Legislation
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI-related legislation, policies, and regulatory frameworks. Includes
          national and international laws, executive orders, and proposed bills.
        </p>
      </div>

      <DataSourceBanner source={source} apiError={apiError} />

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {data.stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <Suspense fallback={<div>Loading...</div>}>
        <LegislationTable rows={data.rows} />
      </Suspense>
    </div>
  );
}
