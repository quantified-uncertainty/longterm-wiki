import Link from "next/link";

import { getKBEntity, getKBProperty, getKBRecordSchema, getKBLatest } from "@/data/factbase";
import type { Fact, Property } from "@longterm-wiki/factbase";
import type { FactBaseRecordEntry } from "@/data/factbase";
import {
  formatKBFactValue,
  formatKBDate,
  shortDomain,
  titleCase,
  isUrl,
} from "@/components/wiki/factbase/format";
import { FBCellValue } from "@/components/wiki/factbase/FBCellValue";
import { formatAmount } from "@/lib/directory-utils";

// ─── Types ──────────────────────────────────────────────────────────

export type { VerdictRow, VerdictsResponse } from "@/components/shared/verdict-styles";
import type { VerdictRow } from "@/components/shared/verdict-styles";
import {
  SOURCE_CHECK_VERDICT_STYLES,
  type SourceCheckVerdictType,
} from "@/components/shared/verdict-styles";

// Re-export for backward compatibility
export const VERDICT_STYLES = SOURCE_CHECK_VERDICT_STYLES;

/** Properties to show as hero stat cards (order matters). */
export const HERO_STAT_PROPERTIES: Record<string, string[]> = {
  organization: ["revenue", "valuation", "headcount", "total-funding", "enterprise-market-share", "founded-date"],
  person: ["employed-by", "role", "net-worth", "born-year"],
  "ai-model": ["developed-by", "parameter-count", "context-window", "model-release-date"],
};

/** Collections that get special rendering. */
export const SPECIAL_COLLECTIONS = new Set([
  "key-persons",
  "funding-rounds",
  "model-releases",
  "products",
]);

// ─── Helpers ────────────────────────────────────────────────────────

/** Safely get a string field from a record, or undefined. */
export function field(item: FactBaseRecordEntry, key: string): string | undefined {
  const v = item.fields[key];
  if (v == null) return undefined;
  return String(v);
}

/** Sort record entries by a date field, newest first. */
export function sortByDateField(items: FactBaseRecordEntry[], fieldName: string): FactBaseRecordEntry[] {
  return [...items].sort((a, b) => {
    const dateA = a.fields[fieldName] ? String(a.fields[fieldName]) : "";
    const dateB = b.fields[fieldName] ? String(b.fields[fieldName]) : "";
    return dateB.localeCompare(dateA);
  });
}

// ─── Components ─────────────────────────────────────────────────────

