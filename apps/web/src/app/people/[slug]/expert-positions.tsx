import type { ExpertPosition } from "@/data/database";
import { topicLabel } from "@/data/topic-labels";

const CONFIDENCE_STYLES: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  medium:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  low: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export function ExpertPositions({
  positions,
}: {
  positions: ExpertPosition[];
}) {
  if (positions.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Expert Positions
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {positions.length} topics
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30">
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Topic
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  View
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Estimate
                </th>
                <th className="text-left px-4 py-2.5 font-semibold text-xs uppercase tracking-wider text-muted-foreground">
                  Confidence
                </th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => (
                <tr
                  key={pos.topic}
                  className="border-b border-border/30 last:border-b-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3 font-medium">
                    {topicLabel(pos.topic)}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {pos.view}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs">
                    {pos.estimate ?? "—"}
                  </td>
                  <td className="px-4 py-3">
                    {pos.confidence && (
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${CONFIDENCE_STYLES[pos.confidence] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {pos.confidence}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {positions.some((p) => p.source) && (
          <div className="px-4 py-2.5 border-t border-border/40 bg-muted/20">
            <p className="text-xs text-muted-foreground">
              Sources:{" "}
              {positions
                .filter((p) => p.source)
                .map((p, i) => (
                  <span key={p.topic}>
                    {i > 0 && " · "}
                    {p.sourceUrl ? (
                      <a
                        href={p.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {p.source}
                      </a>
                    ) : (
                      p.source
                    )}
                  </span>
                ))}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
