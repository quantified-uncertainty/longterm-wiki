"use client";

import { useState, useEffect } from "react";
import {
  AlertTriangle,
  ShieldAlert,
  ShieldCheck,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";

type RiskLevel = "low" | "medium" | "high";

interface HallucinationRisk {
  level: RiskLevel;
  score: number;
  factors: string[];
}

interface ContentConfidenceBannerProps {
  hallucinationRisk?: HallucinationRisk;
  /** Optional balance flags from grading pipeline */
  balanceFlags?: string[];
}

/** Human-readable descriptions for machine-readable factor IDs */
const FACTOR_DESCRIPTIONS: Record<string, string> = {
  "biographical-claims":
    "Contains biographical claims about real people or organizations that may be inaccurate",
  "specific-factual-claims":
    "Contains specific dates, events, or historical details that are prone to hallucination",
  "no-citations": "No citations — claims cannot be verified against sources",
  "low-citation-density":
    "Few citations relative to the number of claims made",
  "low-rigor-score": "Rated low on sourcing rigor by automated grading",
  "low-quality-score": "Below-average overall quality score",
  "few-external-sources": "Few links to external sources for verification",
  "well-cited": "Good citation density — claims are traceable to sources",
  "moderately-cited": "Moderate citation coverage",
  "high-rigor": "Rated high on sourcing rigor by automated grading",
  "conceptual-content":
    "Covers concepts and frameworks rather than specific factual claims",
  "structured-format":
    "Structured format (table/diagram) with less room for prose hallucination",
  "minimal-content": "Short page with limited scope for errors",
  "high-quality": "High overall quality score from automated grading",
};

/** Human-readable descriptions for balance flags from grading pipeline */
const BALANCE_FLAG_DESCRIPTIONS: Record<string, string> = {
  "no-criticism-section": "Missing criticism or limitations section",
  "single-source-dominance":
    "Over 50% of citations come from a single source",
  "missing-source-incentives":
    "Controversial claims lack context about source incentives",
  "one-sided-framing": "Presents only one side of the topic",
  "uncritical-claims": "Major claims made without attribution",
  "unsourced-biographical-details":
    "Biographical details cited without sources",
  "missing-primary-sources": "No official or primary sources referenced",
  "unverified-quotes": "Contains quotes not verified against original source",
  "speculative-motivations":
    "Attributes motivations to people without supporting quotes",
};

const RISK_CONFIG: Record<
  RiskLevel,
  {
    icon: typeof AlertTriangle;
    borderColor: string;
    bgColor: string;
    textColor: string;
    iconColor: string;
    label: string;
    message: string;
    dismissable: boolean;
  }
> = {
  high: {
    icon: ShieldAlert,
    borderColor: "border-red-500/30",
    bgColor: "bg-red-500/5",
    textColor: "text-red-900 dark:text-red-200",
    iconColor: "text-red-500",
    label: "High hallucination risk",
    message:
      "This AI-generated page has significant hallucination risk. Verify claims independently before relying on this content.",
    dismissable: false,
  },
  medium: {
    icon: AlertTriangle,
    borderColor: "border-amber-500/30",
    bgColor: "bg-amber-500/5",
    textColor: "text-amber-900 dark:text-amber-200",
    iconColor: "text-amber-500",
    label: "Moderate confidence",
    message:
      "This AI-generated content has moderate hallucination risk. Key claims should be verified against cited sources.",
    dismissable: true,
  },
  low: {
    icon: ShieldCheck,
    borderColor: "border-blue-500/20",
    bgColor: "bg-blue-500/5",
    textColor: "text-blue-900 dark:text-blue-200",
    iconColor: "text-blue-500",
    label: "Lower hallucination risk",
    message: "This AI-generated content is well-cited, reducing (but not eliminating) hallucination risk.",
    dismissable: true,
  },
};

/**
 * Per-page confidence banner that replaces the old binary LlmWarningBanner.
 *
 * Shows tiered warnings based on computed hallucination risk. The risk data
 * is also available in pages.json for AI agents to use for verification triage.
 *
 * Machine-readable data is embedded as data-* attributes for automated consumers.
 */
export function ContentConfidenceBanner({
  hallucinationRisk,
  balanceFlags,
}: ContentConfidenceBannerProps) {
  const [dismissed, setDismissed] = useState(true); // default hidden to avoid flash
  const [expanded, setExpanded] = useState(false);

  // Fall back to medium risk if no data (all content is AI-generated)
  const risk: HallucinationRisk = hallucinationRisk || {
    level: "medium",
    score: 40,
    factors: [],
  };
  const config = RISK_CONFIG[risk.level];
  const Icon = config.icon;

  // Storage key is per-risk-level so dismissing a "low" banner doesn't hide "high" ones
  const storageKey = `content-confidence-dismissed-${risk.level}`;

  useEffect(() => {
    if (!config.dismissable) {
      setDismissed(false);
      return;
    }
    const stored = localStorage.getItem(storageKey);
    if (stored !== "true") {
      setDismissed(false);
    }
  }, [storageKey, config.dismissable]);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    localStorage.setItem(storageKey, "true");
  }

  // Separate factors into warnings (risk-increasing) and positives (risk-decreasing)
  const POSITIVE_FACTORS = new Set([
    "well-cited",
    "moderately-cited",
    "high-rigor",
    "conceptual-content",
    "structured-format",
    "minimal-content",
    "high-quality",
  ]);
  const warnings = risk.factors.filter((f) => !POSITIVE_FACTORS.has(f));
  const positives = risk.factors.filter((f) => POSITIVE_FACTORS.has(f));

  // Combine balance flags with warning factors for display
  const allWarnings = [
    ...warnings,
    ...(balanceFlags || []),
  ];

  const hasDetails = allWarnings.length > 0 || positives.length > 0;

  return (
    <div
      className={`my-6 rounded-lg border ${config.borderColor} ${config.bgColor} px-4 py-3 text-sm ${config.textColor}`}
      data-hallucination-risk={risk.level}
      data-hallucination-score={risk.score}
      data-hallucination-factors={risk.factors.join(",")}
    >
      <div className="flex items-start gap-3">
        <Icon className={`w-5 h-5 ${config.iconColor} shrink-0 mt-0.5`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold">{config.label}</span>
            <span className="text-xs opacity-60">(score: {risk.score}/100)</span>
          </div>
          <p className="mt-0.5">{config.message}</p>

          {/* Expandable details */}
          {hasDetails && (
            <>
              <button
                onClick={() => setExpanded(!expanded)}
                className="mt-1.5 inline-flex items-center gap-1 text-xs font-medium opacity-70 hover:opacity-100 transition-opacity"
              >
                {expanded ? (
                  <>
                    Hide details <ChevronUp className="w-3 h-3" />
                  </>
                ) : (
                  <>
                    Why this rating? <ChevronDown className="w-3 h-3" />
                  </>
                )}
              </button>

              {expanded && (
                <div className="mt-2 space-y-2 text-xs">
                  {allWarnings.length > 0 && (
                    <div>
                      <span className="font-medium">Risk factors:</span>
                      <ul className="mt-1 list-disc list-inside space-y-0.5 opacity-80">
                        {allWarnings.map((factor) => (
                          <li key={factor}>
                            {FACTOR_DESCRIPTIONS[factor] ||
                              BALANCE_FLAG_DESCRIPTIONS[factor] ||
                              factor}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {positives.length > 0 && (
                    <div>
                      <span className="font-medium">Mitigating factors:</span>
                      <ul className="mt-1 list-disc list-inside space-y-0.5 opacity-80">
                        {positives.map((factor) => (
                          <li key={factor}>
                            {FACTOR_DESCRIPTIONS[factor] || factor}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Dismiss button (only for dismissable risk levels) */}
        {config.dismissable && (
          <button
            onClick={handleDismiss}
            className="shrink-0 rounded p-0.5 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
            aria-label="Dismiss content confidence banner"
          >
            <X className={`w-4 h-4 ${config.iconColor}`} />
          </button>
        )}
      </div>
    </div>
  );
}