export function VerdictBadge({ verdict }: { verdict: VerdictRow }) {
  const style = VERDICT_STYLES[verdict.verdict as SourceCheckVerdictType] ?? VERDICT_STYLES.unchecked;
  const confidence = verdict.confidence != null ? Math.round(verdict.confidence * 100) : null;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium leading-tight ${style.className}`}
      title={verdict.reasoning ?? undefined}
    >
      {style.label}
      {confidence != null && <span className="opacity-70">{confidence}%</span>}
    </span>
  );
}

export function SourceCell({ fact }: { fact: Fact }) {
  if (fact.source) {
    if (isUrl(fact.source)) {
      return (
        <a
          href={fact.source}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          {shortDomain(fact.source)}
        </a>
      );
    }
    return <span className="text-xs text-muted-foreground">{fact.source}</span>;
  }
  return <span className="text-muted-foreground">&mdash;</span>;
}

export function FactValueDisplay({ fact, property }: { fact: Fact; property?: Property }) {
  const v = fact.value;
  if (v.type === "ref") {
    const refEntity = getKBEntity(v.value);
    return (
      <Link href={`/factbase/entity/${v.value}`} className="text-blue-600 hover:underline dark:text-blue-400">
        {refEntity?.name ?? v.value}
      </Link>
    );
  }
  if (v.type === "refs") {
    return (
      <span>
        {v.value.map((refId, i) => {
          const refEntity = getKBEntity(refId);
          return (
            <span key={`${refId}-${i}`}>
              {i > 0 && ", "}
              <Link href={`/factbase/entity/${refId}`} className="text-blue-600 hover:underline dark:text-blue-400">
                {refEntity?.name ?? refId}
              </Link>
            </span>
          );
        })}
      </span>
    );
  }
  // Guard against formatKBFactValue accidentally returning a non-string
  // (which would render as "[object Object]" in JSX).
  const formatted = formatKBFactValue(fact, property?.unit, property?.display);
  const safeFormatted = typeof formatted === "string" ? formatted : JSON.stringify(formatted);
  return <span>{safeFormatted}</span>;
}

/** Hero stat card for a key metric. */
export function StatCard({ entityId, propertyId }: { entityId: string; propertyId: string }) {
  const fact = getKBLatest(entityId, propertyId);
  const prop = getKBProperty(propertyId);
  if (!fact) return null;

  return (
    <div className="relative overflow-hidden rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4 transition-shadow hover:shadow-md">
      <div className="absolute top-0 right-0 w-16 h-16 bg-primary/[0.03] rounded-bl-[2rem]" />
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1.5">
        {prop?.name ?? titleCase(propertyId)}
      </div>
      <div className="text-xl font-bold tabular-nums tracking-tight text-foreground">
        <FactValueDisplay fact={fact} property={prop} />
      </div>
      {fact.asOf && (
        <div className="text-[10px] text-muted-foreground/50 mt-1">
          as of {formatKBDate(fact.asOf)}
        </div>
      )}
    </div>
  );
}

/** Person card for key-persons collection. */
export function PersonCard({ item }: { item: FactBaseRecordEntry }) {
  const personId = field(item, "person");
  const personEntity = personId ? getKBEntity(personId) : null;
  const name = personEntity?.name ?? item.displayName ?? titleCase(item.key);
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

/** Funding round row for timeline display. */
export function FundingRoundRow({ item }: { item: FactBaseRecordEntry }) {
  const name = field(item, "name") ?? titleCase(item.key);
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
  const name = field(item, "name") ?? titleCase(item.key);
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
  const name = field(item, "name") ?? titleCase(item.key);
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

/** Category section for grouped facts. */
export function CategoryFactSection({
  category,
  categoryLabel,
  propertyIds,
  factGroups,
  verdicts,
}: {
  category: string;
  categoryLabel: string;
  propertyIds: string[];
  factGroups: Map<string, Fact[]>;
  verdicts: Map<string, VerdictRow>;
}) {
  return (
    <section className="mb-6">
      <SectionHeader
        title={categoryLabel}
        id={`cat-${category}`}
      />
      <div className="border border-border/60 rounded-xl overflow-hidden divide-y divide-border/40">
        {propertyIds.map((propertyId) => {
          const facts = factGroups.get(propertyId) ?? [];
          if (facts.length === 0) return null;
          const property = getKBProperty(propertyId);
          const latestFact = facts[0];

          return (
            <details key={propertyId} id={propertyId} className="group scroll-mt-16">
              <summary className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-muted/30 text-sm select-none transition-colors">
                <span className="font-semibold min-w-[10rem] text-foreground/90">
                  {property?.name ?? propertyId}
                </span>
                <span className="flex-1 text-muted-foreground truncate font-mono text-[13px]">
                  <FactValueDisplay fact={latestFact} property={property} />
                </span>
                <span className="text-muted-foreground/60 text-xs whitespace-nowrap">
                  {formatKBDate(latestFact.asOf)}
                </span>
                {facts.length > 1 && (
                  <span className="text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground whitespace-nowrap">
                    {facts.length} pts
                  </span>
                )}
                <span className="text-muted-foreground/40 text-xs group-open:rotate-90 transition-transform">
                  &#9654;
                </span>
              </summary>

              <div className="px-4 pb-3 pt-1 bg-muted/20">
                <div className="mb-2">
                  <Link
                    href={`/factbase/property/${propertyId}`}
                    className="text-blue-600 hover:underline dark:text-blue-400 text-xs"
                  >
                    View property &rarr;
                  </Link>
                </div>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-1 pr-3 font-medium">As Of</th>
                      <th className="text-left py-1 pr-3 font-medium">Value</th>
                      <th className="text-left py-1 pr-3 font-medium">Source</th>
                      {verdicts.size > 0 && (
                        <th className="text-left py-1 pr-3 font-medium">Verified</th>
                      )}
                      <th className="text-left py-1 font-medium">Fact ID</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {facts.map((fact) => {
                      const verdict = verdicts.get(fact.id);
                      return (
                        <tr key={fact.id} id={fact.id} className="scroll-mt-16">
                          <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                            {formatKBDate(fact.asOf)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <FactValueDisplay fact={fact} property={property} />
                          </td>
                          <td className="py-1.5 pr-3">
                            <SourceCell fact={fact} />
                          </td>
                          {verdicts.size > 0 && (
                            <td className="py-1.5 pr-3">
                              {verdict ? (
                                <VerdictBadge verdict={verdict} />
                              ) : (
                                <span className="text-xs text-muted-foreground">&mdash;</span>
                              )}
                            </td>
                          )}
                          <td className="py-1.5">
                            <Link
                              href={`/factbase/fact/${fact.id}`}
                              className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs"
                            >
                              {fact.id}
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}
      </div>
    </section>
  );
}

/** Generic collection table (for collections without special rendering). */
export function GenericCollectionTable({
  collectionName,
  items,
}: {
  collectionName: string;
  items: FactBaseRecordEntry[];
}) {
  const recordSchema = items[0] ? getKBRecordSchema(items[0].schema) : undefined;
  const fieldDefs = recordSchema?.fields;
  const endpointDefs = recordSchema?.endpoints;

  const schemaFieldNames = fieldDefs ? Object.keys(fieldDefs) : [];
  const allFieldNames = new Set<string>();
  for (const item of items) {
    for (const key of Object.keys(item.fields)) {
      allFieldNames.add(key);
    }
  }
  const columns = schemaFieldNames.length > 0
    ? [...schemaFieldNames, ...[...allFieldNames].filter((f) => !schemaFieldNames.includes(f))]
    : [...allFieldNames];

  return (
    <section className="mb-6">
      <SectionHeader title={titleCase(collectionName)} count={items.length} id={`col-${collectionName}`} />
      <div className="border border-border rounded-lg overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              {columns.map((col) => (
                <th key={col} className="text-left py-1.5 px-3 font-medium">
                  {titleCase(col)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {items.map((item) => (
              <tr key={item.key}>
                {columns.map((col) => {
                  const cellValue = item.fields[col];
                  const fieldDef =
                    fieldDefs?.[col] ??
                    (endpointDefs && col in endpointDefs
                      ? { type: "ref" as const }
                      : undefined);

                  return (
                    <td key={col} className="py-1.5 px-3">
                      <FBCellValue
                        value={cellValue}
                        fieldName={col}
                        fieldDef={fieldDef}
                      />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function VerificationSummary({
  verdicts,
  totalFacts,
}: {
  verdicts: Map<string, VerdictRow>;
  totalFacts: number;
}) {
  const counts: Record<string, number> = {};
  for (const v of verdicts.values()) {
    counts[v.verdict] = (counts[v.verdict] ?? 0) + 1;
  }
  const checked = verdicts.size;
  const unchecked = totalFacts - checked;

  return (
    <span className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">
        {checked}/{totalFacts} checked
      </span>
      {(["confirmed", "contradicted", "outdated", "partial", "unverifiable"] as const).map(
        (v) =>
          counts[v] ? (
            <span
              key={v}
              className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded font-medium leading-tight ${VERDICT_STYLES[v].className}`}
            >
              {counts[v]} {VERDICT_STYLES[v].label.toLowerCase()}
            </span>
          ) : null,
      )}
      {unchecked > 0 && (
        <span className="text-muted-foreground">{unchecked} unchecked</span>
      )}
    </span>
  );
}
