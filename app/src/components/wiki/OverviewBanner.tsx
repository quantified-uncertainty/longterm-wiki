import React from "react";
import { LayoutList } from "lucide-react";

interface OverviewBannerProps {
  /** The topic this overview covers, e.g. "structural risks" or "frontier AI labs" */
  topic?: string;
  children?: React.ReactNode;
}

/**
 * A banner displayed at the top of overview pages to clearly signal their
 * navigational/index purpose, distinguishing them from regular wiki articles.
 */
export function OverviewBanner({ topic, children }: OverviewBannerProps) {
  return (
    <div className="not-prose flex items-start gap-3 px-4 py-3 mb-6 rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800/50 dark:bg-blue-950/20">
      <LayoutList
        size={18}
        className="mt-0.5 flex-shrink-0 text-blue-500 dark:text-blue-400"
      />
      <div className="text-sm text-blue-900 dark:text-blue-200">
        {children || (
          <span>
            This is an <strong>overview page</strong> that provides a navigational guide to{" "}
            {topic ? <strong>{topic}</strong> : "this section"}.
            See individual pages for detailed coverage.
          </span>
        )}
      </div>
    </div>
  );
}
