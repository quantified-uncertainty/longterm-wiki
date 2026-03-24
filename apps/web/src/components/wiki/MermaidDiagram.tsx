"use client";

import { useCallback, useEffect, useRef, useState } from "react";

let mermaidInitialized = false;

type MermaidAPI = typeof import("mermaid").default;

/** Cached mermaid module — avoids re-importing after first successful load. */
let mermaidModule: MermaidAPI | null = null;

async function getMermaid() {
  if (mermaidModule) {
    return mermaidModule;
  }
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
  mermaidModule = mermaid;
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

/** Max automatic retries before showing error state with manual retry button. */
const MAX_AUTO_RETRIES = 1;
/** Timeout for loading the mermaid library (first load downloads ~3 MB). */
const LIBRARY_LOAD_TIMEOUT_MS = 20_000;
/** Timeout for rendering a single diagram after the library is loaded. */
const RENDER_TIMEOUT_MS = 10_000;
/** Delay between automatic retries. */
const RETRY_DELAY_MS = 1_000;

interface MermaidProps {
  chart?: string;
  children?: React.ReactNode;
}

/**
 * Collapsible code block fallback shown while the diagram loads or if it fails.
 * Server-rendered HTML includes this, so there's no flash of "Loading diagram..." text.
 */
function MermaidCodeFallback({
  chartText,
  error,
  onRetry,
}: {
  chartText: string;
  error?: string | null;
  onRetry?: () => void;
}) {
  return (
    <details className="my-6 rounded-lg border border-border bg-muted/30 text-sm group" open={!!error}>
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
        <div className="px-4 py-2 border-t border-border flex items-center gap-3">
          <p className="text-xs text-red-600 dark:text-red-400 flex-1">
            {error}
          </p>
          {onRetry && (
            <button
              onClick={onRetry}
              className="shrink-0 text-xs px-3 py-1 rounded border border-border bg-background hover:bg-muted transition-colors text-foreground"
            >
              Retry
            </button>
          )}
        </div>
      )}
    </details>
  );
}

export function MermaidDiagram({ chart, children }: MermaidProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const chartText = chart || (typeof children === "string" ? children : "");
  const cancelledRef = useRef(false);

  const renderChart = useCallback(async (attempt: number) => {
    cancelledRef.current = false;
    setError(null);
    setSvg("");

    if (!chartText) return;

    try {
      const mermaid = await withTimeout(getMermaid(), LIBRARY_LOAD_TIMEOUT_MS);

      const id = `mermaid-${Math.random().toString(36).substring(2, 11)}`;
      const { svg: renderedSvg } = await withTimeout(
        mermaid.render(id, chartText.trim()),
        RENDER_TIMEOUT_MS,
      );
      if (!cancelledRef.current) {
        setSvg(renderedSvg);
        setError(null);
      }
    } catch (err) {
      if (cancelledRef.current) return;

      const message = err instanceof Error ? err.message : "Failed to render diagram";

      // Auto-retry once: the most common failure is a transient dynamic import
      // timeout on slow connections.
      if (attempt < MAX_AUTO_RETRIES) {
        console.warn(`Mermaid rendering failed (attempt ${attempt + 1}), retrying:`, message);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        if (!cancelledRef.current) {
          // Reset mermaid module cache in case the import itself was corrupted
          mermaidModule = null;
          mermaidInitialized = false;
          await renderChart(attempt + 1);
        }
      } else {
        console.warn(`Mermaid rendering failed after ${attempt + 1} attempt(s):`, message);
        setError(message);
      }
    }
  }, [chartText]);

  useEffect(() => {
    cancelledRef.current = false;
    renderChart(0);
    return () => { cancelledRef.current = true; };
  }, [chartText, retryCount, renderChart]);

  const handleRetry = useCallback(() => {
    // Reset module cache so a fresh import is attempted
    mermaidModule = null;
    mermaidInitialized = false;
    setRetryCount((c) => c + 1);
  }, []);

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
  return <MermaidCodeFallback chartText={chartText} error={error} onRetry={error ? handleRetry : undefined} />;
}

export default MermaidDiagram;
