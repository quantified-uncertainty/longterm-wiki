/**
 * Shared stat card used across internal dashboards and entity pages.
 * Displays a label and a large numeric value with optional color accent.
 */
export function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: "emerald" | "blue" | "amber" | "rose";
}) {
  const colorClass =
    color === "emerald"
      ? "text-emerald-600"
      : color === "blue"
        ? "text-blue-600"
        : color === "amber"
          ? "text-amber-600"
          : color === "rose"
            ? "text-rose-600"
            : "text-foreground";

  return (
    <div className="rounded-lg border border-border/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-semibold tabular-nums ${colorClass}`}>
        {value.toLocaleString("en-US")}
      </p>
    </div>
  );
}
