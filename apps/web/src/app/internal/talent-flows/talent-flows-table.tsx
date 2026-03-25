"use client";

import { useState } from "react";
import Link from "next/link";

// ---- Types (mirrored from server response, kept simple for the client) ----

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
      <Link href={`/organizations/${org.slug}`} className="text-blue-600 hover:underline dark:text-blue-400">
        {org.name}
      </Link>
    );
  }
  return <span>{org.name}</span>;
}

function PersonLink({ person }: { person: FlowPerson }) {
  if (person.slug) {
    return (
      <Link href={`/people/${person.slug}`} className="text-blue-600 hover:underline dark:text-blue-400">
        {person.name}
      </Link>
    );
  }
  return <span>{person.name}</span>;
}

function NetBadge({ net }: { net: number }) {
  if (net > 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300">
        +{net}
      </span>
    );
  }
  if (net < 0) {
    return (
      <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-800 dark:bg-red-900/30 dark:text-red-300">
        {net}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600 dark:bg-gray-800 dark:text-gray-400">
      0
    </span>
  );
}

// ---- Flow Edges Table ----

export function FlowEdgesTable({ flows }: { flows: FlowEdge[] }) {
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  if (flows.length === 0) {
    return <p className="text-muted-foreground text-sm">No talent flows found.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-4 font-medium">From</th>
            <th className="py-2 pr-4 font-medium">To</th>
            <th className="py-2 pr-4 font-medium text-right">Count</th>
            <th className="py-2 font-medium">People</th>
          </tr>
        </thead>
        <tbody>
          {flows.map((flow, idx) => {
            const isExpanded = expandedIdx === idx;
            return (
              <tr
                key={`${flow.fromOrg.id}-${flow.toOrg.id}`}
                className="border-b border-border/50 hover:bg-muted/50"
              >
                <td className="py-2 pr-4">
                  <OrgLink org={flow.fromOrg} />
                </td>
                <td className="py-2 pr-4">
                  <OrgLink org={flow.toOrg} />
                </td>
                <td className="py-2 pr-4 text-right tabular-nums font-medium">
                  {flow.count}
                </td>
                <td className="py-2">
                  <button
                    onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                    className="text-xs text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {isExpanded ? "Hide" : `Show ${flow.people.length}`}
                  </button>
                  {isExpanded && (
                    <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      {flow.people.map((p, pi) => (
                        <li key={pi}>
                          <PersonLink person={p} />
                          {p.role && (
                            <span className="ml-1 text-muted-foreground/70">
                              ({p.role})
                            </span>
                          )}
                          {p.year && (
                            <span className="ml-1 text-muted-foreground/50">
                              {p.year}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---- Org Net Flow Table ----

export function OrgNetFlowTable({ orgNetFlows }: { orgNetFlows: OrgNetFlow[] }) {
  if (orgNetFlows.length === 0) {
    return <p className="text-muted-foreground text-sm">No org flow data.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="py-2 pr-4 font-medium">Organization</th>
            <th className="py-2 pr-4 font-medium text-right">Inflows</th>
            <th className="py-2 pr-4 font-medium text-right">Outflows</th>
            <th className="py-2 pr-4 font-medium text-right">Net</th>
          </tr>
        </thead>
        <tbody>
          {orgNetFlows.map((row) => (
            <tr
              key={row.org.id}
              className="border-b border-border/50 hover:bg-muted/50"
            >
              <td className="py-2 pr-4">
                <OrgLink org={row.org} />
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                {row.inflows}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums text-red-600 dark:text-red-400">
                {row.outflows}
              </td>
              <td className="py-2 pr-4 text-right">
                <NetBadge net={row.net} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
