const CONFIDENCE_COLORS: Record<string, string> = {
  verified: "bg-green-100 text-green-800",
  unverified: "bg-yellow-100 text-yellow-800",
  unsourced: "bg-red-100 text-red-800",
};

export function ConfidenceBadge({ confidence }: { confidence: string }) {
  const cls = CONFIDENCE_COLORS[confidence] ?? "bg-gray-100 text-gray-800";
  return (
    <span
      className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}
    >
      {confidence}
    </span>
  );
}
