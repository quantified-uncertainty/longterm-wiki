"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { SortableHeader } from "@/components/ui/sortable-header";
import {
  getBadgeClass,
  getLevelSortValue,
  riskCategoryColors,
} from "./shared/table-view-styles";
import type {
  AccidentRisk,
  AbstractionLevel,
  RiskRelationship,
} from "@data/tables/accident-risks";

// Badge component for various levels
function LevelBadge({
  level,
  category,
}: {
  level: string;
  category?: string;
}) {
  const formattedLevel = level
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());

  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[9px] font-semibold whitespace-nowrap",
        getBadgeClass(level, category)
      )}
    >
      {formattedLevel}
    </span>
  );
}

// Relationship badge
function RelationshipBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        "inline-block px-1 py-0.5 rounded text-[8px] font-semibold whitespace-nowrap",
        getBadgeClass(type, "relationship")
      )}
    >
      {type.replace(/-/g, " ")}
    </span>
  );
}

// Category cell with color dot
function CategoryCell({ category }: { category: string }) {
  const color = riskCategoryColors[category] || "#6b7280";
  return (
    <div className="flex items-center gap-1.5">
      <div
        className="w-2 h-2 rounded-full shrink-0"
        style={{ backgroundColor: color }}
      />
      <span className="text-[10px] text-foreground">{category}</span>
    </div>
  );
}

// Relations cell with clickable links
function RelationsCell({
  relations,
  scrollToRisk,
}: {
  relations: RiskRelationship[];
  scrollToRisk?: (id: string) => void;
}) {
  if (relations.length === 0) {
    return <span className="text-[10px] text-muted-foreground">None</span>;
  }

  return (
    <div className="flex flex-col gap-1">
      {relations.slice(0, 4).map((rel, i) => (
        <div key={i} className="flex items-start gap-1 text-[9px]">
          <RelationshipBadge type={rel.type} />
          <span
            onClick={() => scrollToRisk?.(rel.riskId)}
            className={cn(
              "text-blue-600 dark:text-blue-400",
              scrollToRisk && "cursor-pointer hover:underline"
            )}
          >
            {rel.riskId}
          </span>
        </div>
      ))}
      {relations.length > 4 && (
        <div className="text-[9px] text-muted-foreground">
          +{relations.length - 4} more
        </div>
      )}
    </div>
  );
}

// Sorting helpers
const LEVEL_ORDER: Record<string, number> = {
  // Abstraction Level
  THEORETICAL: 1,
  MECHANISM: 2,
  BEHAVIOR: 3,
  OUTCOME: 4,
  // Evidence Level
  SPECULATIVE: 1,
  DEMONSTRATED_LAB: 3,
  OBSERVED_CURRENT: 4,
  // Timeline
  LONG_TERM: 1,
  MEDIUM_TERM: 2,
  NEAR_TERM: 3,
  CURRENT: 4,
  UNCERTAIN: 0,
  // Severity
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CATASTROPHIC: 4,
  EXISTENTIAL: 5,
  // Detectability (reversed - easy is better)
  EASY: 4,
  MODERATE: 3,
  DIFFICULT: 2,
  VERY_DIFFICULT: 1,
  UNKNOWN: 0,
};

function getLocalLevelValue(level: string): number {
  if (LEVEL_ORDER[level] !== undefined) return LEVEL_ORDER[level];
  return getLevelSortValue(level);
}

