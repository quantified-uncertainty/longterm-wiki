import Link from "next/link";

import { getKBEntity, getKBProperty, getKBLatest } from "@/data/factbase";
import type { Fact, Property } from "@longterm-wiki/factbase";
import {
  formatKBFactValue,
  formatKBDate,
  shortDomain,
  titleCase,
  isUrl,
} from "@/components/wiki/factbase/format";
import { FactSourceCheckDot } from "@/components/verification/FactSourceCheckDot";

import { SectionHeader } from "./entity-section-header";

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

/** Category section for grouped facts. */
export function CategoryFactSection({
  category,
  categoryLabel,
  propertyIds,
  factGroups,
}: {
  category: string;
  categoryLabel: string;
  propertyIds: string[];
  factGroups: Map<string, Fact[]>;
}) {
  return (
    <section className="mb-6">
      <SectionHeader
        title={categoryLabel}
        id={`cat-${category}`}
      />
      <div className="border border-border/60 rounded-xl overflow-hidden divide-y divide-border/40 max-w-4xl">
        {propertyIds.map((propertyId) => {
          const facts = factGroups.get(propertyId) ?? [];
          if (facts.length === 0) return null;
          const property = getKBProperty(propertyId);
          const latestFact = facts[0];

          return (
            <details key={propertyId} id={propertyId} className="group scroll-mt-16">
              <summary className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-muted/30 text-sm select-none transition-colors">
                <span className="inline-flex items-center gap-1.5 font-semibold min-w-[10rem] text-foreground/90">
                  <FactSourceCheckDot factId={latestFact.id} sourceUrl={latestFact.source} size="sm" />
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
                <span className="text-muted-foreground/50 text-xs group-open:rotate-90 transition-transform">
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
                      <th className="text-left py-1 pr-3 font-medium">Fact ID</th>
                      <th className="text-left py-1 font-medium w-5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/50">
                    {facts.map((fact) => {
                      return (
                        <tr key={fact.id} id={fact.id} className="scroll-mt-16">
                          <td className="py-1.5 pr-3 text-muted-foreground whitespace-nowrap">
                            {formatKBDate(fact.asOf)}
                          </td>
                          <td className="py-1.5 pr-3">
                            <FactValueDisplay fact={fact} property={property} />
                          </td>
                          <td className="py-1.5 pr-3">
                            <Link
                              href={`/factbase/fact/${fact.id}`}
                              className="text-blue-600 hover:underline dark:text-blue-400 font-mono text-xs"
                            >
                              {fact.id}
                            </Link>
                          </td>
                          <td className="py-1.5 pl-1">
                            <FactSourceCheckDot factId={fact.id} sourceUrl={fact.source} size="md" />
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
