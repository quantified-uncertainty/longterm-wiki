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
 * On desktop: floats right of the prose content (Wikipedia-style).
 * On mobile: renders inline with a collapsible toggle.
 * Highlights the active heading as the user scrolls.
 */
export function TableOfContents({ headings }: TableOfContentsProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    // Clean up any previous observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    const observer = new IntersectionObserver(
      (entries) => {
        // Find the first heading that is intersecting (top-most visible)
        const intersecting = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (intersecting.length > 0) {
          setActiveSlug(intersecting[0].target.id);
        }
      },
      // Trigger when heading enters top 20% of viewport
      { rootMargin: "0px 0px -75% 0px", threshold: 0 }
    );

    observerRef.current = observer;

    headings.forEach(({ slug }) => {
      const el = document.getElementById(slug);
      if (el) observer.observe(el);
    });

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length === 0) return null;

  return (
    <div className="not-prose md:float-right md:clear-right md:ml-6 md:mb-4 md:w-52 w-full mb-6 border border-border rounded-lg bg-muted/40 text-sm shrink-0">
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between w-full px-3 py-2 font-medium text-sm text-foreground/80 hover:text-foreground transition-colors"
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
          <ol className="px-3 pb-3 space-y-0.5 list-none m-0">
            {headings.map((heading, i) => (
              <li
                key={`${heading.slug}-${i}`}
                className={`m-0 ${heading.depth === 3 ? "pl-3" : ""}`}
              >
                <a
                  href={`#${heading.slug}`}
                  className={`block py-0.5 text-xs leading-snug no-underline transition-colors ${
                    activeSlug === heading.slug
                      ? "text-foreground font-medium"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}
    </div>
  );
}
