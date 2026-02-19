import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

type CalloutVariant = "note" | "tip" | "caution" | "warning" | "danger";

interface CalloutProps {
  variant?: CalloutVariant;
  title?: string;
  children?: ReactNode;
}

const variantStyles: Record<
  CalloutVariant,
  { container: string; title: string }
> = {
  note: {
    container: "bg-blue-500/5 border-l-blue-500",
    title: "text-blue-600",
  },
  tip: {
    container: "bg-emerald-500/5 border-l-emerald-500",
    title: "text-emerald-600",
  },
  caution: {
    container: "bg-amber-500/5 border-l-amber-500",
    title: "text-amber-600",
  },
  warning: {
    container: "bg-amber-500/5 border-l-amber-500",
    title: "text-amber-600",
  },
  danger: {
    container: "bg-red-500/5 border-l-red-500",
    title: "text-red-600",
  },
};

const defaultLabels: Record<CalloutVariant, string> = {
  note: "Note",
  tip: "Tip",
  caution: "Caution",
  warning: "Warning",
  danger: "Danger",
};

export function Callout({ variant = "note", title, children }: CalloutProps) {
  const styles = variantStyles[variant] || variantStyles.note;
  const label = title || defaultLabels[variant] || "Note";

  return (
    <div
      className={cn(
        "my-4 rounded-lg border border-border border-l-4 px-4 py-3 text-[0.9rem]",
        "[&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        styles.container
      )}
    >
      <div className={cn("mb-1.5 text-sm font-semibold", styles.title)}>
        {label}
      </div>
      {children}
    </div>
  );
}
