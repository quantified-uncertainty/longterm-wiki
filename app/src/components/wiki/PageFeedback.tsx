"use client";

import { useState, useRef, useEffect } from "react";
import {
  MessageSquare,
  AlertCircle,
  Lightbulb,
  Monitor,
  ChevronDown,
} from "lucide-react";

const REPO = "quantified-uncertainty/longterm-wiki";

type FeedbackOption = {
  template: string;
  label: string;
  icon: React.ReactNode;
  prefill: (pageTitle: string, pageSlug: string) => Record<string, string>;
};

const feedbackOptions: FeedbackOption[] = [
  {
    template: "content-error.yml",
    label: "Report an error",
    icon: <AlertCircle size={14} />,
    prefill: (pageTitle, pageSlug) => ({
      title: `[Error] ${pageTitle}`,
      page: `/wiki/${pageSlug}`,
    }),
  },
  {
    template: "content-suggestion.yml",
    label: "Suggest an addition",
    icon: <Lightbulb size={14} />,
    prefill: (pageTitle, pageSlug) => ({
      title: `[Suggestion] ${pageTitle}`,
      page: `/wiki/${pageSlug}`,
    }),
  },
  {
    template: "ui-bug.yml",
    label: "Report a UI bug",
    icon: <Monitor size={14} />,
    prefill: (_pageTitle, pageSlug) => ({
      page: `/wiki/${pageSlug}`,
    }),
  },
];

function buildIssueUrl(option: FeedbackOption, pageTitle: string, pageSlug: string) {
  const fields = option.prefill(pageTitle, pageSlug);
  const params = new URLSearchParams();
  params.set("template", option.template);
  if (fields.title) {
    params.set("title", fields.title);
  }
  // Pre-fill form fields via query params (GitHub issue forms support field IDs as params)
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "title") {
      params.set(key, value);
    }
  }
  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

export function PageFeedback({
  pageTitle,
  pageSlug,
}: {
  pageTitle: string;
  pageSlug: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="page-meta-github cursor-pointer inline-flex items-center gap-1"
      >
        <MessageSquare size={14} />
        Feedback
        <ChevronDown size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 min-w-[200px] rounded-md border border-border bg-popover p-1 shadow-md">
          {feedbackOptions.map((option) => (
            <a
              key={option.template}
              href={buildIssueUrl(option, pageTitle, pageSlug)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-sm px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground no-underline transition-colors"
              onClick={() => setOpen(false)}
            >
              {option.icon}
              {option.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
