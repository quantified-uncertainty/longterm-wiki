const BAR_COLORS: Record<string, string> = {
  factual: "bg-blue-400",
  opinion: "bg-purple-400",
  analytical: "bg-amber-400",
  speculative: "bg-orange-400",
  relational: "bg-teal-400",
  uncategorized: "bg-gray-300",
  numeric: "bg-sky-400",
  historical: "bg-indigo-400",
  evaluative: "bg-purple-400",
  causal: "bg-amber-400",
  consensus: "bg-pink-400",
};

export function DistributionBar({
  data,
  total,
}: {
  data: Record<string, number>;
  total: number;
}) {
  if (total === 0) return null;
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-1.5">
      <div className="flex h-3 rounded overflow-hidden">
        {entries.map(([key, cnt]) => (
          <div
            key={key}
            className={`${BAR_COLORS[key] ?? "bg-gray-300"} transition-all`}
            style={{ width: `${(cnt / total) * 100}%` }}
            title={`${key}: ${cnt} (${Math.round((cnt / total) * 100)}%)`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {entries.map(([key, cnt]) => (
          <span
            key={key}
            className="text-[11px] text-muted-foreground flex items-center gap-1"
          >
            <span
              className={`inline-block w-2 h-2 rounded-sm ${BAR_COLORS[key] ?? "bg-gray-300"}`}
            />
            {key} ({cnt})
          </span>
        ))}
      </div>
    </div>
  );
}
