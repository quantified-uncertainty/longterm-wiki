import Link from "next/link";
import type { ExploreItem } from "@/data";
import { getTypeLabel, getTypeColor, formatWordCount, truncate } from "./explore-utils";

export function ContentCard({ item }: { item: ExploreItem }) {
  const href = item.href || `/wiki/${item.numericId}`;

  return (
    <Link
      href={href}
      className="group block p-4 border border-border rounded-lg hover:border-foreground/30 hover:shadow-sm transition-all no-underline bg-card"
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${getTypeColor(item.type)}`}>
          {getTypeLabel(item.type)}
        </span>
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
