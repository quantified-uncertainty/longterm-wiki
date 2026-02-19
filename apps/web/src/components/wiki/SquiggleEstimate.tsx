"use client";

import { useState, useMemo, useEffect } from "react";

const defaultEnvironment = {
  seed: "longterm",
  sampleCount: 5000,
  xyPointLength: 1000,
};

interface SquiggleEstimateProps {
  /** Title displayed above the chart */
  title?: string;
  /** Squiggle code to evaluate - passed directly */
  code?: string;
  /** Children code block (for MDX usage) */
  children?: React.ReactNode;
  /** Whether to start with the editor visible */
  showEditor?: boolean;
}

/**
 * Renders a Squiggle estimate as an interactive visualization.
 * Squiggle libraries are lazy-loaded only when this component mounts.
 *
 * Usage in MDX:
 *   <SquiggleEstimate title="Revenue" code="normal(9, 2)" />
 */
export function SquiggleEstimate({
  title,
  code: codeProp,
  children,
  showEditor: initialShowEditor = false,
}: SquiggleEstimateProps) {
  const [showEditor, setShowEditor] = useState(initialShowEditor);
  const [SquiggleComponents, setSquiggleComponents] = useState<{
    SquiggleChart: React.ComponentType<any>;
    SquiggleEditor: React.ComponentType<any>;
  } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const code = useMemo(() => {
    if (codeProp) return codeProp.trim();

    if (children) {
      if (typeof children === "string") return children.trim();

      const c = children as any;
      if (c?.props?.children?.props?.children) {
        return String(c.props.children.props.children).trim();
      }
      if (c?.props?.children) {
        return String(c.props.children).trim();
      }
    }
    return "";
  }, [codeProp, children]);

  // Lazy-load Squiggle library and CSS only when component mounts
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      import("@quri/squiggle-components"),
      import("@quri/squiggle-components/full.css"),
    ]).then(([mod]) => {
      if (!cancelled) {
        setSquiggleComponents({
          SquiggleChart: mod.SquiggleChart,
          SquiggleEditor: mod.SquiggleEditor,
        });
      }
    }).catch((err) => {
      if (!cancelled) {
        setLoadError(err instanceof Error ? err.message : "Failed to load Squiggle");
      }
    });
    return () => { cancelled = true; };
  }, []);

  if (!code) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm my-4">
        SquiggleEstimate: No code provided
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm my-4">
        Failed to load Squiggle: {loadError}
      </div>
    );
  }

  const toggleButton = (
    <button
      onClick={() => setShowEditor(!showEditor)}
      className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
    >
      {showEditor ? "hide" : "show"} source
    </button>
  );

  return (
    <div className="my-4 border border-border rounded-lg overflow-hidden bg-white">
      {title && (
        <div className="flex items-center justify-between px-4 py-2 bg-muted/50 border-b border-border">
          <h4 className="text-sm font-semibold m-0">{title}</h4>
          {toggleButton}
        </div>
      )}
      {!title && (
        <div className="flex justify-end px-4 py-1 bg-muted/50 border-b border-border">
          {toggleButton}
        </div>
      )}
      <div className="p-4">
        {!SquiggleComponents ? (
          <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
            Loading Squiggle...
          </div>
        ) : showEditor ? (
          <SquiggleComponents.SquiggleEditor
            defaultCode={code}
            environment={defaultEnvironment}
          />
        ) : (
          <SquiggleComponents.SquiggleChart
            code={code}
            environment={defaultEnvironment}
          />
        )}
      </div>
    </div>
  );
}
