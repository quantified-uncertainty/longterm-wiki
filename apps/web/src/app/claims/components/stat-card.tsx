export function StatCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="text-2xl font-bold tabular-nums">
        {typeof value === "number" ? value.toLocaleString() : value}
      </div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
