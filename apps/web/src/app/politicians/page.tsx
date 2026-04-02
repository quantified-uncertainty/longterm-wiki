import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, type PersonEntity } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { PoliticiansTable, type PoliticianRow } from "./politicians-table";
import { EA_TOPICS, extractStanceLabel } from "./politicians-constants";

export const metadata: Metadata = {
  title: "Politicians",
  description:
    "Directory of political candidates and officeholders tracked for EA-relevant policy positions on AI safety, biosecurity, animal welfare, and more.",
};

// ── Data loading ──────────────────────────────────────────────────────────

function inferParty(entity: PersonEntity): string | null {
  const desc = (entity.description ?? "").toLowerCase();
  if (desc.includes("(d)") || desc.includes("democrat")) return "democratic";
  if (desc.includes("(r)") || desc.includes("republican")) return "republican";
  return null;
}

function inferOffice(entity: PersonEntity): string | null {
  const desc = entity.description ?? "";
  if (/U\.S\. Senator/i.test(desc)) return "U.S. Senator";
  if (/U\.S\. Representative/i.test(desc)) return "U.S. Representative";
  if (/State Senator/i.test(desc)) return "State Senator";
  if (/State Assembl/i.test(desc)) return "State Assemblymember";
  if (/Governor/i.test(desc)) return "Governor";
  if (/Attorney General/i.test(desc)) return "Attorney General";
  if (/candidate/i.test(desc)) return "Candidate";
  return null;
}

function inferJurisdiction(entity: PersonEntity): string | null {
  const desc = entity.description ?? "";
  // Match patterns like "NC-4", "NJ-5", "FL-19", "MI-11", "TX-10"
  const districtMatch = desc.match(/\b([A-Z]{2})-(\d+)\b/);
  if (districtMatch) return districtMatch[0];
  // Match state names for senators/governors
  const statePatterns = [
    /Nebraska/i, /Tennessee/i, /Maine/i, /Texas/i, /Georgia/i,
    /Florida/i, /Michigan/i, /North Carolina/i, /New York/i,
    /New Jersey/i, /Illinois/i, /Durham/i,
  ];
  for (const pattern of statePatterns) {
    const m = desc.match(pattern);
    if (m) return m[0];
  }
  return null;
}

function inferStatus(entity: PersonEntity): string | null {
  const desc = (entity.description ?? "").toLowerCase();
  if (desc.includes("incumbent") || desc.includes("u.s. senator") || desc.includes("u.s. representative") || desc.includes("state senator") || desc.includes("assemblymember")) return "incumbent";
  if (desc.includes("candidate") || desc.includes("running") || desc.includes("nominee") || desc.includes("runoff")) return "candidate";
  if (desc.includes("won the 2026") || desc.includes("won 2026")) return "incumbent";
  if (desc.includes("former") || desc.includes("lost")) return "former";
  return "candidate";
}

function loadPoliticians(): PoliticianRow[] {
  const allEntities = getTypedEntities();
  const politicians = allEntities.filter(
    (e): e is PersonEntity =>
      e.entityType === "person" &&
      (e.tags ?? []).includes("politics") &&
      !e.deprecated
  );

  return politicians.map((entity) => {
    const stances: Record<string, string> = {};
    for (const topic of EA_TOPICS) {
      const pos = (entity.positions ?? []).find(
        (p) => p.topic.toLowerCase() === topic.toLowerCase()
      );
      if (pos) stances[topic] = pos.view;
    }

    return {
      id: entity.id,
      title: entity.title,
      wikiId: entity.wikiId ?? null,
      description: entity.description ?? null,
      office: inferOffice(entity),
      party: inferParty(entity),
      jurisdiction: inferJurisdiction(entity),
      status: inferStatus(entity),
      website: entity.website ?? null,
      stances,
      sourceCount: (entity.sources ?? []).length,
      tags: entity.tags ?? [],
    };
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────

interface StatDef {
  label: string;
  value: string;
}

function buildStats(rows: PoliticianRow[]): StatDef[] {
  const total = rows.length;
  const withAiStance = rows.filter((r) => r.stances["AI safety and regulation"]).length;
  const parties = new Map<string, number>();
  for (const r of rows) {
    if (r.party) parties.set(r.party, (parties.get(r.party) ?? 0) + 1);
  }
  const partyStr = [...parties.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${n} ${p.charAt(0).toUpperCase() + p.slice(1)}`)
    .join(", ");

  const stanceBreakdown = new Map<string, number>();
  for (const r of rows) {
    const label = extractStanceLabel(r.stances["AI safety and regulation"]);
    if (label !== "unknown") stanceBreakdown.set(label, (stanceBreakdown.get(label) ?? 0) + 1);
  }
  const stanceStr = [...stanceBreakdown.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([s, n]) => `${n} ${s}`)
    .join(", ");

  return [
    { label: "Politicians", value: String(total) },
    { label: "With AI Stance", value: `${withAiStance}/${total}` },
    { label: "By Party", value: partyStr || "\u2014" },
    { label: "AI Safety Stances", value: stanceStr || "\u2014" },
  ];
}

// ── Page ──────────────────────────────────────────────────────────────────

export default function PoliticiansPage() {
  const rows = loadPoliticians();
  const stats = buildStats(rows);

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Politicians
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Political candidates and officeholders tracked for EA-relevant policy
          positions. Covers {rows.length} politicians across AI safety,
          biosecurity, animal welfare, science funding, and nuclear energy.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <Suspense fallback={<div>Loading...</div>}>
        <PoliticiansTable rows={rows} />
      </Suspense>
    </div>
  );
}
