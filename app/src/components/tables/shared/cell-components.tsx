"use client";

import { cn } from "@/lib/utils";
import { getBadgeClass, getSafetyOutlookClass } from "./table-view-styles";

/**
 * Shared cell rendering components used across multiple table column files.
 */

/** Badge for level values (HIGH, MEDIUM, LOW, etc.) */
export function LevelBadge({
  level,
  category,
  formatLevel,
  className,
}: {
  level: string;
  category?: string;
  formatLevel?: (level: string) => string;
  className?: string;
}) {
  const display = formatLevel ? formatLevel(level) : level;
  return (
    <span
      className={cn(
        "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
        getBadgeClass(level, category),
        className,
      )}
    >
      {display}
    </span>
  );
}

/** Muted note subtext below a badge */
export function CellNote({ note }: { note?: string }) {
  if (!note) return null;
  return (
    <div className="text-[9px] text-muted-foreground mt-1 line-clamp-2">
      {note}
    </div>
  );
}

/** Badge with tooltip note (used in safety-approaches rating columns) */
export function RatingCell({
  rating,
  category,
}: {
  rating: { level: string; note?: string };
  category?: string;
}) {
  return (
    <div className="group relative" title={rating.note || undefined}>
      <LevelBadge level={rating.level} category={category} />
    </div>
  );
}

/** Safety outlook badge with optional score */
export function SafetyOutlookBadge({
  rating,
  score,
}: {
  rating: string;
  score?: number;
}) {
  const labels: Record<string, string> = {
    favorable: "Favorable",
    mixed: "Mixed",
    challenging: "Challenging",
    unknown: "Unknown",
  };

  return (
    <div className="flex flex-col gap-1">
      {score !== undefined && (
        <div
          className={cn(
            "text-lg font-bold",
            rating === "favorable"
              ? "text-green-700 dark:text-green-400"
              : rating === "mixed"
                ? "text-amber-700 dark:text-amber-400"
                : rating === "challenging"
                  ? "text-red-700 dark:text-red-400"
                  : "text-muted-foreground",
          )}
        >
          {score}/10
        </div>
      )}
      <span
        className={cn(
          "inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold whitespace-nowrap",
          getSafetyOutlookClass(rating),
        )}
      >
        {labels[rating] || rating}
      </span>
    </div>
  );
}

/** +/- prefixed colored list (safety pros/cons) */
export function ProsCons({ items, type }: { items: string[]; type: "pro" | "con" }) {
  const prefix = type === "pro" ? "+" : "\u2212";
  const colorClass =
    type === "pro"
      ? "text-green-700 dark:text-green-400"
      : "text-red-700 dark:text-red-400";

  return (
    <div className="text-[11px] space-y-0.5">
      {items.map((item) => (
        <div key={item} className={colorClass}>
          {prefix} {item}
        </div>
      ))}
    </div>
  );
}

/** Bulleted colored list (risks/opportunities) */
export function ItemList({ items, type }: { items: string[]; type: "risk" | "opportunity" }) {
  const colorClass =
    type === "risk"
      ? "text-red-700 dark:text-red-400"
      : "text-green-700 dark:text-green-400";

  return (
    <div className="text-[11px] space-y-0.5">
      {items.map((item) => (
        <div key={item} className={colorClass}>
          &bull; {item}
        </div>
      ))}
    </div>
  );
}
