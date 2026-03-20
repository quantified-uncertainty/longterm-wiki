"use client";

import * as HoverCard from "@radix-ui/react-hover-card";
import {
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  ShieldX,
  FileText,
  Newspaper,
  MessageSquare,
  Megaphone,
  Lightbulb,
  ExternalLink,
} from "lucide-react";
import type {
  StakeholderVerificationType,
  StakeholderEvidenceType,
} from "@/data/entity-schemas";

// ── Verification status configuration ──────────────────────────

interface StatusConfig {
  icon: typeof ShieldCheck;
  label: string;
  color: string;
  iconColor: string;
  bgColor: string;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  verified: {
    icon: ShieldCheck,
    label: "Verified",
    color: "text-emerald-700 dark:text-emerald-400",
    iconColor: "text-emerald-600 dark:text-emerald-400",
    bgColor: "bg-emerald-500/10",
  },
  "partially-verified": {
    icon: ShieldAlert,
    label: "Partially Verified",
    color: "text-amber-700 dark:text-amber-400",
    iconColor: "text-amber-500 dark:text-amber-400",
    bgColor: "bg-amber-500/10",
  },
  unverified: {
    icon: ShieldQuestion,
    label: "Unverified",
    color: "text-muted-foreground",
    iconColor: "text-muted-foreground",
    bgColor: "bg-muted/50",
  },
  disputed: {
    icon: ShieldX,
    label: "Disputed",
    color: "text-red-700 dark:text-red-400",
    iconColor: "text-red-500 dark:text-red-400",
    bgColor: "bg-red-500/10",
  },
};

// ── Evidence type icons ──────────────────────────────────────

const EVIDENCE_TYPE_CONFIG: Record<
  string,
  { icon: typeof FileText; label: string }
> = {
  "primary-source": { icon: FileText, label: "Primary Source" },
  "news-report": { icon: Newspaper, label: "News Report" },
  "social-media": { icon: MessageSquare, label: "Social Media" },
  "official-statement": { icon: Megaphone, label: "Official Statement" },
  inference: { icon: Lightbulb, label: "Inference" },
};

// ── Date formatting ──────────────────────────────────────────

function formatDate(dateStr: string): string {
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return dateStr;
  }
}

// ── Evidence item ──────────────────────────────────────────

function EvidenceItem({ evidence }: { evidence: StakeholderEvidenceType }) {
  const config = EVIDENCE_TYPE_CONFIG[evidence.type] ?? {
    icon: FileText,
    label: evidence.type,
  };
  const Icon = config.icon;

  return (
    <div className="flex gap-2 py-1.5 first:pt-0 last:pb-0">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold">
            {config.label}
          </span>
          {evidence.date && (
            <span className="text-[10px] text-muted-foreground">
              {formatDate(evidence.date)}
            </span>
          )}
        </div>
        <p className="text-xs text-foreground/80 leading-snug mt-0.5">
          {evidence.description}
        </p>
        {evidence.url && (
          <a
            href={evidence.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline mt-1"
          >
            <ExternalLink className="w-3 h-3" />
            View source
          </a>
        )}
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────

interface StakeholderVerificationBadgeProps {
  verification: StakeholderVerificationType | undefined;
  stakeholderName: string;
}

export function StakeholderVerificationBadge({
  verification,
  stakeholderName,
}: StakeholderVerificationBadgeProps) {
  // When there is no verification data at all, don't render anything
  if (!verification?.status) {
    return null;
  }

  const config = STATUS_CONFIG[verification.status];
  if (!config) return null;

  const Icon = config.icon;
  const hasDetails =
    (verification.evidence && verification.evidence.length > 0) ||
    verification.notes ||
    verification.verifiedDate;

  // If there are no details to show in a hover card, render a static icon
  if (!hasDetails) {
    return (
      <span
        className="inline-flex items-center"
        title={`${config.label} position`}
      >
        <Icon className={`w-3.5 h-3.5 ${config.iconColor}`} />
      </span>
    );
  }

  return (
    <HoverCard.Root openDelay={200} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <button
          type="button"
          className={`inline-flex items-center rounded-full p-0.5 ${config.bgColor} cursor-pointer transition-opacity hover:opacity-80`}
          aria-label={`Verification status for ${stakeholderName}: ${config.label}`}
        >
          <Icon className={`w-3.5 h-3.5 ${config.iconColor}`} />
        </button>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="z-50 w-80 rounded-lg border border-border bg-popover p-4 shadow-lg animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
          side="bottom"
          align="start"
          sideOffset={6}
        >
          {/* Header */}
          <div className="flex items-center gap-2 mb-2">
            <Icon className={`w-4 h-4 ${config.iconColor} shrink-0`} />
            <span className={`text-sm font-semibold ${config.color}`}>
              {config.label}
            </span>
            {verification.verifiedDate && (
              <span className="text-xs text-muted-foreground ml-auto">
                {formatDate(verification.verifiedDate)}
              </span>
            )}
          </div>

          {/* Stakeholder name */}
          <p className="text-xs font-medium text-foreground mb-2">
            {stakeholderName}
          </p>

          {/* Notes */}
          {verification.notes && (
            <p className="text-xs text-muted-foreground leading-relaxed mb-3">
              {verification.notes}
            </p>
          )}

          {/* Evidence chain */}
          {verification.evidence && verification.evidence.length > 0 && (
            <div className="border-t border-border pt-2">
              <h4 className="text-[10px] uppercase tracking-wider text-muted-foreground/70 font-semibold mb-2">
                Evidence
              </h4>
              <div className="space-y-2 divide-y divide-border/50">
                {verification.evidence.map((ev, idx) => (
                  <EvidenceItem key={idx} evidence={ev} />
                ))}
              </div>
            </div>
          )}

          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}
