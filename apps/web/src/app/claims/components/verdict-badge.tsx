"use client";

import { Badge } from "@/components/ui/badge";
import { CheckCircle2, XCircle, AlertTriangle, HelpCircle } from "lucide-react";

const VERDICT_CONFIG: Record<
  string,
  {
    label: string;
    className: string;
    Icon: typeof CheckCircle2;
  }
> = {
  verified: {
    label: "Verified",
    className: "bg-green-100 text-green-800 border-green-200 hover:bg-green-100",
    Icon: CheckCircle2,
  },
  unsupported: {
    label: "Unsupported",
    className: "bg-red-100 text-red-800 border-red-200 hover:bg-red-100",
    Icon: XCircle,
  },
  disputed: {
    label: "Disputed",
    className: "bg-amber-100 text-amber-800 border-amber-200 hover:bg-amber-100",
    Icon: AlertTriangle,
  },
  unverified: {
    label: "Unverified",
    className: "bg-gray-100 text-gray-500 border-gray-200 hover:bg-gray-100",
    Icon: HelpCircle,
  },
};

export function VerdictBadge({
  verdict,
  score,
}: {
  verdict: string | null;
  score?: number | null;
}) {
  const config = verdict ? VERDICT_CONFIG[verdict] : VERDICT_CONFIG.unverified;
  if (!config) return null;
  const { label, className, Icon } = config;

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
