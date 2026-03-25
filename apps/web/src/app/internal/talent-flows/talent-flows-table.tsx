"use client";

import { Fragment, useState } from "react";
import Link from "next/link";

// ---- Types ----

export interface FlowPerson {
  name: string;
  slug: string | null;
  role: string | null;
  year: string | null;
}

export interface FlowEdge {
  fromOrg: { id: string; name: string; slug: string | null };
  toOrg: { id: string; name: string; slug: string | null };
  count: number;
  people: FlowPerson[];
}

export interface OrgNetFlow {
  org: { id: string; name: string; slug: string | null };
  inflows: number;
  outflows: number;
  net: number;
}

// ---- Helpers ----

function OrgLink({ org }: { org: { name: string; slug: string | null } }) {
  if (org.slug) {
    return (
      <Link
        href={`/organizations/${org.slug}`}
        className="font-medium text-foreground hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
      >
        {org.name}
      </Link>
    );
  }
  return <span className="font-medium text-foreground">{org.name}</span>;
}

function PersonLink({ person }: { person: FlowPerson }) {
  if (person.slug) {
    return (
      <Link
        href={`/people/${person.slug}`}
        className="text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
      >
        {person.name}
      </Link>
    );
  }
  return <span>{person.name}</span>;
}

// ---- Stat Cards ----

