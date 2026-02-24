import type { ReactNode } from "react";
import { Lightbulb } from "lucide-react";
import { getPageById } from "@data";

interface KeyTakeawaysProps {
  children?: ReactNode;
  title?: string;
  pageId?: string;
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
 * Auto-render mode (resolves from frontmatter structuredSummary):
 *   <KeyTakeaways pageId="scheming" />
 *
 * Children always take priority over auto-render.
 */
export function KeyTakeaways({ children, title, pageId }: KeyTakeawaysProps) {
  // Auto-render from structuredSummary when no children provided
  let content: ReactNode = children;
  if (!content && pageId) {
    const page = getPageById(pageId);
    const summary = page?.structuredSummary;
    if (summary?.keyPoints && summary.keyPoints.length > 0) {
      content = (
        <ul>
          {summary.keyPoints.map((point, i) => (
            <li key={i}>{point}</li>
          ))}
        </ul>
      );
    }
  }

  if (!content) return null;

  return (
    <div className="my-6 rounded-lg border border-indigo-500/20 bg-indigo-500/[0.04] px-5 py-4 text-[0.9rem] [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <div className="flex items-center gap-2 mb-3">
        <Lightbulb size={16} className="text-indigo-500 shrink-0" />
        <span className="text-sm font-semibold text-indigo-600 dark:text-indigo-400">
          {title || "Key Takeaways"}
        </span>
      </div>
      <div className="text-foreground/90 [&_ul]:my-0 [&_ul]:pl-4 [&_li]:my-1 [&_li]:leading-snug [&_li::marker]:text-indigo-500/60">
        {content}
      </div>
    </div>
  );
}
