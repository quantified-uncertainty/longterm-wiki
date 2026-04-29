import Link from "next/link";

import { getKBEntity } from "@/data/factbase";
import type { FactBaseRecordEntry } from "@/data/factbase";
import {
  formatKBDate,
  shortDomain,
  isUrl,
} from "@/components/wiki/factbase/format";
import { formatAmount } from "@/lib/directory-utils";

import { field, getRecordDisplayName } from "./entity-detail-shared";

/** Funding round row for timeline display. */
export function FundingRoundRow({ item }: { item: FactBaseRecordEntry }) {
  const name = getRecordDisplayName(item);
  const date = field(item, "date");
  const raised = item.fields.raised;
  const valuation = item.fields.valuation;
  const leadInvestor = field(item, "lead_investor");
  const instrument = field(item, "instrument");
  const notes = field(item, "notes");
  const source = field(item, "source");

  const leadEntity = leadInvestor ? getKBEntity(leadInvestor) : null;

  return (
    <div className="flex gap-4 py-4 border-b border-border/40 last:border-b-0 group/row hover:bg-muted/20 -mx-4 px-4 transition-colors">
      {/* Timeline dot */}
      <div className="flex flex-col items-center pt-1">
        <div className="w-3 h-3 rounded-full border-2 border-primary/50 bg-card shrink-0 group-hover/row:border-primary transition-colors" />
        <div className="w-px flex-1 bg-gradient-to-b from-border/50 to-transparent mt-1" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-semibold text-sm">{name}</span>
          {instrument && (
            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground font-medium">
              {instrument}
            </span>
          )}
          {date && <span className="text-xs text-muted-foreground/70">{formatKBDate(date)}</span>}
        </div>
        <div className="flex items-baseline gap-4 mt-1.5 flex-wrap">
          {raised != null && (
            <span className="text-base font-bold tabular-nums tracking-tight text-foreground">
              {formatAmount(raised)}
            </span>
          )}
          {valuation != null && (
            <span className="text-xs text-muted-foreground">
              at {formatAmount(valuation)} valuation
            </span>
          )}
          {leadInvestor && (
            <span className="text-xs text-muted-foreground">
              Led by{" "}
              {leadEntity ? (
                <Link href={`/factbase/entity/${leadInvestor}`} className="text-primary hover:underline">
                  {leadEntity.name}
                </Link>
              ) : (
                leadInvestor
              )}
            </span>
          )}
        </div>
        {notes && <div className="text-[10px] text-muted-foreground/50 mt-1.5 line-clamp-2">{notes}</div>}
        {source && isUrl(source) && (
          <a href={source} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary/50 hover:text-primary hover:underline mt-1 inline-block transition-colors">
            {shortDomain(source)}
          </a>
        )}
      </div>
    </div>
  );
}

/** Product card. */
export function ProductCard({ item }: { item: FactBaseRecordEntry }) {
  const name = getRecordDisplayName(item);
  const launched = field(item, "launched");
  const description = field(item, "description");
  const source = field(item, "source");

  return (
    <div className="group rounded-xl border border-border/60 bg-card p-4 transition-all hover:shadow-md hover:border-border">
      <div className="flex items-baseline gap-2">
        <span className="font-semibold text-sm group-hover:text-primary transition-colors">{name}</span>
        {launched && (
          <span className="text-[10px] text-muted-foreground/60">{formatKBDate(launched)}</span>
        )}
      </div>
      {description && <div className="text-xs text-muted-foreground mt-1.5 line-clamp-2 leading-relaxed">{description}</div>}
      {source && isUrl(source) && (
        <a href={source} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary/50 hover:text-primary hover:underline mt-1.5 inline-block transition-colors">
          {shortDomain(source)}
        </a>
      )}
    </div>
  );
}

/** Model release row. */
export function ModelReleaseRow({ item }: { item: FactBaseRecordEntry }) {
  const name = getRecordDisplayName(item);
  const released = field(item, "released");
  const description = field(item, "description");
  const safetyLevel = field(item, "safety_level");

  return (
    <div className="flex items-start gap-3 py-2.5 border-b border-border/50 last:border-b-0">
      <div className="min-w-[70px] text-xs text-muted-foreground pt-0.5">
        {released ? formatKBDate(released) : "\u2014"}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className="font-medium text-sm">{name}</span>
          {safetyLevel && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
              {safetyLevel}
            </span>
          )}
        </div>
        {description && <div className="text-xs text-muted-foreground mt-0.5">{description}</div>}
      </div>
    </div>
  );
}
