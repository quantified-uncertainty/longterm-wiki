import Link from "next/link";
import { formatDateRange, fieldStr } from "@/lib/directory-utils";
import { getKBEntitySlug } from "@/data/kb";
import { CurrentBadge } from "@/components/directory";

export interface BoardSeat {
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}

export function BoardSeats({ boardSeats }: { boardSeats: BoardSeat[] }) {
  if (boardSeats.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Board Seats
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {boardSeats.length}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card">
        {boardSeats.map(({ org, record }) => {
          const role = fieldStr(record.fields, "role");
          const appointed = fieldStr(record.fields, "appointed");
          const departed = fieldStr(record.fields, "departed");
          const orgSlug = getKBEntitySlug(org.id);

          return (
            <div
              key={`${org.id}-${record.key}`}
              className="px-4 py-3 border-b border-border/40 last:border-b-0"
            >
              <div className="flex items-center gap-1.5 flex-wrap">
                {orgSlug ? (
                  <Link
                    href={`/organizations/${orgSlug}`}
                    className="font-semibold text-sm hover:text-primary transition-colors"
                  >
                    {org.name}
                  </Link>
                ) : (
                  <span className="font-semibold text-sm">{org.name}</span>
                )}
                {!departed && <CurrentBadge />}
              </div>
              {role && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {role}
                </div>
              )}
              <div className="text-[10px] text-muted-foreground/50 mt-1">
                {formatDateRange(appointed, departed)}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
