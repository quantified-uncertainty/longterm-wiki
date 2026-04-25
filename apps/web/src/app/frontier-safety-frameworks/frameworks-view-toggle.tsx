"use client";

import { useState } from "react";

export type ViewMode = "matrix" | "timeline";

interface ViewToggleProps {
  defaultView?: ViewMode;
  matrix: React.ReactNode;
  timeline: React.ReactNode;
}

/**
 * Client toggle between the matrix and timeline views. Both panels are
 * rendered server-side and passed in as `ReactNode` slots; the toggle just
 * shows/hides them with CSS so swapping is instant and no extra fetch fires.
 */
export function FrameworksViewToggle({
  defaultView = "matrix",
  matrix,
  timeline,
}: ViewToggleProps) {
  const [view, setView] = useState<ViewMode>(defaultView);
  return (
    <div>
      <div
        role="tablist"
        aria-label="Frameworks view"
        className="inline-flex items-center gap-1 rounded-lg border border-border/60 bg-muted/30 p-1 mb-4"
      >
        <button
          type="button"
          role="tab"
          aria-selected={view === "matrix"}
          onClick={() => setView("matrix")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            view === "matrix"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Matrix
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === "timeline"}
          onClick={() => setView("timeline")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
            view === "timeline"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          Timeline
        </button>
      </div>
      <div hidden={view !== "matrix"}>{matrix}</div>
      <div hidden={view !== "timeline"}>{timeline}</div>
    </div>
  );
}
