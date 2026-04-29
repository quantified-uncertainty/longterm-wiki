import Link from "next/link";

import { getKBEntity } from "@/data/factbase";
import type { FactBaseRecordEntry } from "@/data/factbase";
import { formatKBDate } from "@/components/wiki/factbase/format";

import { field, getPersonRecordName } from "./entity-detail-shared";

/** Person card for key-persons collection. */
export function PersonCard({ item }: { item: FactBaseRecordEntry }) {
  const personId = field(item, "person");
  const personEntity = personId ? getKBEntity(personId) : null;
  const name = getPersonRecordName(item, personEntity);
  const title = field(item, "title");
  const start = field(item, "start");
  const end = field(item, "end");
  const isFounder = !!item.fields.is_founder;
  const notes = field(item, "notes");

  const initials = name.split(/\s+/).map(w => w[0]).filter(Boolean).slice(0, 2).join("").toUpperCase();

  return (
    <div className="group relative rounded-xl border border-border/60 bg-card p-4 transition-all hover:shadow-md hover:border-border">
      <div className="flex items-start gap-3">
        <div className="shrink-0 w-9 h-9 rounded-full bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xs font-semibold text-primary/70">
          {initials}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            {personEntity && personId ? (
              <Link href={`/factbase/entity/${personId}`} className="font-semibold text-sm text-foreground group-hover:text-primary transition-colors">
                {name}
              </Link>
            ) : (
              <span className="font-semibold text-sm">{name}</span>
            )}
            {isFounder && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                Founder
              </span>
            )}
          </div>
          {title && <div className="text-xs text-muted-foreground mt-0.5">{title}</div>}
          <div className="text-[10px] text-muted-foreground/50 mt-1">
            {start && formatKBDate(start)}
            {end ? ` \u2013 ${formatKBDate(end)}` : start ? " \u2013 present" : ""}
          </div>
          {notes && <div className="text-[10px] text-muted-foreground/50 mt-1 line-clamp-2">{notes}</div>}
        </div>
      </div>
    </div>
  );
}
