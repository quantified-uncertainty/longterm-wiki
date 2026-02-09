"use client";

import { useEffect, useState } from "react";
import type { TocHeading } from "@/lib/mdx";

export function TableOfContents({ headings }: { headings: TocHeading[] }) {
  const [activeSlug, setActiveSlug] = useState<string>("");

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSlug(entry.target.id);
          }
        }
      },
      { rootMargin: "-80px 0px -80% 0px" }
    );

    for (const heading of headings) {
      const el = document.getElementById(heading.slug);
      if (el) observer.observe(el);
    }

    return () => observer.disconnect();
  }, [headings]);

  if (headings.length < 3) return null;

  return (
    <nav className="hidden xl:block w-56 shrink-0" aria-label="Table of contents">
      <div className="sticky top-20">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          On this page
        </p>
        <ul className="space-y-1 text-sm border-l border-border">
          {headings.map((h) => (
            <li key={h.slug}>
              <a
                href={`#${h.slug}`}
                className={`block no-underline py-0.5 transition-colors ${
                  h.depth === 3 ? "pl-6" : "pl-3"
                } ${
                  activeSlug === h.slug
                    ? "text-foreground border-l-2 border-foreground -ml-px font-medium"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {h.text}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
