"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { SortableHeader } from "@/components/ui/sortable-header";
import { CellNote, LevelBadge } from "./shared/cell-components";
import { getLevelSortValue } from "./shared/table-view-styles";
import type { FrontierLab, LabLink } from "@data/tables/frontier-labs";
import { levelNoteColumn } from "./shared/column-helpers";

export type { FrontierLab } from "@data/tables/frontier-labs";

function NameCell({ lab }: { lab: FrontierLab }) {
  const href = lab.entityId ? `/wiki/${lab.entityId}` : undefined;
  return (
    <div className="min-w-[180px]">
      <div className="font-semibold text-[13px] text-foreground">
        {href ? (
          <a href={href} className="hover:underline">
            {lab.name}
          </a>
        ) : (
          lab.name
        )}
      </div>
      <div className="text-[11px] text-muted-foreground mt-1 line-clamp-2 max-w-[240px]">
        {lab.description}
      </div>
    </div>
  );
}

function SignalsCell({ signals }: { signals: string[] }) {
  return (
    <ul className="text-[10px] text-foreground space-y-0.5 list-disc list-inside">
      {signals.slice(0, 4).map((s, i) => (
        <li key={i} className="leading-snug">
          {s}
        </li>
      ))}
    </ul>
  );
}

function LinksCell({ links }: { links: LabLink[] }) {
  if (links.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      {links.slice(0, 3).map((l) => (
        <a
          key={l.url}
          href={l.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-primary hover:underline truncate max-w-[160px]"
        >
          {l.label}
        </a>
      ))}
    </div>
  );
}

function CapabilityTierCell({ row }: { row: { original: FrontierLab } }) {
  const lab = row.original;
  return (
    <div>
      <LevelBadge level={lab.capabilityTier.level} />
      <CellNote note={lab.capabilityTier.note} />
    </div>
  );
}

// Map non-standard tier strings into colors via getLevelSortValue's existing levels.
// FRONTIER → high; NEAR-FRONTIER → medium; SPECIALIZED → low-medium; DEFUNCT → none.
function capabilityTierSortValue(tier: string): number {
  const t = tier.toLowerCase();
  if (t === "frontier") return 4;
  if (t === "near-frontier") return 3;
  if (t === "specialized") return 2;
  if (t === "defunct") return 0;
  return 1;
}

export const createFrontierLabsColumns = (): ColumnDef<FrontierLab>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Lab</SortableHeader>,
    cell: ({ row }) => <NameCell lab={row.original} />,
    enablePinning: true,
  },
  {
    id: "capabilityTier",
    accessorFn: (row) => row.capabilityTier.level,
    header: ({ column }) => (
      <SortableHeader column={column} title="Frontier tier classification">
        Tier
      </SortableHeader>
    ),
    cell: CapabilityTierCell,
    sortingFn: (a, b) =>
      capabilityTierSortValue(a.original.capabilityTier.level) -
      capabilityTierSortValue(b.original.capabilityTier.level),
  },
  levelNoteColumn<FrontierLab>({
    id: "safetyInvestment",
    accessor: (r) => r.safetyInvestment,
    label: "Safety investment",
    tooltip: "Dedicated safety / alignment headcount and research output, relative to org size",
  }),
  levelNoteColumn<FrontierLab>({
    id: "racePostureRestraint",
    accessor: (r) => r.racePostureRestraint,
    label: "Race restraint",
    tooltip: "Public posture and revealed behavior on competitive racing. HIGH = restrained.",
  }),
  levelNoteColumn<FrontierLab>({
    id: "transparency",
    accessor: (r) => r.transparency,
    label: "Transparency",
    tooltip: "System cards, RSPs, training detail, pre-deployment AISI access",
  }),
  levelNoteColumn<FrontierLab>({
    id: "govEngagement",
    accessor: (r) => r.govEngagement,
    label: "Gov. engagement",
    tooltip: "Regulator / AISI / summit engagement. HIGH = constructive engagement.",
  }),
  levelNoteColumn<FrontierLab>({
    id: "leadershipSafetyAlignment",
    accessor: (r) => r.leadershipSafetyAlignment,
    label: "Leadership safety alignment",
    tooltip: "CEO / co-founder public stance and revealed prioritization of safety",
    sortValue: (r) => getLevelSortValue(r.leadershipSafetyAlignment.level),
  }),
  levelNoteColumn<FrontierLab>({
    id: "employeeSafetyCulture",
    accessor: (r) => r.employeeSafetyCulture,
    label: "Employee safety culture",
    tooltip: "Internal safety advocacy, alignment-research output, attrition pattern",
  }),
  levelNoteColumn<FrontierLab>({
    id: "rspQuality",
    accessor: (r) => r.rspQuality,
    label: "RSP / framework quality",
    tooltip: "Detail and operational specificity of published Responsible Scaling Policy or equivalent",
  }),
  {
    id: "notableSignals",
    header: () => <span className="text-xs">Notable signals</span>,
    cell: ({ row }) => <SignalsCell signals={row.original.notableSignals} />,
    enableSorting: false,
  },
  {
    id: "links",
    header: () => <span className="text-xs">References</span>,
    cell: ({ row }) => <LinksCell links={row.original.links} />,
    enableSorting: false,
  },
];

export const FRONTIER_LABS_COLUMNS = {
  capabilityTier: { key: "capabilityTier", label: "Tier", group: "overview" as const, default: true },
  safetyInvestment: { key: "safetyInvestment", label: "Safety investment", group: "safety" as const, default: true },
  racePostureRestraint: { key: "racePostureRestraint", label: "Race restraint", group: "safety" as const, default: true },
  transparency: { key: "transparency", label: "Transparency", group: "safety" as const, default: true },
  govEngagement: { key: "govEngagement", label: "Gov. engagement", group: "safety" as const, default: true },
  leadershipSafetyAlignment: { key: "leadershipSafetyAlignment", label: "Leadership", group: "safety" as const, default: true },
  employeeSafetyCulture: { key: "employeeSafetyCulture", label: "Employee culture", group: "safety" as const, default: true },
  rspQuality: { key: "rspQuality", label: "RSP quality", group: "safety" as const, default: true },
  notableSignals: { key: "notableSignals", label: "Notable signals", group: "evidence" as const, default: true },
  links: { key: "links", label: "References", group: "evidence" as const, default: true },
} as const;

export type FrontierLabsColumnKey = keyof typeof FRONTIER_LABS_COLUMNS;

export const FRONTIER_LABS_PRESETS = {
  all: Object.keys(FRONTIER_LABS_COLUMNS) as FrontierLabsColumnKey[],
  compact: [
    "capabilityTier",
    "safetyInvestment",
    "racePostureRestraint",
    "rspQuality",
  ] as FrontierLabsColumnKey[],
  governance: [
    "capabilityTier",
    "transparency",
    "govEngagement",
    "rspQuality",
  ] as FrontierLabsColumnKey[],
  culture: [
    "capabilityTier",
    "leadershipSafetyAlignment",
    "employeeSafetyCulture",
    "racePostureRestraint",
  ] as FrontierLabsColumnKey[],
  default: Object.entries(FRONTIER_LABS_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as FrontierLabsColumnKey[],
};
