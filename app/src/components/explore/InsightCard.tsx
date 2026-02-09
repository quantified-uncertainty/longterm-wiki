import Link from "next/link";
import type { ExploreItem } from "@/data";
import { getTypeLabel, getTypeColor } from "./explore-utils";

export function InsightCard({ item }: { item: ExploreItem }) {
  const href = item.href || `/wiki/${item.numericId}`;

  return (
    <div className="p-3 border border-border rounded-lg bg-card">
      <div className="flex items-center justify-between mb-1.5 text-xs">
        <span className={`font-medium px-2 py-0.5 rounded ${getTypeColor(item.type)}`}>
          {getTypeLabel(item.type)}
        </span>
        {item.meta && (
          <span className="text-muted-foreground">{item.meta}</span>
        )}
      </div>
      <p className="text-sm text-foreground leading-relaxed mb-2">{item.title}</p>
      {item.sourceTitle && href && (
        <Link
          href={href}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors no-underline"
        >
          → {item.sourceTitle}
        </Link>
      )}
    </div>
  );
}
