"use client";

import { useState, useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, List } from "lucide-react";
import type { TocHeading } from "@/lib/mdx";

interface TableOfContentsProps {
  headings: TocHeading[];
}

/**
 * TableOfContents — auto-generated TOC for long articles (wordCount > 1500).
 *
 * Full-width inline block with 2-column layout on desktop.
 * Collapsible toggle. Highlights the active heading as the user scrolls.
 * Drops h3s when total heading count exceeds 14 to keep it compact.
 */
export function TableOfContents({ headings }: TableOfContentsProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Only show h3s when the total heading count is manageable
  const h2Only = headings.length > 14;
  const visibleHeadings = h2Only
    ? headings.filter((h) => h.depth === 2)
    : headings;

  useEffect(() => {
    // Clean up any previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (intersecting.length > 0) {
          setActiveSlug(intersecting[0].target.id);
        }
      },
      { rootMargin: "0px 0px -75% 0px", threshold: 0 }
    );

    observerRef.current = observer;

    visibleHeadings.forEach(({ slug }) => {
      const el = document.getElementById(slug);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [visibleHeadings]);

  if (visibleHeadings.length === 0) return null;

  return (
    <div className="not-prose w-full mb-6 border border-border rounded-lg bg-muted/40 text-sm">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-5 py-2.5 font-medium text-sm text-foreground/80 hover:text-foreground transition-colors"
        aria-expanded={isOpen}
        aria-controls="toc-content"
      >
        <span className="flex items-center gap-1.5">
          <List size={14} aria-hidden="true" />
          Contents
        </span>
        {isOpen ? (
          <ChevronUp size={14} aria-hidden="true" />
        ) : (
          <ChevronDown size={14} aria-hidden="true" />
        )}
      </button>
      {isOpen && (
        <nav id="toc-content" aria-label="Table of contents">
          <div className="px-5 pb-4 columns-1 md:columns-2 gap-x-8">
            {visibleHeadings.map((heading, i) => {
              const isH2 = heading.depth === 2;
              const prevDepth = i > 0 ? visibleHeadings[i - 1].depth : 2;
              const needsGap = isH2 && i > 0 && prevDepth === 3;
              return (
                <div
                  key={`${heading.slug}-${i}`}
                  className={`break-inside-avoid ${needsGap ? "mt-1.5" : ""}`}
                >
                  <a
                    href={`#${heading.slug}`}
                    className={`block no-underline transition-colors ${
                      isH2
                        ? `py-[3px] text-[13px] leading-snug font-medium ${
                            activeSlug === heading.slug
                              ? "text-foreground"
                              : "text-foreground/80 hover:text-foreground"
                          }`
                        : `py-[2px] pl-4 text-xs leading-snug border-l border-border/60 ${
                            activeSlug === heading.slug
                              ? "text-foreground border-foreground/40"
                              : "text-muted-foreground hover:text-foreground"
                          }`
                    }`}
                  >
                    {heading.text}
                  </a>
                </div>
              );
            })}
          </div>
        </nav>
      )}
    </div>
  );
}
