"use client";

import { useState, useRef, useEffect, useCallback } from "react";

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

  const checkOverflow = useCallback(() => {
    const el = textRef.current;
    if (el) {
      setIsClamped(el.scrollHeight > el.clientHeight + 1);
    }
  }, []);

  useEffect(() => {
    checkOverflow();

    // Re-check after fonts finish loading (line heights may change)
    if (typeof document !== "undefined" && document.fonts?.ready) {
      document.fonts.ready.then(checkOverflow);
    }

    // Re-check on resize (InfoBox width can change between mobile/desktop)
    const el = textRef.current;
    if (!el) return;

    const observer = new ResizeObserver(checkOverflow);
    observer.observe(el);
    return () => observer.disconnect();
  }, [description, checkOverflow]);

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
