"use client";

import { useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable, SortableHeader } from "@/components/ui/data-table";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { BaselineResult } from "./hallucination-evals-content";

// ── Types for flattened table data ──────────────────────────────────────────

interface CategoryRow {
  category: string;
  total: number;
  caught: number;
  recall: number;
}

interface DetectorRow {
  detector: string;
  findings: number;
  truePositives: number;
  precision: number;
}

interface AgentFindingRow {
  page: string;
  findings: number;
  allWarnings: boolean;
  noCritical: boolean;
  topCategories: string[];
  notes: string;
}

interface RunSummaryRow {
  runDate: string;
  pages: number;
  errorsInjected: number;
  recall: number;
  precision: number;
  f1: number;
}

// ── Score Card ───────────────────────────────────────────────────────────────

function ScoreCard({
  label,
  value,
  description,
  color = "default",
}: {
  label: string;
  value: string | number;
  description?: string;
  color?: "default" | "green" | "yellow" | "red";
}) {
  const colorClass =
    color === "green"
      ? "text-emerald-600 dark:text-emerald-400"
      : color === "yellow"
        ? "text-amber-600 dark:text-amber-400"
        : color === "red"
          ? "text-red-600 dark:text-red-400"
          : "text-foreground";

  return (
    <Card>
      <CardHeader className="p-4 pb-1">
        <CardDescription className="text-xs">{label}</CardDescription>
      </CardHeader>
      <CardContent className="p-4 pt-0">
        <div className={`text-2xl font-bold tabular-nums ${colorClass}`}>
          {value}
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ── Status helpers ───────────────────────────────────────────────────────────

function RecallBadge({ recall }: { recall: number }) {
  const pct = (recall * 100).toFixed(0);
  if (recall > 0.5) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-500">
        {pct}%
      </span>
    );
  }
  if (recall > 0.2) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
        {pct}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
      {pct}%
    </span>
  );
}

function PrecisionBadge({ precision }: { precision: number }) {
  const pct = (precision * 100).toFixed(0);
  if (precision > 0.5) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-emerald-500/15 text-emerald-500">
        {pct}%
      </span>
    );
  }
  if (precision > 0.2) {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-amber-500/15 text-amber-500">
        {pct}%
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-red-500/15 text-red-500">
      {pct}%
    </span>
  );
}

function StatusIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="text-emerald-500" title="Pass">&#10003;</span>
  ) : (
    <span className="text-red-500" title="Fail">&#10007;</span>
  );
}

// ── Column definitions ──────────────────────────────────────────────────────

const categoryColumns: ColumnDef<CategoryRow>[] = [
  {
    accessorKey: "category",
    header: ({ column }) => (
      <SortableHeader column={column}>Category</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.category}</span>
    ),
  },
  {
    accessorKey: "total",
    header: ({ column }) => (
      <SortableHeader column={column}>Total</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.total}</span>
    ),
  },
  {
    accessorKey: "caught",
    header: ({ column }) => (
      <SortableHeader column={column}>Caught</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.caught}</span>
    ),
  },
  {
    accessorKey: "recall",
    header: ({ column }) => (
      <SortableHeader column={column}>Recall</SortableHeader>
    ),
    cell: ({ row }) => <RecallBadge recall={row.original.recall} />,
  },
];

const detectorColumns: ColumnDef<DetectorRow>[] = [
  {
    accessorKey: "detector",
    header: ({ column }) => (
      <SortableHeader column={column}>Detector</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.detector}</span>
    ),
  },
  {
    accessorKey: "findings",
    header: ({ column }) => (
      <SortableHeader column={column}>Findings</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.findings}</span>
    ),
  },
  {
    accessorKey: "truePositives",
    header: ({ column }) => (
      <SortableHeader column={column}>True Positives</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.truePositives}</span>
    ),
  },
  {
    accessorKey: "precision",
    header: ({ column }) => (
      <SortableHeader column={column}>Precision</SortableHeader>
    ),
    cell: ({ row }) => <PrecisionBadge precision={row.original.precision} />,
  },
];

