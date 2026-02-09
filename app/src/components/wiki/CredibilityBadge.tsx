import React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@lib/utils";

const credibilityConfig: Record<number, { label: string; color: string; bgColor: string; description: string }> = {
  5: { label: "Gold", color: "#b8860b", bgColor: "rgba(184, 134, 11, 0.15)", description: "Peer-reviewed, gold standard source" },
  4: { label: "High", color: "#2e7d32", bgColor: "rgba(46, 125, 50, 0.12)", description: "High quality, established institution" },
  3: { label: "Good", color: "#1976d2", bgColor: "rgba(25, 118, 210, 0.12)", description: "Good quality, reputable source" },
  2: { label: "Mixed", color: "#f57c00", bgColor: "rgba(245, 124, 0, 0.12)", description: "Mixed quality, verify claims" },
  1: { label: "Low", color: "#d32f2f", bgColor: "rgba(211, 47, 47, 0.12)", description: "Low credibility, use with caution" },
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
      className={cn("rounded-sm font-medium border-transparent", sizeClasses[size], className)}
      title={`Credibility: ${config.label} (${clampedLevel}/5) - ${config.description}`}
      style={{ backgroundColor: config.bgColor, color: config.color }}
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
