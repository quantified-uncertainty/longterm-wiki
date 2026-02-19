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

interface MermaidProps {
  chart?: string;
  children?: React.ReactNode;
}

export function MermaidDiagram({ chart, children }: MermaidProps) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const chartText = chart || (typeof children === "string" ? children : "");

  useEffect(() => {
    if (!chartText) {
      setLoading(false);
      return;
    }

    let cancelled = false;

    const renderChart = async () => {
      try {
        const mermaid = await getMermaid();
        const id = `mermaid-${Math.random().toString(36).substr(2, 9)}`;
        const { svg: renderedSvg } = await mermaid.render(id, chartText);
        if (!cancelled) {
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Mermaid rendering error:", err);
          setError(err instanceof Error ? err.message : "Failed to render diagram");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    renderChart();
    return () => { cancelled = true; };
  }, [chartText]);

  if (!chartText) return null;

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-800 text-sm my-4">
        <strong>Diagram Error:</strong> {error}
        <pre className="mt-2 text-xs overflow-auto">{chartText}</pre>
      </div>
    );
  }

  if (loading || !svg) {
    return (
      <div className="flex justify-center items-center my-6 p-8 bg-muted rounded-lg min-h-[100px] text-muted-foreground text-sm">
        Loading diagram...
      </div>
    );
  }

  return (
    <div
      className="flex justify-center my-6 p-4 bg-muted/50 rounded-lg overflow-auto"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export default MermaidDiagram;
