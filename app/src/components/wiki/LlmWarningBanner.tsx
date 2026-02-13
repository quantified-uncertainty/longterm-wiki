"use client";

import { useState, useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";

const STORAGE_KEY = "llm-warning-dismissed";

export function LlmWarningBanner() {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== "true") {
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    localStorage.setItem(STORAGE_KEY, "true");
  }

  return (
    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-900 dark:text-amber-200">
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <span className="font-semibold">Warning:</span> This content was
          written by an LLM, with minimal human supervision. It may contain
          hallucinations or other failures.
        </div>
        <button
          onClick={handleDismiss}
          className="shrink-0 rounded p-0.5 hover:bg-amber-500/10 transition-colors"
          aria-label="Dismiss LLM content warning"
        >
          <X className="w-4 h-4 text-amber-500" />
        </button>
      </div>
    </div>
  );
}
