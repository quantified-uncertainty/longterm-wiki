"use client";

import { useState } from "react";
import Link from "next/link";
import { ExternalLink, ChevronDown } from "lucide-react";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import { getDomain, isSafeUrl } from "@components/wiki/resource-utils";
import type { StatementWithDetails } from "@lib/statement-types";

const INITIAL_SHOW = 8;

function InlineSourceLinks({ citations }: { citations: StatementWithDetails["citations"] }) {
  if (citations.length === 0) return null;

  const seen = new Map<string, { url: string; domain: string }>();
  for (const cit of citations) {
    if (!cit.url || !isSafeUrl(cit.url)) continue;
    const domain = getDomain(cit.url) ?? cit.url;
    if (!seen.has(domain)) {
      seen.set(domain, { url: cit.url, domain });
    }
  }

  const entries = [...seen.values()].slice(0, 2);
  if (entries.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 text-[10px]">
      {entries.map((e, i) => (
        <a
          key={i}
          href={e.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
          onClick={(ev) => ev.stopPropagation()}
        >
          {e.domain}
          <ExternalLink className="w-2.5 h-2.5 shrink-0" />
        </a>
      ))}
    </span>
  );
}

/**
 * Compact list of attributed statements. Each row shows the statement text,
 * verdict badge, category pill, source links — all on minimal vertical space.
 */
export function AttributedStatementsTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
  const [showAll, setShowAll] = useState(false);

  if (statements.length === 0) return null;

  const visible = showAll ? statements : statements.slice(0, INITIAL_SHOW);
  const hiddenCount = statements.length - INITIAL_SHOW;

  return (
    <div>
      <div className="rounded-lg border border-border/60 divide-y divide-border/30">
        {visible.map((s) => (
          <div key={s.id} className="px-2.5 py-1.5 flex items-start gap-2">
            {/* Statement text — takes most of the width */}
            <div className="flex-1 min-w-0">
              <p className="text-xs text-muted-foreground line-clamp-2">
                {s.statementText ? (
                  <span className="italic">&ldquo;{s.statementText}&rdquo;</span>
                ) : (
                  <span className="text-muted-foreground/40">—</span>
                )}
              </p>
              {/* Second line: attribution + sources */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-0.5">
                {s.attributedTo && (
                  <span className="text-[10px] text-muted-foreground">
                    <Link href={`/wiki/${s.attributedTo}`} className="text-blue-600 hover:underline">
                      {s.attributedTo}
                    </Link>
                  </span>
                )}
                {s.claimCategory && (
                  <span className="text-[10px] text-muted-foreground/70">{s.claimCategory}</span>
                )}
                <InlineSourceLinks citations={s.citations} />
              </div>
            </div>
            {/* Verdict badge — right aligned */}
            <div className="shrink-0 mt-0.5">
              <VerdictBadge verdict={s.verdict} score={s.verdictScore} />
            </div>
          </div>
        ))}
      </div>
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5 cursor-pointer"
        >
          Show {hiddenCount} more
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