// Create columns with scroll function
export const createAccidentRisksColumns = (
  scrollToRisk?: (id: string) => void
): ColumnDef<AccidentRisk>[] => [
  {
    accessorKey: "name",
    header: ({ column }) => <SortableHeader column={column}>Risk</SortableHeader>,
    cell: ({ row }) => {
      const risk = row.original;
      const riskUrl = risk.pageSlug
        ? `/knowledge-base/risks/accident/${risk.pageSlug}/`
        : null;
      return (
        <div className="min-w-[180px]" title={risk.shortDescription}>
          <div className="font-semibold text-xs">
            {riskUrl ? (
              <a
                href={riskUrl}
                className="text-blue-600 hover:underline dark:text-blue-400"
              >
                {risk.name}
              </a>
            ) : (
              <span className="text-foreground">{risk.name}</span>
            )}
          </div>
        </div>
      );
    },
    enablePinning: true,
  },
  {
    accessorKey: "category",
    header: ({ column }) => <SortableHeader column={column}>Category</SortableHeader>,
    cell: ({ row }) => <CategoryCell category={row.getValue("category")} />,
    sortingFn: (rowA, rowB) => {
      // Sort by category order (imported from data)
      const categories = [
        "Theoretical Frameworks",
        "Alignment Failures",
        "Specification Problems",
        "Deceptive Behaviors",
        "Instrumental Behaviors",
        "Capability Concerns",
        "Catastrophic Scenarios",
        "Human-AI Interaction",
      ];
      const a = categories.indexOf(rowA.getValue("category") as string);
      const b = categories.indexOf(rowB.getValue("category") as string);
      return a - b;
    },
  },
  {
    id: "level",
    accessorKey: "abstractionLevel",
    header: ({ column }) => (
      <SortableHeader column={column} title="Theoretical/Mechanism/Behavior/Outcome">
        Level
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <LevelBadge level={row.original.abstractionLevel} category="abstraction" />
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLocalLevelValue(rowA.original.abstractionLevel);
      const b = getLocalLevelValue(rowB.original.abstractionLevel);
      return a - b;
    },
  },
  {
    id: "evidence",
    accessorKey: "evidenceLevel",
    header: ({ column }) => (
      <SortableHeader column={column} title="Evidence supporting this risk">
        Evidence
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div title={row.original.evidenceNote}>
        <LevelBadge level={row.original.evidenceLevel} category="evidence" />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLocalLevelValue(rowA.original.evidenceLevel);
      const b = getLocalLevelValue(rowB.original.evidenceLevel);
      return a - b;
    },
  },
  {
    id: "timeline",
    accessorKey: "timeline",
    header: ({ column }) => (
      <SortableHeader column={column} title="When this risk becomes relevant">
        Timeline
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div title={row.original.timelineNote}>
        <LevelBadge level={row.original.timeline} category="timeline" />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLocalLevelValue(rowA.original.timeline);
      const b = getLocalLevelValue(rowB.original.timeline);
      return a - b;
    },
  },
  {
    id: "severity",
    accessorKey: "severity",
    header: ({ column }) => (
      <SortableHeader column={column} title="Potential severity if realized">
        Severity
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div title={row.original.severityNote}>
        <LevelBadge level={row.original.severity} category="severity" />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLocalLevelValue(rowA.original.severity);
      const b = getLocalLevelValue(rowB.original.severity);
      return a - b;
    },
  },
  {
    id: "detectability",
    accessorKey: "detectability",
    header: ({ column }) => (
      <SortableHeader column={column} title="How easy to detect">
        Detectability
      </SortableHeader>
    ),
    cell: ({ row }) => (
      <div title={row.original.detectabilityNote}>
        <LevelBadge level={row.original.detectability} category="detectability" />
      </div>
    ),
    sortingFn: (rowA, rowB) => {
      const a = getLocalLevelValue(rowA.original.detectability);
      const b = getLocalLevelValue(rowB.original.detectability);
      return a - b;
    },
  },
  {
    id: "relatedRisks",
    accessorKey: "relatedRisks",
    header: () => <span className="text-xs">Related Risks</span>,
    cell: ({ row }) => (
      <RelationsCell
        relations={row.original.relatedRisks}
        scrollToRisk={scrollToRisk}
      />
    ),
    enableSorting: false,
  },
  {
    id: "overlapNotes",
    accessorKey: "overlapNote",
    header: () => <span className="text-xs">Overlap Notes</span>,
    cell: ({ row }) => {
      const note = row.original.overlapNote;
      return note ? (
        <span
          className="text-[9px] text-muted-foreground cursor-help"
          title={note}
        >
          i
        </span>
      ) : null;
    },
    enableSorting: false,
  },
  {
    id: "keyQuestion",
    accessorKey: "keyQuestion",
    header: () => <span className="text-xs">Key Question</span>,
    cell: ({ row }) => {
      const question = row.original.keyQuestion;
      return question ? (
        <span
          className="text-[9px] text-muted-foreground cursor-help"
          title={question}
        >
          ?
        </span>
      ) : null;
    },
    enableSorting: false,
  },
];

// Column config for visibility toggles
export const ACCIDENT_RISKS_COLUMNS = {
  category: { key: "category", label: "Category", group: "level" as const, default: true },
  level: { key: "level", label: "Level", group: "level" as const, default: true },
  evidence: { key: "evidence", label: "Evidence", group: "evidence" as const, default: true },
  timeline: { key: "timeline", label: "Timeline", group: "assessment" as const, default: true },
  severity: { key: "severity", label: "Severity", group: "assessment" as const, default: true },
  detectability: { key: "detectability", label: "Detectability", group: "assessment" as const, default: true },
  relatedRisks: { key: "relatedRisks", label: "Related Risks", group: "relations" as const, default: true },
  overlapNotes: { key: "overlapNotes", label: "Overlap Notes", group: "relations" as const, default: true },
  keyQuestion: { key: "keyQuestion", label: "Key Question", group: "relations" as const, default: true },
} as const;

export type AccidentRisksColumnKey = keyof typeof ACCIDENT_RISKS_COLUMNS;

export const ACCIDENT_RISKS_PRESETS = {
  all: Object.keys(ACCIDENT_RISKS_COLUMNS) as AccidentRisksColumnKey[],
  assessment: [
    "level",
    "evidence",
    "timeline",
    "severity",
    "detectability",
  ] as AccidentRisksColumnKey[],
  compact: ["level", "severity", "detectability", "relatedRisks"] as AccidentRisksColumnKey[],
  default: Object.entries(ACCIDENT_RISKS_COLUMNS)
    .filter(([_, v]) => v.default)
    .map(([k]) => k) as AccidentRisksColumnKey[],
};
