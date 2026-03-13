/**
 * Key Personnel section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { titleCase, formatKBDate } from "@/components/wiki/kb/format";
import { SectionHeader, safeHref } from "./org-shared";
import type { ParsedPersonnelRecord } from "./org-data";

const ROLE_TYPE_LABELS: Record<string, string> = {
  "key-person": "Key Person",
  board: "Board",
  career: "Career",
};

const ROLE_TYPE_COLORS: Record<string, string> = {
  "key-person": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  board: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  career: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
};

/** Key Personnel section for org pages. */
export function KeyPersonnelSection({
  personnel,
}: {
  personnel: ParsedPersonnelRecord[];
}) {
  if (personnel.length === 0) return null;

  return (
    <section>
      <SectionHeader title="Key Personnel" count={personnel.length} />
      <div className="border border-border/60 rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="text-left py-2 px-3 font-medium">Name</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Role</th>
              <th scope="col" className="text-left py-2 px-3 font-medium">Type</th>
              <th scope="col" className="text-center py-2 px-3 font-medium">Period</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {personnel.map((p) => (
              <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                <td className="py-2 px-3">
                  <span className="font-medium text-foreground text-xs">
                    {p.personHref ? (
                      <Link href={p.personHref} className="text-primary hover:underline">
                        {p.personName}
                      </Link>
                    ) : (
                      p.personName
                    )}
                  </span>
                  {p.isFounder && (
                    <span className="ml-1.5 inline-block px-1.5 py-0.5 rounded text-[11px] font-semibold uppercase bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
                      Founder
                    </span>
                  )}
                  {p.source && (
                    <a
                      href={safeHref(p.source)}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="ml-1.5 text-[11px] text-muted-foreground hover:text-primary transition-colors"
                    >
                      source
                    </a>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-muted-foreground">
                  {p.role ?? ""}
                </td>
                <td className="py-2 px-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                      ROLE_TYPE_COLORS[p.roleType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                    }`}
                  >
                    {ROLE_TYPE_LABELS[p.roleType] ?? p.roleType}
                  </span>
                </td>
                <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                  {p.startDate && (
                    <span>
                      {formatKBDate(p.startDate)}
                      {p.endDate ? ` \u2013 ${formatKBDate(p.endDate)}` : " \u2013 present"}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