const agentColumns: ColumnDef<AgentFindingRow>[] = [
  {
    accessorKey: "page",
    header: ({ column }) => (
      <SortableHeader column={column}>Page</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="font-mono text-xs">{row.original.page}</span>
    ),
  },
  {
    accessorKey: "findings",
    header: ({ column }) => (
      <SortableHeader column={column}>Findings</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {row.original.findings}
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => (
      <span className="flex items-center gap-2 text-xs">
        <StatusIcon ok={row.original.allWarnings} />
        <span className="text-muted-foreground">all warnings</span>
        <StatusIcon ok={row.original.noCritical} />
        <span className="text-muted-foreground">no critical</span>
      </span>
    ),
  },
  {
    id: "topCategories",
    header: "Top Categories",
    cell: ({ row }) => (
      <div className="flex flex-wrap gap-1">
        {row.original.topCategories.map((cat) => (
          <span
            key={cat}
            className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground"
          >
            {cat}
          </span>
        ))}
      </div>
    ),
  },
  {
    accessorKey: "notes",
    header: "Notes",
    cell: ({ row }) => (
      <span className="text-xs text-muted-foreground">{row.original.notes}</span>
    ),
  },
];

const runHistoryColumns: ColumnDef<RunSummaryRow>[] = [
  {
    accessorKey: "runDate",
    header: ({ column }) => (
      <SortableHeader column={column}>Date</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums text-muted-foreground whitespace-nowrap">
        {row.original.runDate}
      </span>
    ),
  },
  {
    accessorKey: "pages",
    header: ({ column }) => (
      <SortableHeader column={column}>Pages</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.pages}</span>
    ),
  },
  {
    accessorKey: "errorsInjected",
    header: ({ column }) => (
      <SortableHeader column={column}>Injected</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums">{row.original.errorsInjected}</span>
    ),
  },
  {
    accessorKey: "recall",
    header: ({ column }) => (
      <SortableHeader column={column}>Recall</SortableHeader>
    ),
    cell: ({ row }) => <RecallBadge recall={row.original.recall} />,
  },
  {
    accessorKey: "precision",
    header: ({ column }) => (
      <SortableHeader column={column}>Precision</SortableHeader>
    ),
    cell: ({ row }) => <PrecisionBadge precision={row.original.precision} />,
  },
  {
    accessorKey: "f1",
    header: ({ column }) => (
      <SortableHeader column={column}>F1</SortableHeader>
    ),
    cell: ({ row }) => (
      <span className="text-xs tabular-nums font-medium">
        {(row.original.f1 * 100).toFixed(0)}%
      </span>
    ),
  },
];

// ── Section Header ──────────────────────────────────────────────────────────

