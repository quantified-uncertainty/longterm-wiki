export function PropertyBadge({ property }: { property: string | null }) {
  if (!property) return <span className="text-muted-foreground/40 text-[10px]">—</span>;
  return (
    <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-100 text-gray-700 border border-gray-200">
      {property}
    </span>
  );
}
