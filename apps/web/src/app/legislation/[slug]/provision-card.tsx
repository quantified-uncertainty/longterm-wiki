"use client";

import { useState } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { ChevronRight } from "lucide-react";

interface ProvisionCardProps {
  title: string;
  description: string;
  billSection?: string;
  details?: string;
  billQuote?: string;
  amendmentNotes?: string;
  fullTextUrl?: string;
}

export function ProvisionCard({
  title,
  description,
  billSection,
  billQuote,
  amendmentNotes,
  fullTextUrl,
}: ProvisionCardProps) {
  const [open, setOpen] = useState(false);
  const hasExpandableContent = !!(billQuote || amendmentNotes);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        className={`rounded-lg border transition-colors ${
          open
            ? "border-border/80 bg-card shadow-sm"
            : "border-transparent"
        }`}
      >
        <CollapsibleTrigger
          className={`w-full text-left px-4 py-3 rounded-lg transition-colors ${
            !open && hasExpandableContent ? "hover:bg-muted/30" : ""
          } ${hasExpandableContent ? "cursor-pointer" : "cursor-default"}`}
          disabled={!hasExpandableContent}
        >
          <div className="flex items-start gap-2.5">
            {hasExpandableContent && (
              <ChevronRight
                className={`w-4 h-4 mt-[1px] shrink-0 text-muted-foreground/40 transition-transform duration-200 ${
                  open ? "rotate-90" : ""
                }`}
              />
            )}
            {!hasExpandableContent && <div className="w-4 shrink-0" />}

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm">{title}</span>
                {billSection && (
                  <Badge
                    variant="outline"
                    className="font-mono text-[10px] px-1.5 py-0 h-[18px] text-muted-foreground/50 border-border/50"
                  >
                    {billSection}
                  </Badge>
                )}
              </div>
              <p className="text-[13px] text-muted-foreground leading-relaxed mt-0.5">
                {description}
              </p>
            </div>
          </div>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-4 pb-4 pt-1 ml-[26px] space-y-2.5">
            <div className="border-t border-border/50 pt-2.5" />

            {billQuote && (
              <div className="rounded-md bg-muted/40 px-3.5 py-2.5">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1.5">
                  Bill language
                </p>
                <p className="text-[13px] text-foreground/80 leading-[1.7] italic">
                  {billQuote}
                </p>
              </div>
            )}

            {amendmentNotes && (
              <div className="rounded-md bg-amber-50/60 dark:bg-amber-950/15 px-3.5 py-2.5">
                <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/50 mb-1.5">
                  Changes during amendment
                </p>
                <p className="text-[13px] text-foreground/80 leading-[1.7]">
                  {amendmentNotes}
                </p>
              </div>
            )}

            {billSection && fullTextUrl && (
              <a
                href={fullTextUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors"
              >
                Read {billSection} in enrolled text &rarr;
              </a>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
