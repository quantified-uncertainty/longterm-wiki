/**
 * FactorStatusBadge & FactorStatusCard - Shows current assessment level and trend
 *
 * Displays a compact badge with:
 * - Level (0-100) with color coding
 * - Trend indicator (arrow)
 * - Confidence indicator
 */

import React from "react";
import type { CurrentAssessment } from "@/data/parameter-graph-data";

interface FactorStatusBadgeProps {
  assessment: CurrentAssessment;
  showDetails?: boolean;
}

function getTrendIcon(trend: CurrentAssessment["trend"]) {
  switch (trend) {
    case "improving":
      return "\u2191";
    case "declining":
      return "\u2193";
    case "stable":
      return "\u2192";
    default:
      return "?";
  }
}

function getTrendColor(trend: CurrentAssessment["trend"]) {
  switch (trend) {
    case "improving":
      return "text-green-500";
    case "declining":
      return "text-red-500";
    case "stable":
      return "text-yellow-500";
    default:
      return "text-muted-foreground";
  }
}

function getLevelColor(level: number) {
  if (level >= 70) return "bg-green-500/20 text-green-400 border-green-500/30";
  if (level >= 40)
    return "bg-yellow-500/20 text-yellow-400 border-yellow-500/30";
  return "bg-red-500/20 text-red-400 border-red-500/30";
}

function getLevelLabel(level: number) {
  if (level >= 70) return "Good";
  if (level >= 40) return "Moderate";
  return "Concerning";
}

export function FactorStatusBadge({
  assessment,
  showDetails = false,
}: FactorStatusBadgeProps) {
  const { level, trend, confidence, lastUpdated, notes } = assessment;

  return (
    <div className="inline-block">
      <div className="flex items-center gap-2">
        {/* Level badge */}
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-md text-sm font-medium border ${getLevelColor(level)}`}
        >
          {level}/100
          <span className="ml-1.5 text-xs opacity-75">
            ({getLevelLabel(level)})
          </span>
        </span>

        {/* Trend indicator */}
        <span
          className={`text-lg font-bold ${getTrendColor(trend)}`}
          title={`Trend: ${trend}`}
        >
          {getTrendIcon(trend)}
        </span>

        {/* Confidence indicator */}
        {confidence !== undefined && (
          <span
            className="text-xs text-muted-foreground"
            title={`Confidence: ${Math.round(confidence * 100)}%`}
          >
            {confidence >= 0.7
              ? "\u25CF\u25CF\u25CF"
              : confidence >= 0.4
                ? "\u25CF\u25CF\u25CB"
                : "\u25CF\u25CB\u25CB"}
          </span>
        )}
      </div>

      {showDetails && (
        <div className="mt-2 text-sm text-muted-foreground">
          {lastUpdated && <div>Last updated: {lastUpdated}</div>}
          {notes && <div className="mt-1 italic">{notes}</div>}
        </div>
      )}
    </div>
  );
}

export function FactorStatusCard({
  assessment,
}: {
  assessment: CurrentAssessment;
}) {
  const { level, trend, confidence, lastUpdated, notes } = assessment;

  return (
    <div className="p-4 rounded-lg border border-border bg-muted/50">
      <h4 className="text-sm font-semibold text-foreground mb-3">
        Current Assessment
      </h4>

      <div className="grid grid-cols-3 gap-4 mb-3">
        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Level
          </div>
          <div
            className={`text-2xl font-bold ${level >= 70 ? "text-green-400" : level >= 40 ? "text-yellow-400" : "text-red-400"}`}
          >
            {level}
            <span className="text-sm text-muted-foreground">/100</span>
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Trend
          </div>
          <div className={`text-2xl font-bold ${getTrendColor(trend)}`}>
            {getTrendIcon(trend)}
            <span className="text-sm ml-1 capitalize">{trend}</span>
          </div>
        </div>

        <div>
          <div className="text-xs text-muted-foreground uppercase tracking-wide">
            Confidence
          </div>
          <div className="text-2xl font-bold text-foreground">
            {confidence !== undefined
              ? `${Math.round(confidence * 100)}%`
              : "\u2014"}
          </div>
        </div>
      </div>

      {notes && (
        <div className="text-sm text-muted-foreground italic border-t border-border pt-2 mt-2">
          {notes}
        </div>
      )}

      {lastUpdated && (
        <div className="text-xs text-muted-foreground mt-2">
          Last updated: {lastUpdated}
        </div>
      )}
    </div>
  );
}

export default FactorStatusBadge;
