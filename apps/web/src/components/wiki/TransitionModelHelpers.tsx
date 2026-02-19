"use client";

/**
 * Shared helper components for TransitionModelTableClient.
 *
 * Extracted from TransitionModelTableClient.tsx to reduce file size
 * and improve reusability.
 */

import type { SubItemRow } from "./TransitionModelTableClient";

// ============================================================================
// TEXT UTILITIES
// ============================================================================

/** Truncate description for preview, stripping markdown syntax. */
export function truncateText(text: string, maxLength: number = 150): string {
  if (!text) return "";
  const cleaned = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_`#]/g, "")
    .replace(/\n+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.slice(0, maxLength).trim() + "...";
}

// ============================================================================
// HELPER COMPONENTS
// ============================================================================

/** Parameter link — clickable with tier-based color and optional high-priority indicator. */
export function ParamLink({
  children,
  href,
  tier,
  isHighPriority,
}: {
  children: React.ReactNode;
  href?: string;
  tier: "cause" | "intermediate" | "effect";
  isHighPriority?: boolean;
}) {
  const colors: Record<string, string> = {
    cause: "#1e40af",
    intermediate: "#6d28d9",
    effect: "#92400e",
  };

  const content = (
    <span
      className="flex items-center gap-1.5 text-[13px] font-semibold"
      style={{ color: colors[tier] }}
    >
      {isHighPriority && (
        <span
          className="inline-block w-2 h-2 rounded-full shrink-0"
          style={{ background: "#ef4444" }}
          title="High X-risk impact (>70)"
        />
      )}
      {children}
    </span>
  );

  if (href) {
    return (
      <a
        href={href}
        className="block no-underline hover:underline"
      >
        {content}
      </a>
    );
  }
  return content;
}

/** Rating cell with color-coded bar. */
export function RatingCell({
  value,
  colorType,
}: {
  value?: number;
  colorType: "green" | "red" | "blue" | "gray";
}) {
  if (value === undefined)
    return <span className="text-gray-400">&mdash;</span>;

  const colorConfigs = {
    green: { bar: "#22c55e", bg: "#dcfce7", text: "#166534" },
    red: { bar: "#ef4444", bg: "#fee2e2", text: "#991b1b" },
    blue: { bar: "#3b82f6", bg: "#dbeafe", text: "#1e40af" },
    gray: { bar: "#6b7280", bg: "#f3f4f6", text: "#374151" },
  };
  const c = colorConfigs[colorType];

  return (
    <div className="flex items-center gap-2 min-w-[80px]">
      <div
        className="flex-1 h-1.5 rounded-full overflow-hidden"
        style={{ background: c.bg }}
      >
        <div
          className="h-full rounded-full"
          style={{ width: `${value}%`, background: c.bar }}
        />
      </div>
      <span
        className="text-xs font-medium min-w-[24px]"
        style={{ color: c.text }}
      >
        {value}
      </span>
    </div>
  );
}

/** Combined parent badge with category prefix (AI/Society). */
export function CombinedParentBadge({
  parent,
  category,
}: {
  parent: string;
  category?: "ai" | "society";
}) {
  const config = {
    ai: {
      prefix: "AI",
      bg: "#eff6ff",
      color: "#1d4ed8",
      border: "#bfdbfe",
      prefixBg: "#dbeafe",
    },
    society: {
      prefix: "Society",
      bg: "#ecfdf5",
      color: "#047857",
      border: "#a7f3d0",
      prefixBg: "#d1fae5",
    },
  };
  const c = config[category || "ai"];
  return (
    <span
      className="inline-flex items-center rounded text-xs font-medium overflow-hidden"
      style={{ border: `1px solid ${c.border}` }}
    >
      <span
        className="px-1.5 py-0.5 text-[11px] font-semibold"
        style={{ background: c.prefixBg, color: c.color }}
      >
        {c.prefix}
      </span>
      <span
        className="px-2 py-0.5"
        style={{ background: c.bg, color: c.color }}
      >
        {parent}
      </span>
    </span>
  );
}

/** Expandable row content showing truncated description. */
export function ExpandableRow({ row }: { row: SubItemRow }) {
  if (!row.description) return null;

  return (
    <div className="px-4 py-3 bg-slate-50 border-t border-slate-200 text-[13px] leading-relaxed text-slate-600">
      <div className="max-w-[800px]">
        {truncateText(row.description, 400)}
        {row.href && (
          <a
            href={row.href}
            className="ml-2 text-blue-500 no-underline font-medium hover:underline"
          >
            Read more &rarr;
          </a>
        )}
      </div>
    </div>
  );
}

/** Expand/collapse button for row descriptions. */
export function ExpandButton({
  isExpanded,
  onClick,
  hasDescription,
}: {
  isExpanded: boolean;
  onClick: () => void;
  hasDescription: boolean;
}) {
  if (!hasDescription) return <span className="inline-block w-6" />;

  return (
    <button
      onClick={onClick}
      className="w-6 h-6 rounded border border-slate-200 flex items-center justify-center text-sm text-slate-500 cursor-pointer transition-all duration-150"
      style={{
        background: isExpanded ? "#eff6ff" : "white",
      }}
      title={isExpanded ? "Collapse" : "Expand description"}
    >
      {isExpanded ? "\u2212" : "+"}
    </button>
  );
}

/** View action link for navigating to a parameter's page. */
export function ViewActionLink({
  href,
  hoverColor,
}: {
  href?: string;
  hoverColor: string;
}) {
  if (!href) return null;
  return (
    <a
      href={href}
      className="text-slate-500 no-underline text-xs px-2 py-1 rounded border border-slate-200 bg-white inline-block hover:bg-slate-100 transition-colors"
      onMouseOver={(e) => {
        e.currentTarget.style.color = hoverColor;
      }}
      onMouseOut={(e) => {
        e.currentTarget.style.color = "";
      }}
    >
      View &rarr;
    </a>
  );
}