export function StatCards({
  stats,
}: {
  stats: { totalTransitions: number; uniquePeople: number; uniqueOrgs: number };
}) {
  const cards = [
    {
      label: "Transitions",
      value: stats.totalTransitions,
      color: "from-blue-500/10 to-blue-600/5 border-blue-500/20",
      textColor: "text-blue-700 dark:text-blue-300",
    },
    {
      label: "People",
      value: stats.uniquePeople,
      color: "from-emerald-500/10 to-emerald-600/5 border-emerald-500/20",
      textColor: "text-emerald-700 dark:text-emerald-300",
    },
    {
      label: "Organizations",
      value: stats.uniqueOrgs,
      color: "from-amber-500/10 to-amber-600/5 border-amber-500/20",
      textColor: "text-amber-700 dark:text-amber-300",
    },
  ];

  return (
    <div className="grid grid-cols-3 gap-3 mb-8">
      {cards.map((card) => (
        <div
          key={card.label}
          className={`rounded-lg border bg-gradient-to-br ${card.color} p-4`}
        >
          <div className={`text-2xl font-bold tabular-nums ${card.textColor}`}>
            {card.value}
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 uppercase tracking-wider">
            {card.label}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---- Flow Bar (horizontal proportional bar for in/out) ----

function FlowBar({
  inflows,
  outflows,
  maxTotal,
}: {
  inflows: number;
  outflows: number;
  maxTotal: number;
}) {
  const total = inflows + outflows;
  const widthPct = Math.max((total / maxTotal) * 100, 8);
  const inPct = total > 0 ? (inflows / total) * 100 : 50;

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div
        className="h-3 rounded-full overflow-hidden flex"
        style={{ width: `${widthPct}%` }}
      >
        <div
          className="bg-emerald-500/70 dark:bg-emerald-400/60 transition-all"
          style={{ width: `${inPct}%` }}
        />
        <div
          className="bg-red-400/70 dark:bg-red-400/50 transition-all"
          style={{ width: `${100 - inPct}%` }}
        />
      </div>
    </div>
  );
}

// ---- Net Talent Flow Table ----

export function OrgNetFlowTable({
  orgNetFlows,
}: {
  orgNetFlows: OrgNetFlow[];
}) {
  if (orgNetFlows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-4">No org flow data.</p>
    );
  }

  const maxTotal = Math.max(...orgNetFlows.map((r) => r.inflows + r.outflows));

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 bg-muted/30">
            <th className="py-2.5 px-4 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider">
              Organization
            </th>
            <th className="py-2.5 px-4 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider w-16">
              In
            </th>
            <th className="py-2.5 px-4 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider w-16">
              Out
            </th>
            <th className="py-2.5 px-4 text-center font-medium text-muted-foreground text-xs uppercase tracking-wider w-16">
              Net
            </th>
            <th className="py-2.5 px-4 font-medium text-muted-foreground text-xs uppercase tracking-wider">
              <span className="flex items-center gap-1.5">
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-emerald-500/70" />
                In
                <span className="inline-block w-2.5 h-2.5 rounded-full bg-red-400/70 ml-1" />
                Out
              </span>
            </th>
          </tr>
        </thead>
        <tbody>
          {orgNetFlows.map((row, i) => {
            const netColor =
              row.net > 0
                ? "text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/40"
                : row.net < 0
                  ? "text-red-700 dark:text-red-400 bg-red-50 dark:bg-red-950/40"
                  : "text-muted-foreground bg-muted/30";
            return (
              <tr
                key={row.org.id}
                className={`border-b border-border/30 hover:bg-muted/40 transition-colors ${i % 2 === 0 ? "" : "bg-muted/10"}`}
              >
                <td className="py-2 px-4">
                  <OrgLink org={row.org} />
                </td>
                <td className="py-2 px-4 text-right tabular-nums text-emerald-600 dark:text-emerald-400 font-medium">
                  +{row.inflows}
                </td>
                <td className="py-2 px-4 text-right tabular-nums text-red-500 dark:text-red-400 font-medium">
                  -{row.outflows}
                </td>
                <td className="py-2 px-4 text-center">
                  <span
                    className={`inline-flex items-center justify-center rounded-md px-2 py-0.5 text-xs font-bold tabular-nums ${netColor}`}
                  >
                    {row.net > 0 ? "+" : ""}
                    {row.net}
                  </span>
                </td>
                <td className="py-2 px-4">
                  <FlowBar
                    inflows={row.inflows}
                    outflows={row.outflows}
                    maxTotal={maxTotal}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Flow Edges Table ----

export function FlowEdgesTable({ flows }: { flows: FlowEdge[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (flows.length === 0) {
    return (
      <p className="text-muted-foreground text-sm py-4">
        No talent flows found.
      </p>
    );
  }

  const maxCount = Math.max(...flows.map((f) => f.count));

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 bg-muted/30">
            <th className="py-2.5 px-4 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider">
              From
            </th>
            <th className="py-2.5 px-3 text-center text-muted-foreground w-8">
            </th>
            <th className="py-2.5 px-4 text-left font-medium text-muted-foreground text-xs uppercase tracking-wider">
              To
            </th>
            <th className="py-2.5 px-4 font-medium text-muted-foreground text-xs uppercase tracking-wider w-32">
              Volume
            </th>
            <th className="py-2.5 px-4 text-right font-medium text-muted-foreground text-xs uppercase tracking-wider w-20">
              People
            </th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow, idx) => {
            const isExpanded = expandedIdx === idx;
            const barWidth = Math.max((flow.count / maxCount) * 100, 12);
            const rowKey = `${flow.fromOrg.id}-${flow.toOrg.id}`;
            return (
              <Fragment key={rowKey}>
                <tr
                  className={`border-b border-border/30 hover:bg-muted/40 transition-colors cursor-pointer ${idx % 2 === 0 ? "" : "bg-muted/10"} ${isExpanded ? "bg-blue-50/50 dark:bg-blue-950/20" : ""}`}
                  onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                >
                  <td className="py-2.5 px-4">
                    <OrgLink org={flow.fromOrg} />
                  </td>
                  <td className="py-2.5 px-1 text-center text-muted-foreground/50">
                    <svg
                      width="20"
                      height="12"
                      viewBox="0 0 20 12"
                      className="inline-block"
                    >
                      <line
                        x1="0"
                        y1="6"
                        x2="14"
                        y2="6"
                        stroke="currentColor"
                        strokeWidth="1.5"
                      />
                      <polygon
                        points="13,2 20,6 13,10"
                        fill="currentColor"
                      />
                    </svg>
                  </td>
                  <td className="py-2.5 px-4">
                    <OrgLink org={flow.toOrg} />
                  </td>
                  <td className="py-2.5 px-4">
                    <div className="flex items-center gap-2">
                      <div
                        className="h-2.5 rounded-full bg-blue-500/50 dark:bg-blue-400/40 transition-all"
                        style={{ width: `${barWidth}%` }}
                      />
                      <span className="text-xs tabular-nums font-bold text-foreground/70">
                        {flow.count}
                      </span>
                    </div>
                  </td>
                  <td className="py-2.5 px-4 text-right">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedIdx(isExpanded ? null : idx);
                      }}
                      className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                    >
                      {isExpanded ? "Hide" : `${flow.people.length}`}
                      <svg
                        className={`inline-block ml-0.5 w-3 h-3 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                        viewBox="0 0 12 12"
                        fill="none"
                      >
                        <path
                          d="M3 5L6 8L9 5"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
                      </svg>
                    </button>
                  </td>
                </tr>
                {isExpanded && (
                  <tr
                    className="bg-blue-50/30 dark:bg-blue-950/10"
                  >
                    <td colSpan={5} className="px-4 py-3">
                      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1.5">
                        {flow.people.map((p, pi) => (
                          <div
                            key={pi}
                            className="flex items-baseline gap-1.5 text-xs"
                          >
                            <span className="w-1 h-1 rounded-full bg-blue-400 shrink-0 mt-1.5" />
                            <span>
                              <PersonLink person={p} />
                              {p.role && (
                                <span className="text-muted-foreground/60 ml-1">
                                  {p.role}
                                </span>
                              )}
                              {p.year && (
                                <span className="text-muted-foreground/40 ml-1">
                                  ({p.year})
                                </span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
