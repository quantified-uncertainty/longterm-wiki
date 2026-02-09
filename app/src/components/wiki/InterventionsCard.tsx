/**
 * InterventionsList & InterventionsCard - Shows interventions that address a factor
 *
 * Displays linked interventions with effect direction and strength
 */

import React from "react";
import type { AddressedBy } from "@/data/parameter-graph-data";

interface InterventionsListProps {
  interventions: AddressedBy[];
  compact?: boolean;
}

function getEffectIcon(effect: AddressedBy["effect"]) {
  switch (effect) {
    case "positive":
      return "\u2191";
    case "negative":
      return "\u2193";
    case "mixed":
      return "\u2195";
    default:
      return "?";
  }
}

function getEffectColor(effect: AddressedBy["effect"]) {
  switch (effect) {
    case "positive":
      return "text-green-400";
    case "negative":
      return "text-red-400";
    case "mixed":
      return "text-yellow-400";
    default:
      return "text-muted-foreground";
  }
}

function getStrengthDots(strength?: AddressedBy["strength"]) {
  switch (strength) {
    case "strong":
      return "\u25CF\u25CF\u25CF";
    case "medium":
      return "\u25CF\u25CF\u25CB";
    case "weak":
      return "\u25CF\u25CB\u25CB";
    default:
      return "\u25CB\u25CB\u25CB";
  }
}

export function InterventionsList({
  interventions,
  compact = false,
}: InterventionsListProps) {
  if (!interventions || interventions.length === 0) {
    return (
      <div className="text-muted-foreground text-sm">
        No linked interventions
      </div>
    );
  }

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        {interventions.map((intervention, i) => (
          <a
            key={i}
            href={intervention.path}
            className={`inline-flex items-center gap-1 px-2 py-1 rounded text-sm border border-border hover:border-muted-foreground transition-colors ${getEffectColor(intervention.effect)}`}
          >
            <span>{getEffectIcon(intervention.effect)}</span>
            <span>
              {intervention.title || intervention.path.split("/").pop()}
            </span>
          </a>
        ))}
      </div>
    );
  }

  return (
    <div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 px-2 text-muted-foreground font-medium">
              Intervention
            </th>
            <th className="text-center py-2 px-2 text-muted-foreground font-medium">
              Effect
            </th>
            <th className="text-center py-2 px-2 text-muted-foreground font-medium">
              Strength
            </th>
          </tr>
        </thead>
        <tbody>
          {interventions.map((intervention, i) => (
            <tr key={i} className="border-b border-border/50">
              <td className="py-2 px-2">
                <a
                  href={intervention.path}
                  className="text-primary hover:underline"
                >
                  {intervention.title || intervention.path.split("/").pop()}
                </a>
              </td>
              <td
                className={`py-2 px-2 text-center ${getEffectColor(intervention.effect)}`}
              >
                {getEffectIcon(intervention.effect)} {intervention.effect}
              </td>
              <td className="py-2 px-2 text-center text-muted-foreground">
                <span title={intervention.strength || "unknown"}>
                  {getStrengthDots(intervention.strength)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function InterventionsCard({
  interventions,
}: {
  interventions: AddressedBy[];
}) {
  if (!interventions || interventions.length === 0) return null;

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/50">
      <h4 className="text-sm font-semibold text-foreground mb-3">
        Addressed By
      </h4>
      <InterventionsList interventions={interventions} />
    </div>
  );
}

export default InterventionsList;
