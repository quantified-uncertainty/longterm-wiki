import Link from "next/link";
import type { ExploreItem } from "@/data";
import { getTypeLabel, getTypeColor, formatWordCount, truncate } from "./explore-utils";

const FORMAT_BADGE_COLORS: Record<string, string> = {
  table: "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  diagram: "bg-orange-500/20 text-orange-600 dark:text-orange-400",
  index: "bg-slate-500/20 text-slate-600 dark:text-slate-400",
  dashboard: "bg-slate-500/20 text-slate-600 dark:text-slate-400",
};

export function ContentCard({ item }: { item: ExploreItem }) {
  const href = item.href || `/wiki/${item.numericId}`;
  const format = item.contentFormat || "article";
  const showFormatBadge = format !== "article" && FORMAT_BADGE_COLORS[format];

  return (
    <Link
      href={href}
      className="group block p-4 border border-border rounded-lg hover:border-foreground/30 hover:shadow-sm transition-all no-underline bg-card"
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <span className={`text-xs font-medium px-2 py-0.5 rounded ${getTypeColor(item.type)}`}>
            {getTypeLabel(item.type)}
          </span>
          {showFormatBadge && (
            <span className={`text-[0.65rem] font-medium px-1.5 py-0.5 rounded ${FORMAT_BADGE_COLORS[format]}`}>
              {format.charAt(0).toUpperCase() + format.slice(1)}
            </span>
          )}
        </div>
        {item.wordCount ? (
          <span className="text-xs text-muted-foreground">
            {formatWordCount(item.wordCount)}
          </span>
        ) : item.meta ? (
          <span className="text-xs text-muted-foreground">
            {item.meta}
          </span>
        ) : null}
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-1.5 group-hover:text-accent-foreground">
        {item.title}
      </h3>
      {item.description && item.description !== item.title && (
        <p className="text-xs text-muted-foreground leading-relaxed mb-2">
          {truncate(item.description, 150)}
        </p>
      )}
      {item.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-auto">
          {item.tags.slice(0, 3).map((tag) => (
            <span
              key={tag}
              className="text-[0.65rem] px-1.5 py-0.5 bg-muted rounded text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </Link>
  );
}
