import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, isPolicy } from "@/data";
import { getRecordVerdict } from "@/data/tablebase";
import { ProfileStatCard } from "@/components/directory";
import { LegislationTable, type LegislationRow } from "./legislation-table";
import { normalizeStatus } from "./legislation-constants";
import { deriveStatus, getCustomField, getPolicyScope, inferScope } from "./legislation-utils";
import type { PolicyEntity } from "@/data";
import { fetchDetailed, withApiFallback, type FetchResult } from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";

// ── Last action derivation ────────────────────────────────────────────────

/** Timeline milestones in reverse chronological priority. */
const MILESTONE_FIELDS = [
  { label: "Revoked", action: "Revoked" },
  { label: "Vetoed", action: "Vetoed" },
  { label: "Enacted", action: "Enacted" },
  { label: "Signed", action: "Signed" },
  { label: "In Force", action: "In Force" },
  { label: "Effective", action: "Effective" },
  { label: "Passed Assembly", action: "Passed Assembly" },
  { label: "Passed Senate", action: "Passed Senate" },
  { label: "Passed Committee", action: "Passed Committee" },
];

function deriveLastAction(entity: PolicyEntity): { action: string; date: string | null } | null {
  for (const { label, action } of MILESTONE_FIELDS) {
    const value = getCustomField(entity, label);
    if (value) return { action, date: value };
  }
  // Fall back to status with introduced date
  if (entity.policyStatus) {
    return { action: entity.policyStatus, date: null };
  }
  return null;
}

function deriveLastActionFromStatus(status: string | null): { action: string; date: string | null } | null {
  if (!status) return null;
  return { action: status, date: null };
}

export const metadata: Metadata = {
  title: "Legislation",
  description:
    "Directory of AI-related legislation, policies, and regulatory frameworks tracked in the knowledge base.",
};

// ── Types for API response ────────────────────────────────────────────────

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
  summary: string;
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

  const lastActionInfo = deriveLastActionFromStatus(effectiveStatus);

  return {
    id: e.id,
    title: e.title,
    wikiId: e.wikiId ?? null,
    introduced: (meta.introduced as string | undefined) ?? null,
    policyStatus: effectiveStatus,
    statusKey: normalizeStatus(effectiveStatus),
    author: (meta.author as string | undefined) ?? null,
    scope,
    jurisdiction: (meta.jurisdiction as string | undefined) ?? null,
    billNumber: (meta.billNumber as string | undefined) ?? null,
    fullTextUrl: (meta.fullTextUrl as string | undefined) ?? null,
    lastAction: lastActionInfo?.action ?? null,
    lastActionDate: lastActionInfo?.date ?? null,
    description: e.description ?? null,
    tags: e.tags ?? [],
    verdictString: getRecordVerdict("policy", e.id)?.verdict ?? null,
  };
}

async function loadFromApi(): Promise<FetchResult<LegislationPageData>> {
  const result = await fetchDetailed<DirectoryResult>(
    "/api/entities/directory?entityType=policy",
    { revalidate: 60 },
  );

  if (!result.ok) return result;

  const rows = result.data.entities
    .filter((e) => !(e.metadata as Record<string, unknown> | null)?.deprecated)
    .map(apiEntityToRow);
  const stats = buildStats(rows);
  const summary = buildSummary(rows);

  return { ok: true, data: { rows, stats, summary } };
}

// ── Local data loading (fallback) ─────────────────────────────────────────

function loadFromLocal(): LegislationPageData {
  const allEntities = getTypedEntities();
  const policies = allEntities.filter(isPolicy).filter((e) => !e.deprecated);

  const rows: LegislationRow[] = policies.map((entity) => {
    const effectiveStatus = deriveStatus(entity);
    const scope = getPolicyScope(entity);

    const lastActionInfo = deriveLastAction(entity);

    return {
      id: entity.id,
      title: entity.title,
      wikiId: entity.wikiId ?? null,
      introduced: entity.introduced ?? null,
      policyStatus: effectiveStatus,
      statusKey: normalizeStatus(effectiveStatus),
      author: entity.author ?? null,
      scope,
      jurisdiction: entity.jurisdiction ?? null,
      billNumber: entity.billNumber ?? null,
      fullTextUrl: entity.fullTextUrl ?? null,
      lastAction: lastActionInfo?.action ?? null,
      lastActionDate: lastActionInfo?.date ?? null,
      description: entity.description ?? null,
      tags: entity.tags,
      verdictString: getRecordVerdict("policy", entity.id)?.verdict ?? null,
    };
  });

  const stats = buildStats(rows);
  const summary = buildSummary(rows);
  return { rows, stats, summary };
}

// ── Shared stats computation ──────────────────────────────────────────────

function buildSummary(rows: LegislationRow[]): string {
  const stateRows = rows.filter((r) => r.scope?.toLowerCase() === "state");
  const states = [...new Set(stateRows.map((r) => r.jurisdiction).filter(Boolean))];
  const countries = [...new Set(
    rows
      .filter((r) => r.scope?.toLowerCase() === "national")
      .map((r) => r.jurisdiction)
      .filter(Boolean),
  )];
  const hasIntl = rows.some((r) => r.scope?.toLowerCase() === "international");
  const hasFederal = rows.some((r) => r.scope?.toLowerCase() === "federal");

  const parts: string[] = [];
  if (states.length > 0) parts.push(`US state laws (${states.join(", ")})`);
  if (hasFederal) parts.push("US federal executive orders and frameworks");
  if (countries.length > 0) parts.push(`national regulations (${countries.join(", ")})`);
  if (hasIntl) parts.push("international agreements and treaties");

  if (parts.length === 0) {
    return `AI-related legislation, policies, and regulatory frameworks across ${rows.length} entries.`;
  }
  return `AI-related legislation, policies, and regulatory frameworks across ${rows.length} entries. Covers ${parts.join(", ")}.`;
}

function buildStats(rows: LegislationRow[]): StatDef[] {
  const totalPolicies = rows.length;
  const enacted = rows.filter((r) =>
    r.statusKey === "enacted" || r.statusKey === "in-effect",
  ).length;
  const jurisdictions = new Set(
    rows.map((r) => r.jurisdiction).filter(Boolean),
  ).size;
  const scopeCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.scope) {
      const key = r.scope.toLowerCase();
      scopeCounts.set(key, (scopeCounts.get(key) ?? 0) + 1);
    }
  }
  const scopeSummary = ["international", "federal", "national", "state"]
    .filter((s) => scopeCounts.has(s))
    .map((s) => `${scopeCounts.get(s)} ${s}`)
    .join(", ");

  return [
    { label: "Policies", value: String(totalPolicies) },
    { label: "Enacted / In Effect", value: String(enacted) },
    { label: "Jurisdictions", value: String(jurisdictions) },
    { label: "By Scope", value: scopeSummary || "—" },
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
          {data.summary}
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
