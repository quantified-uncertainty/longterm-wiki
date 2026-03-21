"use client";

import * as Popover from "@radix-ui/react-popover";

interface StakeholderDetailProps {
  reason: string | undefined;
  context: string[] | undefined;
  source: string | undefined;
}

export function StakeholderReasonCell({
  reason,
  context,
  source,
}: StakeholderDetailProps) {
  const hasContext = context && context.length > 0;
  const hasMore = hasContext || (reason && reason.length > 100);

  if (!reason && !hasContext) {
    return <span className="text-muted-foreground/40">&mdash;</span>;
  }

  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <span className="line-clamp-2">{reason ?? "\u2014"}</span>
        {source && (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 text-primary hover:underline text-xs"
          >
            [source]
          </a>
        )}
      </div>
      {hasMore && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="shrink-0 mt-0.5 w-5 h-5 rounded-md flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              aria-label="Show full details"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7v4M8 5.5v0" strokeLinecap="round" />
              </svg>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="end"
              sideOffset={4}
              className="z-50 w-80 rounded-lg border border-border bg-card shadow-lg p-4 text-sm animate-in fade-in-0 zoom-in-95"
            >
              {reason && (
                <p className="text-foreground leading-relaxed">{reason}</p>
              )}
              {source && (
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-2 text-primary hover:underline text-xs"
                >
                  View source &rarr;
                </a>
              )}
              {hasContext && (
                <>
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Context &amp; Connections
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground list-none pl-0">
                    {context!.map((note, j) => (
                      <li key={j} className="leading-relaxed">
                        <span className="text-muted-foreground/40 mr-1">
                          &rarr;
                        </span>
                        {note}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Popover.Arrow className="fill-border" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}
