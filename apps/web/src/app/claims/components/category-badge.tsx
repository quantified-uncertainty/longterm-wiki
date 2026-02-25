const CATEGORY_COLORS: Record<string, string> = {
  factual: "bg-blue-50 text-blue-700 border-blue-200",
  opinion: "bg-purple-50 text-purple-700 border-purple-200",
  analytical: "bg-amber-50 text-amber-700 border-amber-200",
  speculative: "bg-orange-50 text-orange-700 border-orange-200",
  relational: "bg-teal-50 text-teal-700 border-teal-200",
  uncategorized: "bg-gray-50 text-gray-500 border-gray-200",
};

export function CategoryBadge({ category }: { category: string }) {
  const cls = CATEGORY_COLORS[category] ?? CATEGORY_COLORS.uncategorized;
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${cls}`}
    >
      {category}
    </span>
  );
}
