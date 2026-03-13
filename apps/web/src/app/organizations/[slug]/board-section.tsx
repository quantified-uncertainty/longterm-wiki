/**
 * Board of Directors section for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no visual changes.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/kb/format";
import { getRecordVerdict } from "@data/database";
import { VerificationBadge } from "@/components/directory/VerificationBadge";
import { SectionHeader } from "./org-shared";
import type { BoardMember } from "./org-data";

export function BoardOfDirectorsSection({ members }: { members: BoardMember[] }) {
  if (members.length === 0) return null;

  const current = members.filter((m) => !m.departed);
  const former = members.filter((m) => !!m.departed);

  return (
    <section>
      <SectionHeader title="Board of Directors" count={members.length} />
      <div className="border border-border/60 rounded-xl bg-card">
        {current.length > 0 && (
          <div className="divide-y divide-border/40">
            {current.map((m) => {
              const verdict = getRecordVerdict("personnel", String(m.key));
              return (
                <div key={m.key} className="px-4 py-3">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {m.personHref ? (
                      <Link href={m.personHref} className="font-semibold text-sm text-primary hover:underline">
                        {m.personName}
                      </Link>
                    ) : (
                      <span className="font-semibold text-sm">{m.personName}</span>
                    )}
                    <span className="px-1.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
                      Current
                    </span>
                    <VerificationBadge verdict={verdict} />
                  </div>
                  {m.role && (
                    <div className="text-xs text-muted-foreground mt-0.5">{m.role}</div>
                  )}
                  <div className="text-[11px] text-muted-foreground mt-1">
                    {m.appointed ? `Since ${formatKBDate(m.appointed)}` : ""}
                    {m.appointedBy ? ` (${m.appointedBy})` : ""}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {former.length > 0 && (
          <>
            {current.length > 0 && (
              <div className="px-4 py-1.5 text-[11px] font-medium uppercase tracking-wider text-muted-foreground bg-muted/30 border-t border-border/40">
                Former
              </div>
            )}
            <div className="divide-y divide-border/40">
              {former.map((m) => {
                const verdict = getRecordVerdict("personnel", String(m.key));
                return (
                  <div key={m.key} className="px-4 py-2.5 opacity-70">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {m.personHref ? (
                        <Link href={m.personHref} className="font-semibold text-sm hover:text-primary transition-colors">
                          {m.personName}
                        </Link>
                      ) : (
                        <span className="font-semibold text-sm">{m.personName}</span>
                      )}
                      <VerificationBadge verdict={verdict} />
                    </div>
                    {m.role && (
                      <div className="text-xs text-muted-foreground mt-0.5">{m.role}</div>
                    )}
                    <div className="text-[11px] text-muted-foreground mt-1">
                      {m.appointed ? formatKBDate(m.appointed) : ""}
                      {m.departed ? ` \u2013 ${formatKBDate(m.departed)}` : ""}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
