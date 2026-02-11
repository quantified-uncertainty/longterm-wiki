"use client";

import { useState, useRef, useEffect } from "react";

interface InfoBoxDescriptionProps {
  description: string;
}

/**
 * InfoBox description with expand/collapse toggle.
 * Shows first 3 lines by default; if the text overflows, shows a "more" / "less" toggle.
 */
export function InfoBoxDescription({ description }: InfoBoxDescriptionProps) {
  const [expanded, setExpanded] = useState(false);
  const [isClamped, setIsClamped] = useState(false);
  const textRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = textRef.current;
    if (el) {
      // scrollHeight > clientHeight means text overflows the line-clamp
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, [description]);

  return (
    <div className="px-4 py-2.5 border-b border-border">
      <p
        ref={textRef}
        className={`text-xs text-muted-foreground leading-relaxed m-0 ${expanded ? "" : "line-clamp-3"}`}
      >
        {description}
      </p>
      {(isClamped || expanded) && (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 text-[11px] font-medium text-accent-foreground hover:underline bg-transparent border-0 p-0 cursor-pointer"
        >
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
