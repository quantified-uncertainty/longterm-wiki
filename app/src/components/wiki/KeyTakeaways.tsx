import type { ReactNode } from "react";
import { Lightbulb } from "lucide-react";

interface KeyTakeawaysProps {
  children?: ReactNode;
  title?: string;
}

/**
 * KeyTakeaways — a prominent summary box placed at the top of wiki articles.
 *
 * Usage in MDX:
 *   <KeyTakeaways>
 *   - First key point
 *   - Second key point with **bold** emphasis
 *   - Third point referencing a <EntityLink id="some-entity">specific topic</EntityLink>
 *   </KeyTakeaways>
 *
 * Renders as a visually distinct card with an indigo accent, designed to give
 * skimmers the 3-5 most important things to know about a topic.
 */
export function KeyTakeaways({ children, title }: KeyTakeawaysProps) {
  return (
    <div className="my-6 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.04] px-5 py-4 text-[0.9rem] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb size={16} className="text-indigo-500 shrink-0" />
        <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
          {title || "Key Takeaways"}
        </span>
      </div>
      <div className="text-foreground/90 [&_ul]:my-0 [&_ul]:pl-4 [&_li]:my-1 [&_li]:leading-snug [&_li::marker]:text-indigo-500/60">
        {children}
      </div>
    </div>
  );
}
