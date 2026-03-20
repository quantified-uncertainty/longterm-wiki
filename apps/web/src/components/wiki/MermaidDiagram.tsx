"use client";

import { useEffect, useState } from "react";

let mermaidInitialized = false;

async function getMermaid() {
  const mermaid = (await import("mermaid")).default;
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "default" as const,
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    mermaidInitialized = true;
  }
  return mermaid;
}

/** Race a promise against a timeout. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

interface MermaidProps {
  chart?: string;
  children?: React.ReactNode;
}

/**
 * Collapsible code block fallback shown while the diagram loads or if it fails.
 * Server-rendered HTML includes this, so there's no flash of "Loading diagram…" text.
 */
function MermaidCodeFallback({
  chartText,
  error,
}: {
  chartText: string;
  error?: string | null;
}) {
  return (
    <details className="my-6 rounded-lg border border-border bg-muted/30 text-sm group">
      <summary className="cursor-pointer px-4 py-3 text-muted-foreground select-none hover:bg-muted/50 transition-colors flex items-center gap-2">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-4 h-4 shrink-0"
          aria-hidden="true"
        >
          {/* Simple diagram icon (git-branch-like) */}
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        {error ? "Diagram (could not render)" : "Diagram (loading\u2026)"}
      </summary>
      <pre className="px-4 py-3 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap border-t border-border bg-muted/20">
        {chartText.trim()}
      </pre>
      {error && (
        <p className="px-4 py-2 text-xs text-red-600 dark:text-red-400 border-t border-border">
          {error}
        </p>
      )}
    </details>
  );
}

export function MermaidDiagram({ chart, children }: MermaidProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const chartText = chart || (typeof children === "string" ? children : "");

  useEffect(() => {
    if (!chartText) return;

    let cancelled = false;

    const renderChart = async () => {
      try {
        // 15 s timeout: mermaid chunks are ~3 MB; allow time to download but
        // don't hang forever if something goes wrong.
        const mermaid = await withTimeout(getMermaid(), 15_000);

        const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
        const { svg: renderedSvg } = await withTimeout(
          mermaid.render(id, chartText.trim()),
          10_000,
        );
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("Mermaid rendering error:", err);
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      }
    };

    renderChart();
    return () => { cancelled = true; };
  }, [chartText]);

  if (!chartText) return null;

  // Rendered SVG — show it
  if (svg) {
    return (
      <div
        className="flex justify-center my-6 p-4 bg-muted/50 rounded-lg overflow-auto"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  // Still loading or errored — show collapsible code block.
  // This is also what the server pre-renders into the static HTML, so visitors
  // never see a bare "Loading diagram..." string.
  return <MermaidCodeFallback chartText={chartText} error={error} />;
}

export default MermaidDiagram;
