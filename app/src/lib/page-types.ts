/**
 * Centralized page type detection and metadata
 * Adapted from longterm app's page-types.ts
 */

export type PageType =
  | "content"
  | "risk"
  | "response"
  | "stub"
  | "documentation"
  | "ai-transition-model"
  | "overview";

export interface PageTypeInfo {
  label: string;
  description: string;
  styleGuideUrl?: string;
  color: string;
}

export const PAGE_TYPE_INFO: Record<PageType, PageTypeInfo> = {
  content: {
    label: "Content",
    description: "Standard knowledge base article",
    color: "bg-blue-500/20 text-blue-400 border-blue-500/40",
  },
  risk: {
    label: "Risk",
    description: "Risk analysis page",
    color: "bg-red-500/20 text-red-400 border-red-500/40",
  },
  response: {
    label: "Response",
    description: "Intervention/response page",
    color: "bg-teal-500/20 text-teal-400 border-teal-500/40",
  },
  stub: {
    label: "Stub",
    description: "Minimal placeholder page",
    color: "bg-slate-500/20 text-slate-400 border-slate-500/40",
  },
  documentation: {
    label: "Documentation",
    description: "Internal docs, style guides, examples",
    color: "bg-purple-500/20 text-purple-400 border-purple-500/40",
  },
  "ai-transition-model": {
    label: "AI Transition Model",
    description: "Structured factor/scenario/parameter page",
    color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/40",
  },
  overview: {
    label: "Overview",
    description: "Section navigation page",
    color: "bg-amber-500/20 text-amber-400 border-amber-500/40",
  },
};

export function detectPageType(
  pathname: string,
  frontmatterType?: string
): PageType {
  if (frontmatterType === "stub") return "stub";
  if (frontmatterType === "documentation") return "documentation";

  if (pathname) {
    if (pathname.includes("/ai-transition-model/")) return "ai-transition-model";
    if (pathname.includes("/knowledge-base/risks/")) return "risk";
    if (pathname.includes("/knowledge-base/responses/")) return "response";
  }

  if (
    frontmatterType &&
    Object.keys(PAGE_TYPE_INFO).includes(frontmatterType)
  ) {
    return frontmatterType as PageType;
  }

  return "content";
}
