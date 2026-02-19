import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@lib/utils";

const credibilityConfig: Record<number, { label: string; classes: string; description: string }> = {
  5: { label: "Gold", classes: "bg-amber-600/15 text-amber-700", description: "Peer-reviewed, gold standard source" },
  4: { label: "High", classes: "bg-green-700/12 text-green-800", description: "High quality, established institution" },
  3: { label: "Good", classes: "bg-blue-600/12 text-blue-700", description: "Good quality, reputable source" },
  2: { label: "Mixed", classes: "bg-orange-500/12 text-orange-700", description: "Mixed quality, verify claims" },
  1: { label: "Low", classes: "bg-red-600/12 text-red-700", description: "Low credibility, use with caution" },
};

export function CredibilityBadge({
  level,
  size = "sm",
  showLabel = false,
  className = "",
}: {
  level: number;
  size?: "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}) {
  const clampedLevel = Math.max(1, Math.min(5, Math.round(level)));
  const config = credibilityConfig[clampedLevel] || credibilityConfig[3];
  const sizeClasses = {
    sm: "text-[10px] px-1 py-0 gap-0.5",
    md: "text-[11px] px-1.5 py-0.5 gap-1",
    lg: "text-xs px-2 py-1 gap-1",
  };
  const stars = "\u2605".repeat(clampedLevel) + "\u2606".repeat(5 - clampedLevel);

  return (
    <Badge
      variant="outline"
      className={cn("rounded-sm font-medium border-transparent", sizeClasses[size], config.classes, className)}
      title={`Credibility: ${config.label} (${clampedLevel}/5) - ${config.description}`}
    >
      {showLabel ? (
        <>
          <span>{config.label}</span>
          <span className="opacity-70">({clampedLevel})</span>
        </>
      ) : (
        <span className="tracking-tighter">{stars}</span>
      )}
    </Badge>
  );
}

export default CredibilityBadge;
