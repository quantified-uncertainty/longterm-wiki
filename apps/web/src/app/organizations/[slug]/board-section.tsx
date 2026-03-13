/**
 * Board of Directors section for organization profile pages.
 * Compact table layout matching the Key People table.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/kb/format";
import { SectionHeader } from "./org-shared";
import type { BoardMember } from "./org-data";

export function BoardOfDirectorsSection({ members }: { members: BoardMember[] }) {
  if (members.length === 0) return null;

  const current = members.filter((m) => !m.departed);
  const former = members.filter((m) => !!m.departed);
  const sorted = [...current, ...former];

  return (
    <section>
      <SectionHeader title="Board of Directors" count={members.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">Name</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Role</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Status</th>
              <th scope="col" className="py-2 px-3 text-left font-medium">Tenure</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {sorted.map((m) => {
              const isCurrent = !m.departed;
              const tenure = m.appointed
                ? `${formatKBDate(m.appointed)}${m.departed ? ` \u2013 ${formatKBDate(m.departed)}` : " \u2013 present"}`
                : m.departed
                  ? `\u2013 ${formatKBDate(m.departed)}`
                  : "";

              return (
                <tr
                  key={m.key}
                  className={`hover:bg-muted/20 transition-colors${!isCurrent ? " opacity-60" : ""}`}
                >
                  <td className="py-1.5 px-3">
                    {m.personHref ? (
                      <Link href={m.personHref} className="font-medium text-foreground hover:text-primary transition-colors">
                        {m.personName}
                      </Link>
                    ) : (
                      <span className="font-medium">{m.personName}</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground">{m.role ?? ""}</td>
                  <td className="py-1.5 px-3">
                    {isCurrent ? (
                      <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                        Current
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Former</span>
                    )}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap text-xs">{tenure}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
