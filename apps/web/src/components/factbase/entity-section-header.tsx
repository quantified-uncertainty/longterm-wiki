/** Section header with optional count badge. */
export function SectionHeader({ title, count, id }: { title: string; count?: number; id?: string }) {
  return (
    <div className="flex items-center gap-3 mb-4" id={id}>
      <h2 className="text-base font-bold tracking-tight">{title}</h2>
      {count != null && (
        <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
          {count}
        </span>
      )}
      <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
    </div>
  );
}
