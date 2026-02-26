const TOPIC_COLORS: Record<string, string> = {
  founding: "bg-indigo-50 text-indigo-700 border-indigo-200",
  funding: "bg-emerald-50 text-emerald-700 border-emerald-200",
  leadership: "bg-violet-50 text-violet-700 border-violet-200",
  governance: "bg-slate-50 text-slate-700 border-slate-200",
  regulation: "bg-red-50 text-red-700 border-red-200",
  capabilities: "bg-cyan-50 text-cyan-700 border-cyan-200",
  operations: "bg-sky-50 text-sky-700 border-sky-200",
  competition: "bg-orange-50 text-orange-700 border-orange-200",
  safety: "bg-rose-50 text-rose-700 border-rose-200",
  impact: "bg-amber-50 text-amber-700 border-amber-200",
  research: "bg-blue-50 text-blue-700 border-blue-200",
  strategy: "bg-purple-50 text-purple-700 border-purple-200",
  controversy: "bg-pink-50 text-pink-700 border-pink-200",
  history: "bg-stone-50 text-stone-700 border-stone-200",
  uncategorized: "bg-gray-50 text-gray-500 border-gray-200",
};

export function TopicBadge({ topic }: { topic: string | null }) {
  const label = topic ?? "uncategorized";
  const cls = TOPIC_COLORS[label] ?? TOPIC_COLORS.uncategorized;
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}
    >
      {label}
    </span>
  );
}
