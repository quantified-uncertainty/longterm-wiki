import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  HelpCircle,
} from "lucide-react";

/**
 * Shared claim verdict configuration.
 *
 * Used by verdict-badge.tsx and entity-claims-list.tsx for rendering
 * claim-level verdicts. Citation accuracy verdicts (accurate, minor_issues,
 * inaccurate) are a different domain and remain defined locally in their
 * respective components (CollapsibleClaims, InlineCitationCards, CitationOverlay).
 */
export const CLAIM_VERDICT_CONFIG: Record<
  string,
  {
    icon: typeof CheckCircle2;
    label: string;
    color: string;
    bg: string;
  }
> = {
  verified: {
    icon: CheckCircle2,
    label: "Verified",
    color: "text-emerald-700 dark:text-emerald-400",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
  disputed: {
    icon: AlertTriangle,
    label: "Disputed",
    color: "text-amber-700 dark:text-amber-400",
    bg: "bg-amber-50 dark:bg-amber-950/30",
  },
  unsupported: {
    icon: XCircle,
    label: "Unsupported",
    color: "text-red-700 dark:text-red-400",
    bg: "bg-red-50 dark:bg-red-950/30",
  },
  not_verifiable: {
    icon: HelpCircle,
    label: "Not verifiable",
    color: "text-muted-foreground",
    bg: "bg-muted/30",
  },
};
