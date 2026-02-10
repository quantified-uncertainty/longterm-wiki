import React from "react";
import { cn } from "@lib/utils";

const tagColors: Record<string, string> = {
  alignment: "bg-purple-600/12 text-purple-800",
  safety: "bg-green-600/12 text-green-800",
  governance: "bg-blue-600/12 text-blue-800",
  capabilities: "bg-orange-500/12 text-orange-900",
  "x-risk": "bg-red-600/12 text-red-800",
  interpretability: "bg-teal-500/12 text-teal-800",
  evaluation: "bg-violet-600/12 text-violet-800",
  training: "bg-indigo-600/12 text-indigo-800",
  economic: "bg-stone-500/12 text-stone-700",
  biosecurity: "bg-pink-600/12 text-pink-800",
};

const defaultTagColor = "bg-gray-500/12 text-gray-600";

function getTagColor(tag: string) {
  return tagColors[tag] || defaultTagColor;
}

const sizeClasses = {
  sm: "text-[9px] px-1 py-px",
  md: "text-[10px] px-1.5 py-0.5",
};

export function ResourceTags({
  tags,
  limit = 3,
  size = "sm",
  className = "",
}: {
  tags: string[];
  limit?: number;
  size?: "sm" | "md";
  className?: string;
}) {
  const displayTags = tags.slice(0, limit);
  const remaining = tags.length - limit;

  return (
    <span className={cn("inline-flex items-center gap-0.5 flex-wrap", className)}>
      {displayTags.map((tag) => (
        <span
          key={tag}
          className={cn(sizeClasses[size], getTagColor(tag), "rounded-sm font-medium whitespace-nowrap")}
        >
          {tag}
        </span>
      ))}
      {remaining > 0 && (
        <span className={cn("text-muted-foreground", sizeClasses[size])} title={tags.slice(limit).join(", ")}>
          +{remaining}
        </span>
      )}
    </span>
  );
}

export default ResourceTags;
