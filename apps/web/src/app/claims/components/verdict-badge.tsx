"use client";

import { Badge } from "@/components/ui/badge";
import { HelpCircle } from "lucide-react";
import { CLAIM_VERDICT_CONFIG } from "./verdict-config";

/** Badge-specific styling per verdict (extends shared config with Badge className) */
const BADGE_STYLES: Record<string, string> = {
  verified: "bg-green-100 text-green-800 border-green-200 hover:bg-green-100",
  unsupported: "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
  disputed: "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100",
  unverified: "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-100",
  not_verifiable: "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-100",
};

export function VerdictBadge({
  verdict,
  score,
}: {
  verdict: string | null;
  score?: number | null;
}) {
  const key = verdict ?? "unverified";
  const shared = CLAIM_VERDICT_CONFIG[key];
  const Icon = shared?.icon ?? HelpCircle;
  const label = shared?.label ?? "Unverified";
  const className = BADGE_STYLES[key] ?? BADGE_STYLES.unverified;

  return (
    <Badge variant="outline" className={`gap-1 text-xs font-medium ${className}`}>
      <Icon className="h-3 w-3" />
      {label}
      {score != null && (
        <span className="ml-0.5 opacity-70">({Math.round(score * 100)}%)</span>
      )}
    </Badge>
  );
}

export function SourceVerdictBadge({
  verdict,
  score,
}: {
  verdict: string | null;
  score?: number | null;
}) {
  return <VerdictBadge verdict={verdict} score={score} />;
}
