/**
 * Shared layout components for factbase detail pages (fact, property, item).
 * Extracted to avoid duplicating identical KV-table markup across pages.
 */

/** Key-value row inside a KVTable. */
export function KVRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <td className="px-3 py-2 text-muted-foreground font-medium text-xs uppercase tracking-wide whitespace-nowrap align-top w-40">
        {label}
      </td>
      <td className="px-3 py-2 text-sm">{children}</td>
    </tr>
  );
}

/** Bordered table wrapper for key-value rows. */
export function KVTable({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <table className="w-full">
        <tbody className="[&>tr:nth-child(even)]:bg-muted/30">{children}</tbody>
      </table>
    </div>
  );
}

/** Em-dash placeholder for missing values. */
export function Dash() {
  return <span className="text-muted-foreground">{"\u2014"}</span>;
}
