import React from "react";

// URL matcher: http(s) scheme, any non-whitespace/bracket/quote char, minus a
// final punctuation char that's more likely sentence-terminal than URL.
// Used to linkify embedded URLs so raw digits inside them (e.g. web.archive.org
// timestamps) don't leak into innerText. QUA-675.
const URL_RE = /https?:\/\/[^\s<>"')]+[^\s<>"').,;:!?]/g;

export function linkifyText(text: string): React.ReactNode {
  if (!text.includes("http")) return text;
  const parts: React.ReactNode[] = [];
  let lastIdx = 0;
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index ?? 0;
    if (start > lastIdx) parts.push(text.slice(lastIdx, start));
    const url = m[0];
    let domain: string | null = null;
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      /* malformed URL — render full text as fallback */
    }
    parts.push(
      <a
        key={start}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 dark:text-blue-400 hover:underline break-all"
        title={url}
      >
        {domain ?? url}
      </a>,
    );
    lastIdx = start + url.length;
  }
  if (parts.length === 0) return text;
  if (lastIdx < text.length) parts.push(text.slice(lastIdx));
  return parts;
}