function SectionHeader({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="mt-8 mb-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

// ── Main Dashboard ──────────────────────────────────────────────────────────

interface Props {
  baselines: BaselineResult[];
}

export function EvalsDashboard({ baselines }: Props) {
  const [selectedIdx, setSelectedIdx] = useState(0);

  if (baselines.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="text-lg font-medium text-muted-foreground">
            No eval results yet
          </p>
          <p className="mt-2 text-muted-foreground">
            Run{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
              crux evals run --suite=injection
            </code>{" "}
            to generate baseline results.
          </p>
        </CardContent>
      </Card>
    );
  }

  const selected = baselines[selectedIdx];
  const injection = selected.suites.injection;
  const crossRef = selected.suites.crossReference;
  const agents = selected.adversarialAgents;

  // Flatten Record data into arrays for DataTable
  const categoryRows: CategoryRow[] = Object.entries(
    injection.byCategory
  ).map(([category, d]) => ({
    category,
    total: d.total,
    caught: d.caught,
    recall: d.recall,
  }));

  const detectorRows: DetectorRow[] = Object.entries(
    injection.byDetector
  ).map(([detector, d]) => ({
    detector,
    findings: d.findings,
    truePositives: d.truePositives,
    precision: d.precision,
  }));

  const snifferRows: AgentFindingRow[] = Object.entries(
    agents.referenceSniffer
  ).map(([page, d]) => ({
    page,
    findings: d.findings,
    allWarnings: d.allWarnings,
    noCritical: d.noCritical,
    topCategories: d.topCategories,
    notes: d.notes,
  }));

  const auditorRows: AgentFindingRow[] = Object.entries(
    agents.descriptionAuditor
  ).map(([page, d]) => ({
    page,
    findings: d.findings,
    allWarnings: true,
    noCritical: true,
    topCategories: [],
    notes: d.notes,
  }));

  const runHistoryRows: RunSummaryRow[] = baselines.map((b) => ({
    runDate: b.runDate,
    pages: b.suites.injection.pages.length,
    errorsInjected: b.suites.injection.errorsInjected,
    recall: b.suites.injection.recall,
    precision: b.suites.injection.precision,
    f1: b.suites.injection.f1,
  }));

  // Simpler columns for the description auditor (no status/topCategories)
  const auditorColumns: ColumnDef<AgentFindingRow>[] = [
    agentColumns[0],
    agentColumns[1],
    agentColumns[4], // notes
  ];

  return (
    <div className="space-y-2">
      {/* ── Run History ────────────────────────────────────── */}
      {baselines.length > 1 && (
        <>
          <SectionHeader
            title="Run History"
            description={`${baselines.length} eval runs. Click a row to view details.`}
          />
          <DataTable
            columns={runHistoryColumns}
            data={runHistoryRows}
            searchPlaceholder="Search runs..."
            defaultSorting={[{ id: "runDate", desc: true }]}
            getRowClassName={(row) =>
              row.index === selectedIdx
                ? "bg-blue-500/[0.06] border-l-2 border-l-blue-500"
                : "cursor-pointer"
            }
          />
          <p className="text-xs text-muted-foreground">
            Viewing run from{" "}
            <select
              value={selectedIdx}
              onChange={(e) => setSelectedIdx(Number(e.target.value))}
              className="bg-muted rounded px-1.5 py-0.5 text-xs font-medium"
            >
              {baselines.map((b, i) => (
                <option key={b.runDate} value={i}>
                  {b.runDate}
                </option>
              ))}
            </select>
          </p>
        </>
      )}

      {baselines.length === 1 && (
        <div className="text-sm text-muted-foreground">
          Run: <span className="font-medium">{selected.runDate}</span>
        </div>
      )}

      {/* ── Injection Eval ──────────────────────────────────── */}
      <SectionHeader
        title="Error Injection Eval"
        description="Inject known errors into golden pages, then measure whether detection systems catch them."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <ScoreCard
          label="Errors Injected"
          value={injection.errorsInjected}
          description={`Across ${injection.pages.length} pages`}
        />
        <ScoreCard
          label="Recall"
          value={`${(injection.recall * 100).toFixed(0)}%`}
          description={`${injection.errorsCaught}/${injection.errorsInjected} caught`}
          color={
            injection.recall > 0.5
              ? "green"
              : injection.recall > 0.2
                ? "yellow"
                : "red"
          }
        />
        <ScoreCard
          label="Precision"
          value={`${(injection.precision * 100).toFixed(0)}%`}
          color={
            injection.precision > 0.5
              ? "green"
              : injection.precision > 0.2
                ? "yellow"
                : "red"
          }
        />
        <ScoreCard
          label="F1 Score"
          value={`${(injection.f1 * 100).toFixed(0)}%`}
          color={
            injection.f1 > 0.5
              ? "green"
              : injection.f1 > 0.2
                ? "yellow"
                : "red"
          }
        />
      </div>

      <div className="grid md:grid-cols-2 gap-6 mt-4">
        <div>
          <h3 className="font-medium mb-2 text-sm">By Error Category</h3>
          <DataTable
            columns={categoryColumns}
            data={categoryRows}
            searchPlaceholder="Search categories..."
            defaultSorting={[{ id: "recall", desc: false }]}
            getRowClassName={(row) =>
              row.original.recall < 0.2 ? "bg-red-500/[0.03]" : ""
            }
          />
        </div>
        <div>
          <h3 className="font-medium mb-2 text-sm">By Detector</h3>
          <DataTable
            columns={detectorColumns}
            data={detectorRows}
            searchPlaceholder="Search detectors..."
            defaultSorting={[{ id: "precision", desc: false }]}
            getRowClassName={(row) =>
              row.original.precision < 0.2 ? "bg-red-500/[0.03]" : ""
            }
          />
        </div>
      </div>

      {injection.notes && (
        <Card className="bg-muted/30">
          <CardContent className="p-4">
            <span className="font-medium text-sm">Notes: </span>
            <span className="text-sm text-muted-foreground">
              {injection.notes}
            </span>
          </CardContent>
        </Card>
      )}

      {/* ── Cross-Reference Check ──────────────────────────── */}
      <SectionHeader
        title="Cross-Reference Consistency"
        description="Extract structured facts across pages, check for contradictions."
      />

      {crossRef.pagesScanned > 0 ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            <ScoreCard
              label="Pages Scanned"
              value={crossRef.pagesScanned}
            />
            <ScoreCard
              label="Facts Extracted"
              value={crossRef.factsExtracted}
            />
            <ScoreCard
              label="Contradictions"
              value={crossRef.contradictionsFound}
              color={crossRef.contradictionsFound === 0 ? "green" : "red"}
            />
          </div>

          {crossRef.notes && (
            <Card className="bg-muted/30 mt-4">
              <CardContent className="p-4">
                <span className="font-medium text-sm">Notes: </span>
                <span className="text-sm text-muted-foreground">
                  {crossRef.notes}
                </span>
              </CardContent>
            </Card>
          )}
        </>
      ) : (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground text-sm">
            No cross-reference check results. Run{" "}
            <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
              crux evals run --suite=cross-ref
            </code>
          </CardContent>
        </Card>
      )}

      {/* ── Adversarial Agents ─────────────────────────────── */}
      <SectionHeader
        title="Adversarial Agent Findings"
        description="Autonomous agents that crawl real wiki pages looking for hallucination patterns."
      />

      <div className="space-y-6">
        {/* Reference Sniffer */}
        {snifferRows.length > 0 ? (
          <div>
            <h3 className="font-medium mb-1 text-sm">Reference Sniffer</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Extracts factual claims, flags uncited specifics (dollar amounts,
              dates, percentages).
            </p>
            <DataTable
              columns={agentColumns}
              data={snifferRows}
              searchPlaceholder="Search pages..."
              getRowClassName={(row) =>
                !row.original.noCritical ? "bg-red-500/[0.03]" : ""
              }
            />
          </div>
        ) : (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              No reference sniffer results. Run{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                crux evals hunt --agent=reference-sniffer --page=anthropic
              </code>
            </CardContent>
          </Card>
        )}

        {/* Description Auditor */}
        {auditorRows.length > 0 ? (
          <div>
            <h3 className="font-medium mb-1 text-sm">Description Auditor</h3>
            <p className="text-xs text-muted-foreground mb-3">
              Cross-checks entity YAML descriptions against frontmatter and
              overview sections.
            </p>
            <DataTable
              columns={auditorColumns}
              data={auditorRows}
              searchPlaceholder="Search pages..."
              getRowClassName={(row) =>
                row.original.findings > 5 ? "bg-amber-500/[0.03]" : ""
              }
            />
          </div>
        ) : (
          <Card>
            <CardContent className="p-6 text-center text-muted-foreground text-sm">
              No description auditor results. Run{" "}
              <code className="bg-muted px-1.5 py-0.5 rounded text-xs">
                crux evals hunt --agent=description-auditor --page=miri
              </code>
            </CardContent>
          </Card>
        )}

        {/* Cross-Reference Checker */}
        <div>
          <h3 className="font-medium mb-1 text-sm">Cross-Reference Checker</h3>
          <div className="grid grid-cols-2 gap-4">
            <ScoreCard
              label="Pages Scanned"
              value={agents.crossReferenceChecker.pagesScanned}
            />
            <ScoreCard
              label="Contradictions"
              value={agents.crossReferenceChecker.contradictions}
              color={
                agents.crossReferenceChecker.contradictions === 0
                  ? "green"
                  : "red"
              }
            />
          </div>
        </div>
      </div>

      {/* ── Injection Demo ─────────────────────────────────── */}
      {selected.injectionDemo && (
        <>
          <SectionHeader
            title="Injection Examples"
            description="Sample error injections showing what the framework produces."
          />

          <Card>
            <CardHeader className="p-4 pb-2">
              <CardTitle className="text-sm">
                {selected.injectionDemo.page}
              </CardTitle>
              <CardDescription>
                {selected.injectionDemo.errorsInjected} errors injected across{" "}
                {selected.injectionDemo.categories.length} categories
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead>Description</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {selected.injectionDemo.examples.map((ex, i) => (
                    <TableRow key={i}>
                      <TableCell className="font-mono text-xs whitespace-nowrap">
                        {ex.category}
                      </TableCell>
                      <TableCell className="text-xs">
                        {ex.description}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </>
      )}

      {/* ── CLI Commands ───────────────────────────────────── */}
      <SectionHeader
        title="CLI Commands"
        description="Run evals from the command line to generate new results."
      />

      <Card className="bg-muted/30">
        <CardContent className="p-0">
          <pre className="p-4 text-xs font-mono overflow-x-auto leading-relaxed">
            <span className="text-muted-foreground"># Error injection eval</span>
            {"\n"}pnpm crux evals run --suite=injection --pages=anthropic,miri --verbose
            {"\n"}
            {"\n"}<span className="text-muted-foreground"># Cross-reference consistency</span>
            {"\n"}pnpm crux evals run --suite=cross-ref --limit=200
            {"\n"}
            {"\n"}<span className="text-muted-foreground"># Fake entity resistance (requires API key)</span>
            {"\n"}pnpm crux evals run --suite=fake-entity
            {"\n"}
            {"\n"}<span className="text-muted-foreground"># Adversarial agents</span>
            {"\n"}pnpm crux evals hunt --agent=reference-sniffer --page=anthropic --no-llm
            {"\n"}pnpm crux evals hunt --agent=description-auditor --page=miri
            {"\n"}
            {"\n"}<span className="text-muted-foreground"># Manual error injection</span>
            {"\n"}pnpm crux evals inject anthropic --count=2
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}
